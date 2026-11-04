import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { LedgerStack } from "../../lib/ledger-stack";

describe("LedgerStack", () => {
  let template: Template;

  beforeAll(() => {
    template = Template.fromStack(new LedgerStack(new App(), "LedgerApi", { env: { region: "ap-southeast-2" } }));
  });

  it("has an on-demand Users table keyed by pk and sk", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  it("routes register and login to the auth function", () => {
    for (const routeKey of ["POST /api/v1/auth/register", "POST /api/v1/auth/login"]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: routeKey });
    }
  });

  it("gives the auth function enough memory for scrypt", () => {
    const fns = template.findResources("AWS::Lambda::Function", {
      Properties: { Environment: { Variables: { USERS_TABLE: Match.anyValue() } } },
    });
    const [auth] = Object.values(fns);
    expect(auth?.Properties.MemorySize).toBeGreaterThanOrEqual(512);
    expect(auth?.Properties.Architectures).toEqual(["arm64"]);
  });

  it("throttles the API, and the auth routes more tightly", () => {
    const tight = { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 };
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
      RouteSettings: {
        "POST /api/v1/auth/register": tight,
        "POST /api/v1/auth/login": tight,
        "POST /api/v1/auth/refresh": tight,
        "POST /api/v1/auth/logout": tight,
      },
    });
  });

  it("lets DynamoDB delete expired refresh tokens", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("has a Lambda authorizer that reads the bearer token and caches for 60 seconds", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "REQUEST",
      AuthorizerPayloadFormatVersion: "2.0",
      EnableSimpleResponses: true,
      IdentitySource: ["$request.header.Authorization"],
      AuthorizerResultTtlInSeconds: 60,
    });
  });

  it("puts the admin routes behind the authorizer", () => {
    for (const routeKey of [
      "GET /api/v1/admin/users",
      "POST /api/v1/admin/users/{id}/enable",
      "POST /api/v1/admin/users/{id}/disable",
    ]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: routeKey, AuthorizationType: "CUSTOM" });
    }
  });

  it("runs the bootstrap on deploy, allowed to create both SSM parameters", () => {
    template.resourceCountIs("AWS::CloudFormation::CustomResource", 1);
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    const put = statements.find((s) => [s.Action].flat().includes("ssm:PutParameter"));
    expect(JSON.stringify(put?.Resource)).toContain("ledger-api/jwt-signing-secret");
    expect(JSON.stringify(put?.Resource)).toContain("ledger-api/admin-password");
  });

  it("has a Data table with a by-category index and an all-customers index", () => {
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      BillingMode: "PAY_PER_REQUEST",
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: "byCategory",
          KeySchema: [
            { AttributeName: "gsi2pk", KeyType: "HASH" },
            { AttributeName: "gsi2sk", KeyType: "RANGE" },
          ],
        }),
        Match.objectLike({
          IndexName: "allByDate",
          KeySchema: [
            { AttributeName: "gsi3pk", KeyType: "HASH" },
            { AttributeName: "gsi3sk", KeyType: "RANGE" },
          ],
        }),
      ],
    });
  });

  it("has no member routes", () => {
    const routeKeys = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map((r) => r.Properties.RouteKey);

    expect(routeKeys.filter((key: string) => key.includes("/members"))).toEqual([]);
  });

  it("puts the transaction routes and the admin's transaction view behind the authorizer", () => {
    for (const routeKey of [
      "POST /api/v1/transactions",
      "GET /api/v1/transactions",
      "GET /api/v1/transactions/summary",
      "GET /api/v1/transactions/{id}",
      "PATCH /api/v1/transactions/{id}",
      "DELETE /api/v1/transactions/{id}",
      "GET /api/v1/admin/users/{id}/transactions",
      "GET /api/v1/admin/transactions",
      "PATCH /api/v1/admin/users/{id}/transactions/{transactionId}",
      "DELETE /api/v1/admin/users/{id}/transactions/{transactionId}",
    ]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: routeKey, AuthorizationType: "CUSTOM" });
    }
  });

  it("serves MCP behind the authorizer, from a function that can use the Data table", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /api/mcp", AuthorizationType: "CUSTOM" });
    const [mcpFunction] = Object.entries(template.findResources("AWS::Lambda::Function")).filter(([id]) =>
      id.startsWith("McpFunction"),
    );
    expect(mcpFunction?.[1].Properties.Environment.Variables).toHaveProperty("DATA_TABLE");
    // It signs list cursors with a key derived from the signing secret, like the Data function.
    const mcpPolicy = Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.startsWith("McpFunctionServiceRoleDefaultPolicy"),
    );
    expect(JSON.stringify(mcpPolicy?.[1].Properties.PolicyDocument)).toContain("ssm:GetParameter");
  });

  it("lets the MCP function read usernames from the Users table, but not write to it", () => {
    const [mcpFunction] = Object.entries(template.findResources("AWS::Lambda::Function")).filter(([id]) =>
      id.startsWith("McpFunction"),
    );
    expect(mcpFunction?.[1].Properties.Environment.Variables).toHaveProperty("USERS_TABLE");
    const [, mcpPolicy] = Object.entries(template.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.startsWith("McpFunctionServiceRoleDefaultPolicy"),
    )!;
    const usersStatements = mcpPolicy.Properties.PolicyDocument.Statement.filter((s: { Resource: unknown }) =>
      JSON.stringify(s.Resource).includes("UsersTable"),
    );
    const actions = usersStatements.flatMap((s: { Action: string | string[] }) => [s.Action].flat());
    expect(actions).toContain("dynamodb:BatchGetItem");
    expect(actions.filter((a: string) => /Put|Update|Delete|Write/.test(a))).toEqual([]);
  });

  it("protects /auth/me and leaves the sign-in routes public", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /api/v1/auth/me",
      AuthorizationType: "CUSTOM",
    });
    for (const route of ["register", "login", "refresh", "logout"]) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: `POST /api/v1/auth/${route}`,
        AuthorizationType: "NONE",
      });
    }
  });

  it("serves /api/* through CloudFront with caching off and auth headers and cookies forwarded", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: "/api/*",
            ViewerProtocolPolicy: "redirect-to-https",
            // AWS managed policies: CachingDisabled and AllViewerExceptHostHeader.
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
            OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
            AllowedMethods: Match.arrayWith(["GET", "PATCH", "POST", "DELETE"]), // arrayWith matches in order
          }),
        ],
      }),
    });
  });

  it("has four free-tier alarms that notify an SNS topic", () => {
    const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm"));

    expect(alarms).toHaveLength(4);
    for (const alarm of alarms) expect(alarm.Properties.AlarmActions).toHaveLength(1);
    template.hasResourceProperties("AWS::Logs::MetricFilter", { FilterPattern: '{ $.event = "login_failed" }' });
  });

  it("subscribes no email when alarmEmail isn't set", () => {
    template.resourceCountIs("AWS::SNS::Subscription", 0);
  });

  it("subscribes the alarmEmail context value", () => {
    const app = new App({ context: { alarmEmail: "me@example.com" } });
    const withEmail = Template.fromStack(new LedgerStack(app, "LedgerApi", { env: { region: "ap-southeast-2" } }));

    withEmail.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "me@example.com" });
  });
});
