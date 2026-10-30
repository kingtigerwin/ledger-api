from collections.abc import Callable
from datetime import datetime

from ledger_api.data.transactions_store import TransactionsStore


class Ledger:
    """
    What a customer (or the admin) can do with transactions, like src/data/ledger.ts: the REST
    handler calls this, and so will the MCP tools once they move. Failures are `ApiError`s.
    """

    def __init__(self, transactions: TransactionsStore, *, cursor_secret: str, now: Callable[[], datetime]) -> None:
        self._transactions = transactions
        # Signs list cursors so clients can't tamper with them.
        self._cursor_secret = cursor_secret
        self._now = now
