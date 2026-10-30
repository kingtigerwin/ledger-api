from collections.abc import Callable
from datetime import datetime

from ledger_api.data.schemas import NewTransaction, Transaction
from ledger_api.data.transactions_store import TransactionsStore
from ledger_api.http import ApiError


def _not_found() -> ApiError:
    return ApiError(404, "transaction_not_found", "No such transaction")


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

    def record(self, user_id: str, new: NewTransaction) -> tuple[Transaction, bool]:
        """Records the transaction; a retry with the same id returns what was stored, with `created` False."""
        return self._transactions.create_once(user_id, new, self._now())

    def get(self, user_id: str, id: str) -> Transaction:
        transaction = self._transactions.get(user_id, id)
        if not transaction:
            raise _not_found()
        return transaction
