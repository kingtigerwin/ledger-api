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
});
