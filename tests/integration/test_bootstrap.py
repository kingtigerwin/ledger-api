from datetime import UTC, datetime
from typing import TYPE_CHECKING

import pytest

from ledger_api.auth.handler import create_auth_handler
from ledger_api.auth.tokens import verify_access_token
from ledger_api.auth.users_store import UsersStore
from ledger_api.bootstrap.handler import bootstrap, create_bootstrap_handler
from ledger_api.config import ADMIN_PASSWORD_PARAM, ADMIN_USERNAME, SIGNING_SECRET_PARAM
from tests.integration.auth_calls import LOGIN, Reply, call

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table


class FakeParameterStore:
    """In-memory stand-in for SSM Parameter Store, which DynamoDB Local can't replace."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def get(self, name: str) -> str | None:
        return self.values.get(name)

    def create_secure(self, name: str, value: str) -> None:
        if name in self.values:
            raise RuntimeError(f"Parameter {name} already exists")
        self.values[name] = value


@pytest.fixture
def parameters() -> FakeParameterStore:
    return FakeParameterStore()


def login_as_admin(table: "Table", parameters: FakeParameterStore) -> Reply:
    auth = create_auth_handler(
        users=UsersStore(table), signing_secret=parameters.values[SIGNING_SECRET_PARAM], now=lambda: datetime.now(UTC)
    )
    return call(auth, LOGIN, {"username": ADMIN_USERNAME, "password": parameters.values[ADMIN_PASSWORD_PARAM]})


class TestBootstrap:
    class TestGivenAFreshDeployment:
        def test_it_creates_random_secrets_and_an_admin_who_can_log_in_with_the_stored_password(
            self, table: "Table", parameters: FakeParameterStore
        ) -> None:
            bootstrap(users=UsersStore(table), parameters=parameters, now=lambda: datetime.now(UTC))

            assert len(parameters.values[SIGNING_SECRET_PARAM]) >= 43
            assert len(parameters.values[ADMIN_PASSWORD_PARAM]) >= 24
            res = login_as_admin(table, parameters)
            assert res.status == 200
            claims = verify_access_token(
                res.body["accessToken"], parameters.values[SIGNING_SECRET_PARAM], datetime.now(UTC)
            )
            assert claims.role == "admin"

    class TestGivenItHasAlreadyRun:
        def test_it_changes_nothing_so_existing_logins_and_tokens_keep_working(
            self, table: "Table", parameters: FakeParameterStore
        ) -> None:
            users = UsersStore(table)
            bootstrap(users=users, parameters=parameters, now=lambda: datetime.now(UTC))
            before = dict(parameters.values)
            admin = table.get_item(Key={"pk": f"USERNAME#{ADMIN_USERNAME}", "sk": "USERNAME"}).get("Item")

            bootstrap(users=users, parameters=parameters, now=lambda: datetime.now(UTC))

            assert parameters.values == before
            assert table.get_item(Key={"pk": f"USERNAME#{ADMIN_USERNAME}", "sk": "USERNAME"}).get("Item") == admin
            assert login_as_admin(table, parameters).status == 200


class TestTheCustomResource:
    @pytest.mark.parametrize("request_type", ["Create", "Update"])
    def test_it_bootstraps_on_create_and_update(
        self, table: "Table", parameters: FakeParameterStore, request_type: str
    ) -> None:
        handler = create_bootstrap_handler(
            users=UsersStore(table), parameters=parameters, now=lambda: datetime.now(UTC)
        )

        assert handler({"RequestType": request_type}) == {"PhysicalResourceId": "ledger-api-bootstrap"}
        assert SIGNING_SECRET_PARAM in parameters.values

    def test_it_does_nothing_on_delete_so_the_secrets_and_the_admin_survive(
        self, table: "Table", parameters: FakeParameterStore
    ) -> None:
        handler = create_bootstrap_handler(
            users=UsersStore(table), parameters=parameters, now=lambda: datetime.now(UTC)
        )

        assert handler({"RequestType": "Delete"}) == {"PhysicalResourceId": "ledger-api-bootstrap"}
        assert parameters.values == {}
