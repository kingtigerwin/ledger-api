"""
Finds what a customer bought, for "how much did I spend on bananas?". Pure logic, like `insights`: DynamoDB can't
search inside a list of lines, and one customer's transactions for a date range are few enough to filter here.
"""

import re
import unicodedata
from collections.abc import Iterable, Iterator
from typing import TypedDict

from ledger_api.data.schemas import ReceiptLine, Transaction

# What a client gets back; `count` and `totalCents` still cover everything found.
MAX_MATCHES = 100


class PurchaseMatch(TypedDict):
    transactionId: str
    date: str
    merchant: str | None
    # As printed on a receipt, or the item of an expense typed into the chat.
    name: str
    # In plain words, when a receipt line has it: `name` can be `CLS CHKN DRUMSTICKS`.
    product: str | None
    amountCents: int


class PurchaseResults(TypedDict):
    matches: list[PurchaseMatch]
    count: int
    totalCents: int
    currency: str
    # A receipt's lines are shelf prices, so some of this total may have been paid with points rather than money.
    includesPoints: bool


def _normal(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def _pattern(terms: Iterable[str]) -> re.Pattern[str]:
    """
    A term matches at the start of a word, so `banana` finds `BANANAS` but not `BANDANA`, and only the singular is
    needed. Chinese has no spaces between words, so a term in it matches anywhere.
    """

    def alternative(term: str) -> str:
        text = _normal(term)
        return rf"(?<![a-z0-9]){re.escape(text)}" if text[0].isascii() else re.escape(text)

    return re.compile("|".join(alternative(term) for term in terms))


def _line_text(line: ReceiptLine) -> str:
    return _normal(f"{line['name']} {line.get('product', '')}")


def _matches_in(t: Transaction, pattern: re.Pattern[str]) -> Iterator[PurchaseMatch]:
    """A receipt's lines say what was bought; its `item` only repeats them, or says "18 items"."""
    receipt = t.get("receipt", {})
    lines = receipt.get("lines")
    if lines:
        found = [
            (line["name"], line.get("product"), line["amountCents"])
            for line in lines
            if pattern.search(_line_text(line))
        ]
    else:
        found = [(t["item"], None, t["amountCents"])] if pattern.search(_normal(t["item"])) else []
    for name, product, cents in found:
        yield PurchaseMatch(
            transactionId=t["id"],
            date=t["date"],
            merchant=t.get("merchant"),
            name=name,
            product=product,
            amountCents=cents,
        )


def _paid_with_points(t: Transaction) -> bool:
    return any(payment["kind"] == "points" for payment in t.get("receipt", {}).get("payments", []))


def find_purchases(transactions: Iterable[Transaction], terms: Iterable[str]) -> PurchaseResults:
    """Every line or typed expense matching any term, in the order given; a line matching two terms counts once."""
    pattern = _pattern(terms)
    matches: list[PurchaseMatch] = []
    points = False
    for t in transactions:
        found = [*_matches_in(t, pattern)]
        matches.extend(found)
        points = points or (bool(found) and _paid_with_points(t))
    return PurchaseResults(
        matches=matches[:MAX_MATCHES],
        count=len(matches),
        totalCents=sum(match["amountCents"] for match in matches),
        currency="AUD",
        includesPoints=points,
    )
