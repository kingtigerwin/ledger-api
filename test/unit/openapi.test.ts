import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { LedgerStack } from "../../lib/ledger-stack";

describe("the OpenAPI spec", () => {
  let routeKeys: string[];
  let spec: { paths: Record<string, Record<string, unknown>> };

  beforeAll(() => {
    const template = Template.fromStack(new LedgerStack(new App(), "LedgerApi", { env: { region: "ap-southeast-2" } }));
    routeKeys = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map((r) => r.Properties.RouteKey);
    // The docs Lambda builds the spec in Python, from the schemas the Lambdas validate with.
    const printed = execFileSync("uv", ["run", "python", "-m", "ledger_api.docs.openapi"], {
      cwd: path.join(__dirname, "..", ".."),
    });
    spec = JSON.parse(printed.toString());
  }, 60_000);

  it("documents exactly the routes the stack deploys", () => {
    const documented = Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`),
    );

    expect(documented.sort()).toEqual([...routeKeys].sort());
  });
});
