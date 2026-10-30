import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AssetHashType, type ILocalBundling } from "aws-cdk-lib";
import { Code, Runtime } from "aws-cdk-lib/aws-lambda";

const ROOT = path.join(__dirname, "..");

// boto3 and what it pulls in come with the Lambda Python runtime; bundling them would only shadow those.
const PROVIDED_BY_RUNTIME = ["boto3", "botocore", "s3transfer", "jmespath", "python-dateutil", "six", "urllib3"];

const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: ROOT, stdio: "pipe" });

type BundleOptions = { withMcp: boolean };

// ledger_api.mcp imports the SDK, so only the bundle with the SDK holds it.
const shipsModule = (relative: string, { withMcp }: BundleOptions) => {
  const parts = relative.split(path.sep);
  return !parts.includes("__pycache__") && (withMcp || parts[0] !== "mcp");
};

/**
 * The locked runtime dependencies as arm64 Linux wheels, plus the ledger_api package: as ledger-agent's
 * infra/package.py builds its Lambda, with uv on the machine running cdk (no Docker). With `withMcp`, also the
 * `mcp` dependency group and `ledger_api.mcp`, which imports it.
 */
const uvBundling = (options: BundleOptions): ILocalBundling => ({
  tryBundle(outputDir) {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "ledger-api-python-"));
    const requirements = path.join(scratch, "requirements.txt");
    const skip = PROVIDED_BY_RUNTIME.flatMap((name) => ["--no-emit-package", name]);
    const groups = options.withMcp ? ["--group", "mcp"] : [];
    try {
      run("uv", ["export", "--frozen", "--no-dev", ...groups, "--no-emit-project", "--no-hashes", ...skip, "--output-file", requirements]);
      run("uv", [
        "pip", "install", "--quiet", "--requirements", requirements, "--target", outputDir,
        "--python-platform", "aarch64-manylinux2014", "--python-version", "3.13", "--only-binary", ":all:",
      ]);
    } catch (err) {
      throw new Error("Bundling the Python Lambdas needs uv (https://docs.astral.sh/uv/)", { cause: err });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const pkg = path.join(ROOT, "src", "ledger_api");
    cpSync(pkg, path.join(outputDir, "ledger_api"), {
      recursive: true,
      filter: (source) => source === pkg || shipsModule(path.relative(pkg, source), options),
    });
    // /var/task is read-only, so without bytecode every cold start compiles everything from source (about 0.8 s).
    // Unchecked hashes survive the copy into the asset, which changes file times; paths read as /var/task in tracebacks.
    run("uv", [
      "run", "--no-project", "--python", "3.13", "python", "-m", "compileall", "-q", "-j", "0",
      "--invalidation-mode", "unchecked-hash", "-s", outputDir, "-p", "/var/task", outputDir,
    ]);
    return true;
  },
});

/**
 * A bundle's hash, from what it is built of: the ledger_api modules it ships, the lock file, and this file, which
 * says how. It is known before bundling, so CDK reuses a bundle it already built, and each of the two bundles has
 * its own.
 */
export const bundleHash = ({ withMcp, root = ROOT }: BundleOptions & { root?: string }) => {
  const hash = createHash("sha256").update(withMcp ? "with-mcp\0" : "lean\0");
  const pkg = path.join(root, "src", "ledger_api");
  const modules = readdirSync(pkg, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => path.relative(pkg, path.join(f.parentPath, f.name)))
    .filter((relative) => shipsModule(relative, { withMcp }))
    .sort();
  const inputs = [
    ...modules.map((relative) => path.join(pkg, relative)),
    path.join(root, "pyproject.toml"),
    path.join(root, "uv.lock"),
    __filename,
  ];
  for (const file of inputs) {
    hash.update(`${path.relative(root, file)}\0`).update(readFileSync(file)).update("\0");
  }
  return hash.digest("hex");
};

/**
 * The code of the Python Lambdas: one bundle for all but MCP, and one with the MCP SDK too, which is most of
 * that bundle's size and so of each cold start.
 */
export const pythonCode = ({ withMcp = false }: { withMcp?: boolean } = {}) =>
  Code.fromAsset(ROOT, {
    // Not the bundle's output: CDK fingerprints that through the asset's excludes, which would see none of it.
    assetHashType: AssetHashType.CUSTOM,
    assetHash: bundleHash({ withMcp }),
    bundling: {
      local: uvBundling({ withMcp }),
      // Only used if local bundling declines, which it never does: it fails loudly without uv instead.
      image: Runtime.PYTHON_3_13.bundlingImage,
    },
  });
