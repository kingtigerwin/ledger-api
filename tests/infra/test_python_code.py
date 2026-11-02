import json
import re
import shutil
import struct
from pathlib import Path
from typing import Any

import pytest
from aws_cdk import App, Stack
from aws_cdk.aws_certificatemanager import Certificate

from infra.ledger_stack import CertifiedDomain, LedgerStack
from infra.python_code import bundle_hash
from tests.infra.support import CERTIFICATE_ARN, DOMAIN, ENV

REPO = Path(__file__).resolve().parents[2]


class Bundles:
    """Each Python function's logical ID, with the staged folder of its code and how that is uploaded."""

    def __init__(self, resources: dict[str, Any], directory: str) -> None:
        functions = {
            id: r
            for id, r in resources.items()
            if r["Type"] == "AWS::Lambda::Function" and str(r["Properties"]["Runtime"]).startswith("python")
        }
        self.assets = {id: Path(directory) / r["Metadata"]["aws:asset:path"] for id, r in functions.items()}
        self.keys = {id: json.dumps(r["Properties"]["Code"]) for id, r in functions.items()}
        self.files = {
            id: {str(f.relative_to(asset)) for f in asset.rglob("*") if f.is_file()}
            for id, asset in self.assets.items()
        }

    def key(self, name: str) -> str:
        return next(key for id, key in self.keys.items() if id.startswith(f"{name}Function"))


@pytest.fixture(scope="module")
def bundles() -> Bundles:
    app = App(
        # The CLI turns this on; it records where each function's code was staged.
        context={"aws:cdk:enable-asset-metadata": True},
        # Elsewhere the tests skip bundling; this one is about the bundle, so it runs it.
        post_cli_context={"aws:cdk:bundling-stacks": ["**"]},
    )
    certificate = Certificate.from_certificate_arn(Stack(app, "Scratch", env=ENV), "Cert", CERTIFICATE_ARN)
    LedgerStack(
        app,
        "LedgerApi",
        custom_domain=CertifiedDomain(DOMAIN.domain_name, DOMAIN.zone_name, DOMAIN.hosted_zone_id, certificate),
        email_from="noreply@example.cloud",
        env=ENV,
    )
    assembly = app.synth()
    return Bundles(assembly.get_stack_by_name("LedgerApi").template["Resources"], assembly.directory)


class TestGivenThePythonFunctionsCode:
    def test_is_built_for_every_python_function(self, bundles: Bundles) -> None:
        names = sorted(id.split("Function")[0] for id in bundles.files)

        assert names == ["Admin", "Auth", "Authorizer", "Bootstrap", "Data", "Docs", "Mcp", "Notify"]

    def test_uploads_one_bundle_for_all_but_mcp_and_another_for_mcp(self, bundles: Bundles) -> None:
        lean = {bundles.key(n) for n in ["Notify", "Admin", "Data", "Auth", "Authorizer", "Bootstrap", "Docs"]}

        assert len(lean) == 1
        assert bundles.key("Mcp") not in lean

    def test_holds_the_ledger_api_package_as_python_and_nothing_else(self, bundles: Bundles) -> None:
        for listed in bundles.files.values():
            own = {f for f in listed if f.startswith("ledger_api/")}
            assert "ledger_api/data/lambda_function.py" in own
            assert all(f.endswith((".py", ".cpython-313.pyc")) for f in own)
            assert not any(f.endswith(".ts") for f in listed)

    def test_holds_ledger_api_mcp_only_for_mcp_the_one_function_that_has_the_sdk(self, bundles: Bundles) -> None:
        for id, asset in bundles.assets.items():
            assert (asset / "ledger_api" / "mcp").exists() == id.startswith("Mcp")

    # /var/task is read-only, so without bytecode every cold start compiles pydantic (and the MCP SDK) from source.
    def test_ships_bytecode_beside_every_module_checked_by_hash_rather_than_file_times(self, bundles: Bundles) -> None:
        for id, listed in bundles.files.items():
            sources = [Path(f) for f in listed if f.endswith(".py") and "/tests/" not in f]
            missing = [s for s in sources if str(s.parent / "__pycache__" / f"{s.stem}.cpython-313.pyc") not in listed]
            assert missing == []
            # PEP 552: flags 0b01 is unchecked-hash, so the copy into the asset (new mtimes) doesn't invalidate it.
            pyc = (bundles.assets[id] / "ledger_api" / "data" / "__pycache__" / "handler.cpython-313.pyc").read_bytes()
            assert struct.unpack_from("<I", pyc, 4)[0] == 0b01

    def test_vendors_pydantic_for_arm64_linux_and_leaves_out_what_the_runtime_provides(self, bundles: Bundles) -> None:
        for listed in bundles.files.values():
            top = {f.split("/")[0] for f in listed}
            assert "pydantic" in top
            assert any(re.fullmatch(r"pydantic_core/_pydantic_core\..*aarch64-linux-gnu\.so", f) for f in listed)
            assert not {"boto3", "botocore"} & top

    # The SDK and what it pulls in (starlette, cryptography, ...) grow the bundle fivefold, so every cold start too.
    def test_vendors_the_mcp_sdk_for_mcp_only(self, bundles: Bundles) -> None:
        for id, listed in bundles.files.items():
            assert ("mcp" in {f.split("/")[0] for f in listed}) == id.startswith("Mcp")

    # The CDK is locked beside the Lambdas' dependencies now, and is far bigger than all of them.
    def test_leaves_the_cdk_out_of_every_bundle(self, bundles: Bundles) -> None:
        for listed in bundles.files.values():
            assert not {"aws_cdk", "constructs", "jsii"} & {f.split("/")[0] for f in listed}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """A small project in the shape the bundle is built from, so a test can change it."""
    for module in ["data", "mcp"]:
        folder = tmp_path / "src" / "ledger_api" / module
        folder.mkdir(parents=True)
        (folder / "handler.py").write_text(f"# {module}\n")
    for name in ["pyproject.toml", "uv.lock"]:
        shutil.copy(REPO / name, tmp_path / name)
    return tmp_path


def append(file: Path, text: str) -> None:
    with file.open("a") as f:
        f.write(text)


class TestBundleHash:
    def test_changes_when_a_module_changes_so_the_deploy_updates_the_code(self, project: Path) -> None:
        before = bundle_hash(with_mcp=False, root=project)

        append(project / "src" / "ledger_api" / "data" / "handler.py", "x = 1\n")

        assert bundle_hash(with_mcp=False, root=project) != before

    def test_changes_when_the_locked_dependencies_change(self, project: Path) -> None:
        before = bundle_hash(with_mcp=True, root=project)

        append(project / "uv.lock", "\n")

        assert bundle_hash(with_mcp=True, root=project) != before

    def test_differs_between_the_two_bundles(self, project: Path) -> None:
        assert bundle_hash(with_mcp=True, root=project) != bundle_hash(with_mcp=False, root=project)

    def test_leaves_out_ledger_api_mcp_for_the_bundle_without_it(self, project: Path) -> None:
        lean, with_mcp = bundle_hash(with_mcp=False, root=project), bundle_hash(with_mcp=True, root=project)

        append(project / "src" / "ledger_api" / "mcp" / "handler.py", "x = 1\n")

        assert bundle_hash(with_mcp=False, root=project) == lean
        assert bundle_hash(with_mcp=True, root=project) != with_mcp

    def test_ignores_bytecode_left_by_local_runs(self, project: Path) -> None:
        before = bundle_hash(with_mcp=False, root=project)

        cache = project / "src" / "ledger_api" / "data" / "__pycache__"
        cache.mkdir()
        (cache / "handler.cpython-313.pyc").write_text("stale")

        assert bundle_hash(with_mcp=False, root=project) == before
