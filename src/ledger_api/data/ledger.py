import re
from collections.abc import Callable, Iterator
from datetime import date, datetime, timedelta
from typing import Any

from botocore.exceptions import ClientError

from ledger_api.data.cursor import InvalidCursorError, decode_cursor, encode_cursor
from ledger_api.data.insights import INSIGHT_ID_PATTERN, LOOKBACK, find_insights
from ledger_api.data.schemas import DEFAULT_LIMIT, ListQuery, NewTransaction, Transaction, TransactionEdit
from ledger_api.data.transactions_store import (
    ListRange,
    Page,
    TransactionNotFoundError,
    TransactionsStore,
    VersionConflictError,
)
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
    What a customer (or the admin) can do with transactions: the REST handler and the MCP tools
    both call this, so they share rules and error messages. Failures are `ApiError`s.
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

    def _page[T](
        self, query: ListQuery, lister: Callable[[ListRange, dict[str, Any] | None], Page[T]]
    ) -> dict[str, Any]:
        """One page from `lister` (one customer's transactions, or everyone's), with a signed next-page cursor."""
        cursor = query.get("cursor")
        try:
            start_key = decode_cursor(cursor, self._cursor_secret) if cursor else None
        except InvalidCursorError:
            raise _invalid_cursor() from None
        span = ListRange(
            date_from=query.get("from"),
            date_to=query.get("to"),
            category=query.get("category"),
            limit=query.get("limit", DEFAULT_LIMIT),
        )
        try:
            items, last_key = lister(span, start_key)
        except ClientError as err:
            # A genuine cursor from a different filter has keys this query can't start from. DynamoDB's
            # client models no ValidationException, so match the code.
            if start_key and err.response.get("Error", {}).get("Code") == "ValidationException":
                raise _invalid_cursor() from None
            raise
        return {"items": items, "nextCursor": encode_cursor(last_key, self._cursor_secret) if last_key else None}

    def list(self, user_id: str, query: ListQuery) -> dict[str, Any]:
        """One page of the customer's transactions."""
        return self._page(query, lambda span, start_key: self._transactions.list(user_id, span, start_key))

    def list_all(self, query: ListQuery) -> dict[str, Any]:
        """One page of every customer's transactions, for the admin."""
        return self._page(query, self._transactions.list_all)

    def _all_between(self, user_id: str, date_from: str, date_to: str) -> Iterator[Transaction]:
        """Every page of a date range, for the totals and rules that need the whole of it."""
        start_key: dict[str, Any] | None = None
        while True:
            span = ListRange(date_from=date_from, date_to=date_to, category=None, limit=100)
            items, start_key = self._transactions.list(user_id, span, start_key)
            yield from items
            if not start_key:
                return

    def summary(self, user_id: str, month: str) -> dict[str, Any]:
        """
        Totals for one month, computed on request. A customer records a few hundred transactions a month,
        so reading them all is cheap; precomputed totals would be the upgrade if that changes.
        """
        by_category: dict[str, int] = {}
        # Day 31 is a safe upper bound for every month: sort keys compare as strings.
        for t in self._all_between(user_id, f"{month}-01", f"{month}-31"):
            by_category[t["category"]] = by_category.get(t["category"], 0) + t["amountCents"]
        ranked = sorted(by_category.items(), key=lambda entry: (-entry[1], entry[0]))
        return {
            "month": month,
            "currency": "AUD",
            "totalCents": sum(by_category.values()),
            "byCategory": [{"category": category, "totalCents": total} for category, total in ranked],
        }

    def insights(self, user_id: str, today: str) -> dict[str, Any]:
        """
        What needs the customer's attention, computed on request as `summary` is: over a year or so of
        one customer's transactions, the read costs almost nothing.
        """
        day = date.fromisoformat(today)
        transactions = [*self._all_between(user_id, (day - LOOKBACK).isoformat(), today)]
        return {"items": find_insights(transactions, day, self._transactions.dismissed_insights(user_id))}

    def dismiss_insight(self, user_id: str, id: str) -> None:
        """
        Doesn't check the insight still applies, which would mean running every rule: an ID nothing
        matches is one harmless row. The format check keeps anything else out of the table.
        """
        if not re.fullmatch(INSIGHT_ID_PATTERN, id):
            raise ApiError(400, "invalid_insight_id", "That is not an insight ID")
        self._transactions.dismiss_insight(user_id, id, self._now())
