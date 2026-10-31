import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { beforeAll, describe, expect, it } from "vitest";
import { LedgerStack } from "../../lib/ledger-stack";
import { bundleHash } from "../../lib/python-code";

const env = { account: "111111111111", region: "ap-southeast-2" };
const domain = { domainName: "api.example.cloud", zoneName: "example.cloud", hostedZoneId: "ZEXAMPLE123" };

type Resources = Record<string, { Type: string; Properties: Record<string, unknown>; Metadata?: Record<string, string> }>;

describe("given the Python functions' code", () => {
  let files: Map<string, string[]>;
  let assets: Map<string, string>;
  let keys: Map<string, string>;

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
    assets = new Map(
      Object.entries(resources)
        .filter(([, r]) => r.Type === "AWS::Lambda::Function" && String(r.Properties.Runtime).startsWith("python"))
        .map(([id, r]) => [id, path.join(assembly.directory, r.Metadata!["aws:asset:path"]!)]),
    );
    keys = new Map([...assets.keys()].map((id) => [id, JSON.stringify(resources[id]!.Properties.Code)]));
    files = new Map(
      [...assets].map(([id, asset]) => {
        const listed = readdirSync(asset, { recursive: true, withFileTypes: true })
          .filter((f) => f.isFile())
          .map((f) => path.relative(asset, path.join(f.parentPath, f.name)));
        return [id, listed] as const;
      }),
    );
  }, 120_000);

  it("is built for every Python function", () => {
    expect([...files.keys()].map((id) => id.replace(/Function.*/, "")).sort()).toEqual([
      "Admin", "Auth", "Authorizer", "Bootstrap", "Data", "Docs", "Mcp", "Notify",
    ]);
  });

  it("uploads one bundle for all but Mcp, and another for Mcp", () => {
    const key = (name: string) => keys.get([...keys.keys()].find((id) => id.startsWith(`${name}Function`))!);
    const lean = ["Notify", "Admin", "Data", "Auth", "Authorizer", "Bootstrap", "Docs"].map(key);
    expect(new Set(lean).size).toBe(1);
    expect(key("Mcp")).not.toEqual(key("Data"));
  });

  it("holds the ledger_api package as Python, without the TypeScript beside it", () => {
    for (const listed of files.values()) {
      const own = listed.filter((f) => f.startsWith(`ledger_api${path.sep}`));
      expect(own).toContain(path.join("ledger_api", "data", "lambda_function.py"));
      expect(own.every((f) => f.endsWith(".py") || f.endsWith(".cpython-313.pyc"))).toBe(true);
      expect(listed.some((f) => f.endsWith(".ts"))).toBe(false);
    }
  });

  it("holds ledger_api.mcp only for Mcp, the one function that has the SDK it imports", () => {
    for (const [id, asset] of assets) {
      const hasMcpModule = readdirSync(path.join(asset, "ledger_api")).includes("mcp");
      expect([id, hasMcpModule]).toEqual([id, id.startsWith("Mcp")]);
    }
  });

  // /var/task is read-only, so without bytecode every cold start compiles pydantic (and the MCP SDK) from source.
  it("ships bytecode for Python 3.13 beside every module, checked by hash rather than file times", () => {
    for (const [id, listed] of files) {
      const present = new Set(listed);
      const sources = listed.filter((f) => f.endsWith(".py") && !f.includes(`${path.sep}tests${path.sep}`));
      const missing = sources.filter((f) => {
        const pyc = path.join(path.dirname(f), "__pycache__", `${path.basename(f, ".py")}.cpython-313.pyc`);
        return !present.has(pyc);
      });
      expect(missing).toEqual([]);
      // PEP 552: flags 0b01 is unchecked-hash, so the copy into the asset (new mtimes) doesn't invalidate it.
      const pyc = readFileSync(path.join(assets.get(id)!, "ledger_api", "data", "__pycache__", "handler.cpython-313.pyc"));
      expect(pyc.readUInt32LE(4)).toBe(0b01);
    }
  });

  it("vendors pydantic for arm64 Linux, and leaves out boto3, which the runtime provides", () => {
    for (const listed of files.values()) {
      const top = new Set(listed.map((f) => f.split(path.sep)[0]));
      expect(top.has("pydantic")).toBe(true);
      expect(listed.some((f) => /^pydantic_core\/_pydantic_core\..*aarch64-linux-gnu\.so$/.test(f))).toBe(true);
      expect(top.has("boto3") || top.has("botocore")).toBe(false);
    }
  });

  // The SDK and what it pulls in (starlette, cryptography, ...) grow the bundle fivefold, and with it every cold start.
  it("vendors the MCP SDK for Mcp only", () => {
    for (const [id, listed] of files) {
      const hasSdk = listed.some((f) => f.split(path.sep)[0] === "mcp");
      expect([id, hasSdk]).toEqual([id, id.startsWith("Mcp")]);
    }
  });
});

describe("given a bundle's hash", () => {
  // A small project in the shape the bundle is built from, so a test can change it.
  const project = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ledger-api-hash-"));
    for (const module of ["data", "mcp"]) {
      mkdirSync(path.join(root, "src", "ledger_api", module), { recursive: true });
      writeFileSync(path.join(root, "src", "ledger_api", module, "handler.py"), `# ${module}\n`);
    }
    cpSync(path.join(__dirname, "..", "..", "pyproject.toml"), path.join(root, "pyproject.toml"));
    cpSync(path.join(__dirname, "..", "..", "uv.lock"), path.join(root, "uv.lock"));
    return root;
  };

  it("changes when a module changes, so the deploy updates the code", () => {
    const root = project();
    const before = bundleHash({ withMcp: false, root });
    appendFileSync(path.join(root, "src", "ledger_api", "data", "handler.py"), "x = 1\n");
    expect(bundleHash({ withMcp: false, root })).not.toBe(before);
  });

  it("changes when the locked dependencies change", () => {
    const root = project();
    const before = bundleHash({ withMcp: true, root });
    appendFileSync(path.join(root, "uv.lock"), "\n");
    expect(bundleHash({ withMcp: true, root })).not.toBe(before);
  });

  it("differs between the two bundles", () => {
    const root = project();
    expect(bundleHash({ withMcp: true, root })).not.toBe(bundleHash({ withMcp: false, root }));
  });

  it("leaves out ledger_api.mcp for the bundle without it", () => {
    const root = project();
    const [lean, withMcp] = [bundleHash({ withMcp: false, root }), bundleHash({ withMcp: true, root })];
    appendFileSync(path.join(root, "src", "ledger_api", "mcp", "handler.py"), "x = 1\n");
    expect(bundleHash({ withMcp: false, root })).toBe(lean);
    expect(bundleHash({ withMcp: true, root })).not.toBe(withMcp);
  });

  it("ignores bytecode left by local runs", () => {
    const root = project();
    const before = bundleHash({ withMcp: false, root });
    mkdirSync(path.join(root, "src", "ledger_api", "data", "__pycache__"));
    writeFileSync(path.join(root, "src", "ledger_api", "data", "__pycache__", "handler.cpython-313.pyc"), "stale");
    expect(bundleHash({ withMcp: false, root })).toBe(before);
  });
});
