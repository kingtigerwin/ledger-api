"""
What the Home page asks a customer to look at, found by plain rules over their transactions. Pure logic:
`Ledger.insights` reads the transactions, and the UI writes the wording, so stored text is the only
language that comes back from here.
"""

import hashlib
import re
import unicodedata
from calendar import monthrange
from collections import defaultdict
from collections.abc import Collection, Iterable, Iterator
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal, TypedDict

from ledger_api.data.schemas import Transaction

# Far enough back to see last year's charge, and a yearly payment that's a month overdue.
LOOKBACK = timedelta(days=400)

INSIGHT_ID_PATTERN = r"[0-9a-f]{16}"

_DUPLICATE_WINDOW = timedelta(days=30)
# "Yesterday" is easily recorded a day out, so the same expense on the next day still counts.
_DUPLICATE_MAX_GAP_DAYS = 1

# A regular bill at a supermarket or restaurant is a coincidence, not a subscription.
_NOT_SUBSCRIPTIONS = {"groceries", "dining"}

_REGO_WINDOW_DAYS = 30
_REGO_TERMS_MONTHS = [(range(80, 101), 3), (range(170, 196), 6)]
_REGO_DEFAULT_TERM_MONTHS = 12
# Letters are checked by hand rather than with \b: Chinese characters count as word characters there.
_REGO = re.compile(r"(?<![a-z])(rego|car registration|vehicle registration|ctp|green slip)(?![a-z])|车辆注册")

_COMPANY_SUFFIX = re.compile(r"(\s+pty\.?\s+ltd\.?|\s+ltd\.?|\s+inc\.?|\.com(\.au)?)$")


@dataclass(frozen=True)
class _Cadence:
    name: Literal["monthly", "yearly"]
    gap_days: range
    minimum_charges: int
    charges_per_year: int
    # After this long with no charge, the subscription has stopped.
    current_for_days: int


_CADENCES = [
    _Cadence("monthly", range(26, 36), 3, 12, 45),
    _Cadence("yearly", range(350, 381), 2, 1, LOOKBACK.days),
]


class PossibleDuplicate(TypedDict):
    id: str
    type: Literal["possible_duplicate"]
    merchant: str
    amountCents: int
    currency: str
    transactions: list[Transaction]


class PriceRise(TypedDict):
    id: str
    type: Literal["price_rise"]
    merchant: str
    previousCents: int
    currentCents: int
    since: str
    cadence: Literal["monthly", "yearly"]
    extraPerYearCents: int
    currency: str
    transactions: list[Transaction]


class RegoDue(TypedDict):
    id: str
    type: Literal["rego_due"]
    estimatedDueDate: str
    lastPaidCents: int
    currency: str
    transactions: list[Transaction]


type Insight = PossibleDuplicate | PriceRise | RegoDue


def insight_id(natural_key: str) -> str:
    """A fixed-length hash, so a merchant's name in the key never has to travel in a URL."""
    return hashlib.sha256(natural_key.encode()).hexdigest()[:16]


def merchant_key(name: str) -> str:
    """One form for the ways a free-text name gets typed: `NET-FLIX`, `Netflix Pty Ltd`, `netflix.com`."""
    text = unicodedata.normalize("NFKC", name).casefold().strip()
    text = _COMPANY_SUFFIX.sub("", text)
    return "".join(character for character in text if character.isalnum()) or text


def _display_name(t: Transaction) -> str:
    return t.get("merchant") or t["item"]


def _series_key(t: Transaction) -> str:
    return merchant_key(_display_name(t))


def _day(t: Transaction) -> date:
    return date.fromisoformat(t["date"])


def _oldest_first(transactions: Iterable[Transaction]) -> list[Transaction]:
    return sorted(transactions, key=lambda t: (t["date"], t["id"]))


def _adjacent_runs(transactions: list[Transaction]) -> Iterator[list[Transaction]]:
    """Splits date-sorted transactions wherever the gap is too wide for them to be copies."""
    run: list[Transaction] = []
    for t in transactions:
        if run and (_day(t) - _day(run[-1])).days > _DUPLICATE_MAX_GAP_DAYS:
            yield run
            run = []
        run.append(t)
    if run:
        yield run


def _copies_in(run: list[Transaction]) -> Iterator[list[Transaction]]:
    """
    A run over three or more dates is a habit, like the same coffee every morning, so only repeats on
    one date in it count. Over one or two dates, the whole run does.
    """
    by_date: dict[str, list[Transaction]] = defaultdict(list)
    for t in run:
        by_date[t["date"]].append(t)
    if len(by_date) > _DUPLICATE_MAX_GAP_DAYS + 1:
        yield from by_date.values()
    else:
        yield run


def _possible_duplicates(transactions: Iterable[Transaction], today: date) -> Iterator[PossibleDuplicate]:
    earliest = (today - _DUPLICATE_WINDOW).isoformat()
    groups: dict[tuple[str, str, int], list[Transaction]] = defaultdict(list)
    for t in transactions:
        if t["date"] >= earliest:
            groups[(_series_key(t), merchant_key(t["item"]), t["amountCents"])].append(t)
    for group in groups.values():
        for run in _adjacent_runs(_oldest_first(group)):
            for copies in _copies_in(run):
                if len(copies) > 1:
                    first = copies[0]
                    yield PossibleDuplicate(
                        id=insight_id("possible_duplicate|" + "|".join(t["id"] for t in copies)),
                        type="possible_duplicate",
                        merchant=_display_name(first),
                        amountCents=first["amountCents"],
                        currency=first["currency"],
                        transactions=copies,
                    )


def _latest_run(charges: list[Transaction], gap_days: range) -> list[Transaction]:
    """The newest charges, oldest first, each the cadence's gap after the one before."""
    run = charges[-1:]
    for t in reversed(charges[:-1]):
        if (_day(run[0]) - _day(t)).days not in gap_days:
            break
        run.insert(0, t)
    return run


def _is_price_rise(amounts: list[int], cadence: _Cadence) -> bool:
    """A bill that varies has no repeated amount, or falls as often as it rises; a yearly one has too few to tell."""
    rising = amounts == sorted(amounts) and amounts[-1] > amounts[0]
    return rising and (cadence.name == "yearly" or len(set(amounts)) < len(amounts))


def _price_rise(key: str, charges: list[Transaction], today: date) -> PriceRise | None:
    latest = charges[-1]
    if latest["category"] in _NOT_SUBSCRIPTIONS:
        return None
    for cadence in _CADENCES:
        run = _latest_run(charges, cadence.gap_days)
        amounts = [t["amountCents"] for t in run]
        current = (today - _day(latest)).days <= cadence.current_for_days
        if len(run) >= cadence.minimum_charges and current and _is_price_rise(amounts, cadence):
            return PriceRise(
                id=insight_id(f"price_rise|{key}|{amounts[-1]}"),
                type="price_rise",
                merchant=_display_name(latest),
                previousCents=amounts[0],
                currentCents=amounts[-1],
                since=next(t["date"] for t in run if t["amountCents"] == amounts[-1]),
                cadence=cadence.name,
                extraPerYearCents=(amounts[-1] - amounts[0]) * cadence.charges_per_year,
                currency=latest["currency"],
                transactions=run[::-1],
            )
    return None


def _price_rises(transactions: Iterable[Transaction], today: date) -> Iterator[PriceRise]:
    series: dict[str, list[Transaction]] = defaultdict(list)
    for t in _oldest_first(transactions):
        series[_series_key(t)].append(t)
    for key, charges in series.items():
        rise = _price_rise(key, charges, today)
        if rise:
            yield rise


def _is_rego(t: Transaction) -> bool:
    return bool(_REGO.search(" ".join([t["item"], t.get("merchant", ""), t.get("note", "")]).casefold()))


def _plus_months(day: date, months: int) -> date:
    """The same day of the month, or the month's last day if it has no such day."""
    year, month = divmod(day.year * 12 + day.month - 1 + months, 12)
    return date(year, month + 1, min(day.day, monthrange(year, month + 1)[1]))


def _rego_term_months(payments: list[Transaction]) -> int:
    """Rego can be paid for 3 or 6 months; the last two payments show which, and otherwise it's a year."""
    if len(payments) > 1:
        gap = (_day(payments[-1]) - _day(payments[-2])).days
        for days, months in _REGO_TERMS_MONTHS:
            if gap in days:
                return months
    return _REGO_DEFAULT_TERM_MONTHS


def _rego_due(transactions: Iterable[Transaction], today: date) -> Iterator[RegoDue]:
    payments = _oldest_first(t for t in transactions if _is_rego(t))
    if not payments:
        return
    latest = payments[-1]
    due = _plus_months(_day(latest), _rego_term_months(payments))
    if abs((due - today).days) <= _REGO_WINDOW_DAYS:
        yield RegoDue(
            id=insight_id(f"rego_due|{latest['id']}"),
            type="rego_due",
            estimatedDueDate=due.isoformat(),
            lastPaidCents=latest["amountCents"],
            currency=latest["currency"],
            transactions=[latest],
        )


def find_insights(transactions: Collection[Transaction], today: date, dismissed: Collection[str]) -> list[Insight]:
    """
    Everything needing attention, the most pressing kind first, less what the customer has dismissed.
    An insight's ID changes when its facts do, so a dismissed one returns only if there's something new.
    """
    found: list[Insight] = [
        *_rego_due(transactions, today),
        *_possible_duplicates(transactions, today),
        *_price_rises(transactions, today),
    ]
    return [insight for insight in found if insight["id"] not in dismissed]
