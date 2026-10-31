"""The real bundles, built with uv, and the hash that decides when a deploy updates them."""

import re
import shutil
from dataclasses import dataclass
from pathlib import Path

import pytest
from aws_cdk import App, Stack
from aws_cdk import aws_certificatemanager as acm

from infra.ledger_stack import CertifiedDomain, LedgerStack
from infra.python_code import ROOT, bundle_hash
from tests.infra.stacks import CERTIFICATE_ARN, ENV


@dataclass(frozen=True)
class Function:
    name: str
    code: str
    asset: Path

    @property
    def files(self) -> list[str]:
        return [str(path.relative_to(self.asset)) for path in self.asset.rglob("*") if path.is_file()]


@pytest.fixture(scope="module")
def functions() -> list[Function]:
    app = App(
        # The CLI turns this on; it records where each function's code was staged.
        context={"aws:cdk:enable-asset-metadata": True},
        # These tests skip bundling (conftest.py); this one is about the bundle, so it runs it.
        post_cli_context={"aws:cdk:bundling-stacks": ["**"]},
    )
    certificate = acm.Certificate.from_certificate_arn(Stack(app, "Scratch", env=ENV), "Cert", CERTIFICATE_ARN)
    LedgerStack(
        app,
        "LedgerApi",
        env=ENV,
        custom_domain=CertifiedDomain("api.example.cloud", "example.cloud", "ZEXAMPLE123", certificate),
        email_from="noreply@example.cloud",
    )
    assembly = app.synth()
    resources = assembly.get_stack_by_name("LedgerApi").template["Resources"]
    return [
        Function(
            name=logical_id.split("Function")[0],
            code=str(resource["Properties"]["Code"]),
            asset=Path(assembly.directory) / resource["Metadata"]["aws:asset:path"],
        )
        for logical_id, resource in resources.items()
        if resource["Type"] == "AWS::Lambda::Function" and str(resource["Properties"]["Runtime"]).startswith("python")
    ]


class TestGivenThePythonFunctionsCode:
    def test_is_built_for_every_python_function(self, functions: list[Function]) -> None:
        assert sorted(function.name for function in functions) == [
            "Admin",
            "Auth",
            "Authorizer",
            "Bootstrap",
            "Data",
            "Docs",
            "Mcp",
            "Notify",
        ]

    def test_uploads_one_bundle_for_all_but_mcp_and_another_for_mcp(self, functions: list[Function]) -> None:
        lean = {function.code for function in functions if function.name != "Mcp"}
        mcp = next(function.code for function in functions if function.name == "Mcp")

        assert len(lean) == 1
        assert mcp not in lean

    def test_holds_the_ledger_api_package_and_nothing_of_ours_beside_it(self, functions: list[Function]) -> None:
        for function in functions:
            own = [file for file in function.files if file.startswith("ledger_api/")]

            assert "ledger_api/data/lambda_function.py" in own
            assert all(file.endswith((".py", ".cpython-313.pyc")) for file in own)
            assert not any(file.endswith(".ts") for file in function.files)
            assert not any(file.split("/")[0] == "infra" for file in function.files)

    def test_holds_ledger_api_mcp_only_for_mcp_the_one_function_with_the_sdk_it_imports(
        self, functions: list[Function]
    ) -> None:
        for function in functions:
            assert (function.asset / "ledger_api" / "mcp").is_dir() == (function.name == "Mcp")

    # /var/task is read-only, so without bytecode every cold start compiles pydantic (and the MCP SDK) from source.
    def test_ships_bytecode_for_python_3_13_beside_every_module_checked_by_hash_not_file_times(
        self, functions: list[Function]
    ) -> None:
        for function in functions:
            sources = [Path(f) for f in function.files if f.endswith(".py") and "/tests/" not in f]
            present = set(function.files)
            missing = [
                source
                for source in sources
                if str(source.parent / "__pycache__" / f"{source.stem}.cpython-313.pyc") not in present
            ]

            assert missing == []
            # PEP 552: flags 0b01 is unchecked-hash, so the copy into the asset (new mtimes) doesn't invalidate it.
            pyc = (function.asset / "ledger_api/data/__pycache__/handler.cpython-313.pyc").read_bytes()
            assert int.from_bytes(pyc[4:8], "little") == 0b01

    def test_vendors_pydantic_for_arm64_linux_and_leaves_out_boto3_which_the_runtime_provides(
        self, functions: list[Function]
    ) -> None:
        for function in functions:
            top = {file.split("/")[0] for file in function.files}

            assert "pydantic" in top
            assert any(
                re.fullmatch(r"pydantic_core/_pydantic_core\..*aarch64-linux-gnu\.so", f) for f in function.files
            )
            assert not top & {"boto3", "botocore"}

    # The CDK's Python packages must never reach a Lambda: they are hundreds of megabytes.
    def test_leaves_out_the_cdk(self, functions: list[Function]) -> None:
        for function in functions:
            assert not {file.split("/")[0] for file in function.files} & {"aws_cdk", "constructs", "jsii"}

    # The SDK and what it pulls in (starlette, cryptography, ...) grow the bundle, and every cold start, fivefold.
    def test_vendors_the_mcp_sdk_for_mcp_only(self, functions: list[Function]) -> None:
        for function in functions:
            has_sdk = any(file.split("/")[0] == "mcp" for file in function.files)

            assert has_sdk == (function.name == "Mcp")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """A small project in the shape the bundle is built from, so a test can change it."""
    for module in ("data", "mcp"):
        (tmp_path / "src" / "ledger_api" / module).mkdir(parents=True)
        (tmp_path / "src" / "ledger_api" / module / "handler.py").write_text(f"# {module}\n")
    shutil.copy(ROOT / "pyproject.toml", tmp_path)
    shutil.copy(ROOT / "uv.lock", tmp_path)
    return tmp_path


def append(path: Path, text: str) -> None:
    path.write_text(path.read_text() + text)


class TestGivenABundlesHash:
    def test_changes_when_a_module_changes_so_the_deploy_updates_the_code(self, project: Path) -> None:
        before = bundle_hash(with_mcp=False, root=project)

        append(project / "src/ledger_api/data/handler.py", "x = 1\n")

        assert bundle_hash(with_mcp=False, root=project) != before

    def test_changes_when_the_locked_dependencies_change(self, project: Path) -> None:
        before = bundle_hash(with_mcp=True, root=project)

        append(project / "uv.lock", "\n")

        assert bundle_hash(with_mcp=True, root=project) != before

    def test_differs_between_the_two_bundles(self, project: Path) -> None:
        assert bundle_hash(with_mcp=True, root=project) != bundle_hash(with_mcp=False, root=project)

    def test_leaves_out_ledger_api_mcp_for_the_bundle_without_it(self, project: Path) -> None:
        lean, with_mcp = bundle_hash(with_mcp=False, root=project), bundle_hash(with_mcp=True, root=project)

        append(project / "src/ledger_api/mcp/handler.py", "x = 1\n")

        assert bundle_hash(with_mcp=False, root=project) == lean
        assert bundle_hash(with_mcp=True, root=project) != with_mcp

    def test_ignores_bytecode_left_by_local_runs(self, project: Path) -> None:
        before = bundle_hash(with_mcp=False, root=project)

        (project / "src/ledger_api/data/__pycache__").mkdir()
        (project / "src/ledger_api/data/__pycache__/handler.cpython-313.pyc").write_text("stale")

        assert bundle_hash(with_mcp=False, root=project) == before
