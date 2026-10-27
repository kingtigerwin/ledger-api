import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CATEGORIES } from "../../src/data/transaction-schema";
import { buildOpenApi } from "../../src/openapi";
import { LedgerStack } from "../../lib/ledger-stack";

describe("the OpenAPI spec", () => {
  let routeKeys: string[];
  const spec = buildOpenApi();

  beforeAll(() => {
    const template = Template.fromStack(new LedgerStack(new App(), "LedgerApi", { env: { region: "ap-southeast-2" } }));
    routeKeys = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map((r) => r.Properties.RouteKey);
  });

  it("documents exactly the routes the stack deploys", () => {
    const documented = Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.keys(ops as object).map((method) => `${method.toUpperCase()} ${path}`),
    );

    expect(documented.sort()).toEqual([...routeKeys].sort());
  });

  it("takes request schemas from the Zod validators", () => {
    const body = spec.paths["/api/v1/transactions"]!.post.requestBody.content["application/json"].schema;

    expect(body.properties.category.enum).toEqual([...CATEGORIES]);
    expect(body.required).toEqual(expect.arrayContaining(["id", "amountCents", "currency"]));
    expect(body.properties).not.toHaveProperty("memberId");
  });

  it("marks protected routes as needing a bearer token, and sign-in routes as public", () => {
    expect(spec.paths["/api/v1/transactions"]!.get.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.paths["/api/v1/auth/login"]!.post.security).toEqual([]);
  });
});
