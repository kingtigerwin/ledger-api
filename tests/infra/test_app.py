"""infra/app.py, run the way `cdk synth` runs it: the only test of its wiring before a deploy would find out."""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from infra.python_code import ROOT


@pytest.fixture(scope="module")
def synthesized(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("cdk.out")
    context = json.loads((ROOT / "cdk.json").read_text())["context"]
    subprocess.run(
        [sys.executable, "infra/app.py"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        env={
            **os.environ,
            "CDK_OUTDIR": str(out),
            "CDK_DEFAULT_ACCOUNT": "111111111111",
            "CDK_CONTEXT_JSON": json.dumps({**context, "aws:cdk:bundling-stacks": []}),
        },
    )
    return out


def template(out: Path, stack: str) -> dict[str, Any]:
    return json.loads((out / f"{stack}.template.json").read_text())


class TestGivenCdkJsonsContext:
    def test_synthesizes_all_three_stacks(self, synthesized: Path) -> None:
        for stack in ("LedgerApi", "LedgerApiCertificate", "LedgerApiCiAccess"):
            assert template(synthesized, stack)["Resources"]

    def test_passes_the_optional_features_to_the_api_stack(self, synthesized: Path) -> None:
        resources = template(synthesized, "LedgerApi")["Resources"]
        variables = {
            logical_id.split("Function")[0]: resource["Properties"].get("Environment", {}).get("Variables", {})
            for logical_id, resource in resources.items()
            if resource["Type"] == "AWS::Lambda::Function"
        }

        assert variables["Auth"]["GOOGLE_REDIRECT_URI"].startswith("https://")
        assert variables["Notify"]["EMAIL_FROM"] == "noreply@haoran.cloud"
