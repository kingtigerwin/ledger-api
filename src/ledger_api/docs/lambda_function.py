from typing import Any

from ledger_api.docs.handler import create_docs_handler
from ledger_api.http import Response

_handler = create_docs_handler()


def handler(event: dict[str, Any], context: Any) -> Response:
    return _handler(event)
