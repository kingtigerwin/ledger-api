import os
from typing import Any

from ledger_api.admin.handler import create_admin_handler
from ledger_api.auth.users_store import UsersStore
from ledger_api.db import dynamodb
from ledger_api.http import Response

_handler = create_admin_handler(users=UsersStore(dynamodb().Table(os.environ["USERS_TABLE"])))


def handler(event: dict[str, Any], context: Any) -> Response:
    return _handler(event)
