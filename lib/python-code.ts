import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ILocalBundling } from "aws-cdk-lib";
import { Code, Runtime } from "aws-cdk-lib/aws-lambda";

const ROOT = path.join(__dirname, "..");

// boto3 and what it pulls in come with the Lambda Python runtime; bundling them would only shadow those.
const PROVIDED_BY_RUNTIME = ["boto3", "botocore", "s3transfer", "jmespath", "python-dateutil", "six", "urllib3"];

const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: ROOT, stdio: "pipe" });

/**
 * The locked runtime dependencies as arm64 Linux wheels, plus the ledger_api package: as ledger-agent's
 * infra/package.py builds its Lambda, with uv on the machine running cdk (no Docker).
 */
const uvBundling: ILocalBundling = {
  tryBundle(outputDir) {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "ledger-api-python-"));
    const requirements = path.join(scratch, "requirements.txt");
    const skip = PROVIDED_BY_RUNTIME.flatMap((name) => ["--no-emit-package", name]);
    try {
      run("uv", ["export", "--frozen", "--no-dev", "--no-emit-project", "--no-hashes", ...skip, "--output-file", requirements]);
      run("uv", [
        "pip", "install", "--quiet", "--requirements", requirements, "--target", outputDir,
        "--python-platform", "aarch64-manylinux2014", "--python-version", "3.13", "--only-binary", ":all:",
      ]);
    } catch (err) {
      throw new Error("Bundling the Python Lambdas needs uv (https://docs.astral.sh/uv/)", { cause: err });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    cpSync(path.join(ROOT, "src", "ledger_api"), path.join(outputDir, "ledger_api"), {
      recursive: true,
      filter: (source) => !source.includes("__pycache__"),
    });
    return true;
  },
};

/**
 * The code of every Python Lambda: one bundle, so CDK builds and uploads it once. Its hash covers the
 * package and the lock file, so a dependency change also makes a new bundle.
 */
export const pythonCode = () =>
  Code.fromAsset(ROOT, {
    exclude: ["*", "!src", "src/*", "!src/ledger_api", "!src/ledger_api/**", "**/__pycache__", "!pyproject.toml", "!uv.lock"],
    bundling: {
      local: uvBundling,
      // Only used if local bundling declines, which it never does: it fails loudly without uv instead.
      image: Runtime.PYTHON_3_13.bundlingImage,
    },
  });
