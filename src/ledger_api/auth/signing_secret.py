from typing import TYPE_CHECKING

from ledger_api.config import SIGNING_SECRET_PARAM

if TYPE_CHECKING:
    from mypy_boto3_ssm import SSMClient


def load_signing_secret(ssm: "SSMClient") -> str:
    """The JWT signing secret; read it once per cold start. The bootstrap custom resource creates it."""
    return ssm.get_parameter(Name=SIGNING_SECRET_PARAM, WithDecryption=True)["Parameter"].get("Value", "")
