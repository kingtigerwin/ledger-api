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
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
      RouteSettings: {
        "POST /api/v1/auth/register": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
        "POST /api/v1/auth/login": { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 },
      },
    });
  });
});
