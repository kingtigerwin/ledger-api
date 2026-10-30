import { readdirSync } from "node:fs";
import * as path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { beforeAll, describe, expect, it } from "vitest";
import { LedgerStack } from "../../lib/ledger-stack";

const env = { account: "111111111111", region: "ap-southeast-2" };
const domain = { domainName: "api.example.cloud", zoneName: "example.cloud", hostedZoneId: "ZEXAMPLE123" };

type Resources = Record<string, { Type: string; Properties: Record<string, unknown>; Metadata?: Record<string, string> }>;

describe("given the Python functions' code", () => {
  let files: Map<string, string[]>;

  beforeAll(() => {
    const app = new App({
      // The CLI turns this on; it records where each function's code was staged.
      context: { "aws:cdk:enable-asset-metadata": true },
      // Unit tests skip bundling (vitest.config.mts); this one is about the bundle, so it runs it.
      postCliContext: { "aws:cdk:bundling-stacks": ["**"] },
    });
    const certificate = Certificate.fromCertificateArn(new Stack(app, "Scratch", { env }), "Cert", "arn:aws:acm:us-east-1:111111111111:certificate/abc");
    new LedgerStack(app, "LedgerApi", { env, customDomain: { ...domain, certificate }, emailFrom: "noreply@example.cloud" });
    const assembly = app.synth();
    const resources = (assembly.getStackByName("LedgerApi").template as { Resources: Resources }).Resources;
    files = new Map(
      Object.entries(resources)
        .filter(([, r]) => r.Type === "AWS::Lambda::Function" && String(r.Properties.Runtime).startsWith("python"))
        .map(([id, r]) => {
          const asset = path.join(assembly.directory, r.Metadata!["aws:asset:path"]!);
          const listed = readdirSync(asset, { recursive: true, withFileTypes: true })
            .filter((f) => f.isFile())
            .map((f) => path.relative(asset, path.join(f.parentPath, f.name)));
          return [id, listed];
        }),
    );
  }, 120_000);

  it("is built for Notify, Admin, Data and Mcp", () => {
    expect([...files.keys()].map((id) => id.replace(/Function.*/, "")).sort()).toEqual(["Admin", "Data", "Mcp", "Notify"]);
  });

  it("holds the ledger_api package as Python source only, without the TypeScript beside it or compiled caches", () => {
    for (const listed of files.values()) {
      const own = listed.filter((f) => f.startsWith(`ledger_api${path.sep}`));
      expect(own).toContain(path.join("ledger_api", "data", "lambda_function.py"));
      expect(own.every((f) => f.endsWith(".py"))).toBe(true);
      expect(listed.some((f) => f.endsWith(".ts") || f.includes("__pycache__"))).toBe(false);
    }
  });

  it("vendors pydantic and the MCP SDK for arm64 Linux, and leaves out boto3, which the runtime provides", () => {
    for (const listed of files.values()) {
      const top = new Set(listed.map((f) => f.split(path.sep)[0]));
      expect(top.has("pydantic")).toBe(true);
      expect(top.has("mcp")).toBe(true);
      expect(listed.some((f) => /^pydantic_core\/_pydantic_core\..*aarch64-linux-gnu\.so$/.test(f))).toBe(true);
      expect(top.has("boto3") || top.has("botocore")).toBe(false);
    }
  });
});
