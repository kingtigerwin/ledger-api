from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from ledger_api.data.cursor import InvalidCursorError, decode_cursor, encode_cursor
from ledger_api.data.schemas import DEFAULT_LIMIT, ListQuery, NewTransaction, Transaction, TransactionEdit
from ledger_api.data.transactions_store import TransactionNotFoundError, TransactionsStore, VersionConflictError
from ledger_api.data.ulid import ulid_time
from ledger_api.http import ApiError

# Client clocks drift a little; an ID from further ahead than this would distort the sort order.
MAX_CLOCK_SKEW = timedelta(minutes=5)


def _invalid_cursor() -> ApiError:
    return ApiError(400, "invalid_cursor", "The cursor is invalid; start from the first page")


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
        now = self._now()
        if ulid_time(new["id"]) > now + MAX_CLOCK_SKEW:
            raise ApiError(400, "invalid_id", "The id's timestamp is in the future")
        return self._transactions.create_once(user_id, new, now)

    def get(self, user_id: str, id: str) -> Transaction:
        transaction = self._transactions.get(user_id, id)
        if not transaction:
            raise _not_found()
        return transaction

    def update(self, user_id: str, id: str, edit: TransactionEdit) -> Transaction:
        try:
            return self._transactions.update(user_id, id, edit, self._now())
        except TransactionNotFoundError:
            raise _not_found() from None
        except VersionConflictError:
            raise ApiError(
                409, "version_conflict", "Someone else changed this transaction; reload it and try again"
            ) from None

    def remove(self, user_id: str, id: str) -> None:
        try:
            self._transactions.delete(user_id, id)
        except TransactionNotFoundError:
            raise _not_found() from None

    def list(self, user_id: str, query: ListQuery) -> dict[str, Any]:
        """One page of the customer's transactions, with a signed cursor for the next page."""
        cursor = query.get("cursor")
        try:
            start_key = decode_cursor(cursor, self._cursor_secret) if cursor else None
        except InvalidCursorError:
            raise _invalid_cursor() from None
        items, last_key = self._transactions.list(
            user_id,
            date_from=query.get("from"),
            date_to=query.get("to"),
            category=query.get("category"),
            limit=query.get("limit", DEFAULT_LIMIT),
            start_key=start_key,
        )
        return {"items": items, "nextCursor": encode_cursor(last_key, self._cursor_secret) if last_key else None}
