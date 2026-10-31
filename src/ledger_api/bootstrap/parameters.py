from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from mypy_boto3_ssm import SSMClient


class ParameterStore(Protocol):
    def get(self, name: str) -> str | None: ...

    def create_secure(self, name: str, value: str) -> None:
        """Creates an encrypted parameter; fails if it already exists, so a secret is never overwritten."""
        ...


class SsmParameterStore:
    def __init__(self, ssm: "SSMClient") -> None:
        self._ssm = ssm

    def get(self, name: str) -> str | None:
        try:
            return self._ssm.get_parameter(Name=name, WithDecryption=True)["Parameter"].get("Value")
        except self._ssm.exceptions.ParameterNotFound:
            return None

    def create_secure(self, name: str, value: str) -> None:
        # Standard tier and the AWS-managed aws/ssm key keep this free.
        self._ssm.put_parameter(Name=name, Value=value, Type="SecureString", Overwrite=False)
