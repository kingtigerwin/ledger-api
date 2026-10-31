"""The code of the Lambdas: one bundle for all but MCP, and one with the MCP SDK too."""

import hashlib
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import jsii
from aws_cdk import AssetHashType, BundlingOptions, ILocalBundling
from aws_cdk import aws_lambda as lambda_

ROOT = Path(__file__).resolve().parent.parent
# boto3 and what it pulls in come with the Lambda Python runtime; bundling them would only shadow those.
PROVIDED_BY_RUNTIME = ("boto3", "botocore", "s3transfer", "jmespath", "python-dateutil", "six", "urllib3")


def _run(*command: str) -> None:
    subprocess.run(command, cwd=ROOT, check=True, capture_output=True)


def _modules(package: Path, *, with_mcp: bool) -> list[Path]:
    """The package's files a bundle ships, relative to it. ledger_api.mcp imports the SDK, so only the bundle with the
    SDK holds it."""
    files = (path.relative_to(package) for path in package.rglob("*") if path.is_file())
    return sorted(
        relative
        for relative in files
        if "__pycache__" not in relative.parts and (with_mcp or relative.parts[0] != "mcp")
    )


@jsii.implements(ILocalBundling)
class _UvBundling:
    """The locked runtime dependencies as arm64 Linux wheels, plus the ledger_api package: as ledger-agent's
    infra/package.py builds its Lambda, with uv on the machine running cdk (no Docker). With `with_mcp`, also the
    `mcp` dependency group and `ledger_api.mcp`, which imports it."""

    def __init__(self, *, with_mcp: bool) -> None:
        self._with_mcp = with_mcp

    def try_bundle(self, output_dir: str, *_: Any, **__: Any) -> bool:
        skip = [arg for name in PROVIDED_BY_RUNTIME for arg in ("--no-emit-package", name)]
        groups = ["--group", "mcp"] if self._with_mcp else []
        try:
            with tempfile.TemporaryDirectory(prefix="ledger-api-python-") as scratch:
                requirements = str(Path(scratch) / "requirements.txt")
                _run(
                    "uv", "export", "--frozen", "--no-dev", "--no-group", "infra", *groups, "--no-emit-project",
                    "--no-hashes", *skip, "--output-file", requirements,
                )  # fmt: skip
                _run(
                    "uv", "pip", "install", "--quiet", "--requirements", requirements, "--target", output_dir,
                    "--python-platform", "aarch64-manylinux2014", "--python-version", "3.13", "--only-binary", ":all:",
                )  # fmt: skip
        except (OSError, subprocess.CalledProcessError) as err:
            raise RuntimeError("Bundling the Lambdas needs uv (https://docs.astral.sh/uv/)") from err
        package = ROOT / "src" / "ledger_api"
        for relative in _modules(package, with_mcp=self._with_mcp):
            target = Path(output_dir) / "ledger_api" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(package / relative, target)
        # /var/task is read-only, so without bytecode every cold start compiles everything from source (about 0.8 s).
        # Unchecked hashes survive the copy into the asset, which changes file times; paths read as /var/task in
        # tracebacks.
        _run(
            "uv", "run", "--no-project", "--python", "3.13", "python", "-m", "compileall", "-q", "-j", "0",
            "--invalidation-mode", "unchecked-hash", "-s", output_dir, "-p", "/var/task", output_dir,
        )  # fmt: skip
        return True


def bundle_hash(*, with_mcp: bool, root: Path = ROOT) -> str:
    """A bundle's hash, from what it is built of: the ledger_api modules it ships, the lock file, and this file, which
    says how. It is known before bundling, so CDK reuses a bundle it already built, and each of the two bundles has
    its own."""
    digest = hashlib.sha256(b"with-mcp\0" if with_mcp else b"lean\0")
    package = root / "src" / "ledger_api"
    modules = [package / relative for relative in _modules(package, with_mcp=with_mcp)]
    for file in (*modules, root / "pyproject.toml", root / "uv.lock", Path(__file__).resolve()):
        digest.update(f"{os.path.relpath(file, root)}\0".encode())
        digest.update(file.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def python_code(*, with_mcp: bool = False) -> lambda_.AssetCode:
    """The SDK is most of the MCP bundle's size, and so of each cold start, which is why it has a bundle of its own."""
    return lambda_.Code.from_asset(
        str(ROOT),
        # Not the bundle's output: CDK fingerprints that through the asset's excludes, which would see none of it.
        asset_hash_type=AssetHashType.CUSTOM,
        asset_hash=bundle_hash(with_mcp=with_mcp),
        bundling=BundlingOptions(
            local=_UvBundling(with_mcp=with_mcp),
            # Only used if local bundling declines, which it never does: it fails loudly without uv instead.
            image=lambda_.Runtime.PYTHON_3_13.bundling_image,
        ),
    )
