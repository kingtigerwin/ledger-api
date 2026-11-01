from datetime import date, timedelta
from typing import Any

import pytest

from ledger_api.data.insights import find_insights, insight_id, merchant_key
from ledger_api.data.schemas import Transaction

TODAY = date(2026, 11, 1)


def days_ago(days: int) -> str:
    return (TODAY - timedelta(days=days)).isoformat()


def txn(id: str, on: str, amount_cents: int = 1000, **overrides: Any) -> Transaction:
    fields: dict[str, Any] = {
        "id": id,
        "date": on,
        "merchant": "Coles",
        "category": "groceries",
        "item": "cake",
        "amountCents": amount_cents,
        "currency": "AUD",
        "version": 1,
        "createdAt": f"{on}T00:00:00.000Z",
        "updatedAt": f"{on}T00:00:00.000Z",
        **overrides,
    }
    if fields["merchant"] is None:
        del fields["merchant"]
    return Transaction(**fields)


def monthly(merchant: str, amounts: list[int], **overrides: Any) -> list[Transaction]:
    """Charges 30 days apart, oldest amount first, the last of them 5 days ago."""
    return [
        txn(f"{merchant}-{i}", days_ago(5 + 30 * (len(amounts) - 1 - i)), amount, merchant=merchant, **overrides)
        for i, amount in enumerate(amounts)
    ]


def subscription(amounts: list[int]) -> list[Transaction]:
    return monthly("Netflix", amounts, category="entertainment", item="subscription")


def insights(transactions: list[Transaction], dismissed: set[str] | None = None) -> list[dict[str, Any]]:
    return [dict(found) for found in find_insights(transactions, TODAY, dismissed or set())]


def types(found: list[dict[str, Any]]) -> list[str]:
    return [insight["type"] for insight in found]


class TestMerchantKey:
    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            pytest.param("Netflix", "netflix", id="case"),
            pytest.param("  NET-FLIX. ", "netflix", id="punctuation-and-spaces"),
            pytest.param("Netflix Pty Ltd", "netflix", id="company-suffix"),
            pytest.param("netflix.com", "netflix", id="domain-suffix"),
            pytest.param("\uff2e\uff45\uff54\uff46\uff4c\uff49\uff58", "netflix", id="full-width-letters"),
            pytest.param("奈飞", "奈飞", id="chinese-kept"),
        ],
    )
    def test_writes_of_one_merchant_share_a_key(self, name: str, expected: str) -> None:
        assert merchant_key(name) == expected


class TestInsightId:
    def test_is_16_hex_characters_and_stable(self) -> None:
        assert insight_id("rego_due|01A") == insight_id("rego_due|01A")
        assert len(insight_id("rego_due|奈飞")) == 16
        assert set(insight_id("rego_due|奈飞")) <= set("0123456789abcdef")


class TestGivenNoTransactions:
    def test_finds_nothing(self) -> None:
        assert insights([]) == []


class TestPossibleDuplicates:
    class TestGivenTheSameExpenseTwiceOnOneDay:
        def test_shows_one_card_with_both_transactions(self) -> None:
            a, b = txn("a", days_ago(2)), txn("b", days_ago(2))

            [card] = insights([a, b])

            assert card["type"] == "possible_duplicate"
            assert (card["merchant"], card["amountCents"], card["currency"]) == ("Coles", 1000, "AUD")
            assert [t["id"] for t in card["transactions"]] == ["a", "b"]

    class TestGivenTheSameExpenseOnAdjacentDays:
        def test_shows_a_card_since_yesterday_is_easily_misrecorded(self) -> None:
            assert types(insights([txn("a", days_ago(3)), txn("b", days_ago(2))])) == ["possible_duplicate"]

    class TestGivenThreeCopies:
        def test_shows_one_card_with_all_three(self) -> None:
            [card] = insights([txn(id, days_ago(2)) for id in "abc"])

            assert len(card["transactions"]) == 3

    class TestGivenTheSameExpenseWithoutAMerchant:
        def test_matches_on_the_item(self) -> None:
            [card] = insights([txn(id, days_ago(1), merchant=None) for id in "ab"])

            assert card["merchant"] == "cake"

    @pytest.mark.parametrize(
        "other",
        [
            pytest.param(txn("b", days_ago(2), 1001), id="different-amount"),
            pytest.param(txn("b", days_ago(2), merchant="Woolworths"), id="different-merchant"),
            pytest.param(txn("b", days_ago(2), item="bread"), id="different-item"),
            pytest.param(txn("b", days_ago(4)), id="two-days-apart"),
        ],
    )
    def test_near_misses_show_nothing(self, other: Transaction) -> None:
        assert insights([txn("a", days_ago(2)), other]) == []

    class TestGivenBothOlderThan30Days:
        def test_shows_nothing(self) -> None:
            assert insights([txn("a", days_ago(31)), txn("b", days_ago(31))]) == []

    class TestGivenADailyHabit:
        def test_three_dates_in_a_row_are_not_a_duplicate(self) -> None:
            assert insights([txn(id, days_ago(i)) for i, id in enumerate("abc", start=1)]) == []

        def test_a_real_repeat_within_the_habit_still_shows_alone(self) -> None:
            habit = [txn(id, days_ago(i)) for i, id in enumerate("abc", start=1)]

            [card] = insights([*habit, txn("d", days_ago(2))])

            assert sorted(t["id"] for t in card["transactions"]) == ["b", "d"]

    class TestGivenADismissedCard:
        def test_it_stays_away_until_another_copy_is_recorded(self) -> None:
            pair = [txn("a", days_ago(2)), txn("b", days_ago(2))]
            [card] = insights(pair)

            assert insights(pair, {card["id"]}) == []
            assert len(insights([*pair, txn("c", days_ago(2))], {card["id"]})) == 1


class TestPriceRises:
    class TestGivenAMonthlySubscriptionThatWentUp:
        def test_shows_the_old_and_new_price_and_the_yearly_cost(self) -> None:
            charges = subscription([1699, 1699, 2099])

            [card] = insights(charges)

            assert card["type"] == "price_rise"
            assert card["merchant"] == "Netflix"
            assert (card["previousCents"], card["currentCents"]) == (1699, 2099)
            assert (card["cadence"], card["extraPerYearCents"]) == ("monthly", 4800)
            assert card["since"] == days_ago(5)
            assert [t["id"] for t in card["transactions"]] == ["Netflix-2", "Netflix-1", "Netflix-0"]

    class TestGivenTheRiseIsOlderThanTheLatestCharge:
        def test_since_is_the_first_charge_at_the_new_price(self) -> None:
            [card] = insights(subscription([1699, 2099, 2099]))

            assert card["since"] == days_ago(35)

    class TestGivenAYearlyCharge:
        def test_two_charges_are_enough(self) -> None:
            charges = [
                txn("a", days_ago(370), 9900, merchant="Dropbox", category="other", item="plan"),
                txn("b", days_ago(5), 11900, merchant="Dropbox", category="other", item="plan"),
            ]

            [card] = insights(charges)

            assert (card["cadence"], card["extraPerYearCents"]) == ("yearly", 2000)

    @pytest.mark.parametrize(
        "charges",
        [
            pytest.param(subscription([1699, 2099]), id="only-two-monthly-charges"),
            pytest.param(subscription([1699, 1699, 1699]), id="price-unchanged"),
            pytest.param(subscription([2099, 2099, 1699]), id="price-fell"),
            pytest.param(subscription([3000, 4100, 5500]), id="varying-bill-with-no-repeat"),
            pytest.param(monthly("Coles", [1699, 1699, 2099]), id="groceries-excluded"),
            pytest.param(monthly("Pasta Bar", [1699, 1699, 2099], category="dining"), id="dining-excluded"),
        ],
    )
    def test_not_a_price_rise(self, charges: list[Transaction]) -> None:
        assert insights(charges) == []

    class TestGivenTheSubscriptionHasStopped:
        def test_shows_nothing(self) -> None:
            charges = [txn(f"n{i}", days_ago(46 + 30 * (2 - i)), a, category="other") for i, a in enumerate([9, 9, 12])]

            assert insights(charges) == []

    class TestGivenAWeeklyHabitAtTheSameMerchant:
        def test_the_timing_rules_it_out(self) -> None:
            shops = [txn(str(i), days_ago(5 + 7 * i), 1000 + i, category="other", item=f"i{i}") for i in range(8)]

            assert insights(shops) == []

    class TestGivenADismissedRise:
        def test_a_further_rise_brings_it_back(self) -> None:
            [card] = insights(subscription([1699, 1699, 2099]))

            assert insights(subscription([1699, 1699, 2099]), {card["id"]}) == []
            assert len(insights(subscription([1699, 1699, 2299]), {card["id"]})) == 1


class TestRegoDue:
    @staticmethod
    def rego(id: str, on: str, **overrides: Any) -> Transaction:
        fields = {"merchant": "Service NSW", "category": "transport", "item": "car rego", **overrides}
        return txn(id, on, 89000, **fields)

    class TestGivenALastPaymentNearlyAYearAgo:
        def test_estimates_the_due_date_a_year_on(self) -> None:
            last = TestRegoDue.rego("a", "2025-11-14")

            [card] = insights([last])

            assert card["type"] == "rego_due"
            assert (card["estimatedDueDate"], card["lastPaidCents"], card["currency"]) == ("2026-11-14", 89000, "AUD")
            assert [t["id"] for t in card["transactions"]] == ["a"]

    @pytest.mark.parametrize(
        ("paid", "shows"),
        [
            pytest.param("2025-12-01", True, id="30-days-ahead"),
            pytest.param("2025-12-02", False, id="31-days-ahead"),
            pytest.param("2025-10-02", True, id="30-days-overdue"),
            pytest.param("2025-10-01", False, id="31-days-overdue"),
        ],
    )
    def test_shows_only_within_30_days_of_the_estimate(self, paid: str, shows: bool) -> None:
        assert bool(insights([TestRegoDue.rego("a", paid)])) is shows

    @pytest.mark.parametrize(
        "fields",
        [
            pytest.param({"item": "REGO renewal"}, id="uppercase"),
            pytest.param({"item": "registration", "merchant": "car registration"}, id="merchant"),
            pytest.param({"item": "fee", "note": "vehicle registration"}, id="note"),
            pytest.param({"item": "CTP"}, id="ctp"),
            pytest.param({"item": "green slip"}, id="green-slip"),
            pytest.param({"item": "车辆注册"}, id="chinese"),
            pytest.param({"item": "车辆rego费"}, id="beside-chinese"),
        ],
    )
    def test_recognises_the_payment(self, fields: dict[str, str]) -> None:
        assert types(insights([TestRegoDue.rego("a", "2025-11-14", **fields)])) == ["rego_due"]

    @pytest.mark.parametrize(
        "item",
        [
            pytest.param("Gregory's birthday", id="word-containing-rego"),
            pytest.param("course registration", id="registration-alone"),
            pytest.param("Oregon trip", id="oregon"),
        ],
    )
    def test_ignores_lookalikes(self, item: str) -> None:
        assert insights([TestRegoDue.rego("a", "2025-11-14", item=item, merchant="Shop")]) == []

    class TestGivenPaymentsEverySixMonths:
        def test_estimates_six_months_on_from_the_latest(self) -> None:
            payments = [TestRegoDue.rego("a", "2025-11-14"), TestRegoDue.rego("b", "2026-05-14")]

            [card] = insights(payments)

            assert card["estimatedDueDate"] == "2026-11-14"
            assert [t["id"] for t in card["transactions"]] == ["b"]

    class TestGivenPaymentsEveryThreeMonths:
        def test_estimates_three_months_on_from_the_latest(self) -> None:
            payments = [TestRegoDue.rego("a", "2026-05-14"), TestRegoDue.rego("b", "2026-08-14")]

            [card] = insights(payments)

            assert card["estimatedDueDate"] == "2026-11-14"

    class TestGivenThisYearsPaymentIsRecorded:
        def test_the_card_clears(self) -> None:
            payments = [TestRegoDue.rego("a", "2025-11-14"), TestRegoDue.rego("b", days_ago(1))]

            assert "rego_due" not in types(insights(payments))

    class TestGivenALeapDayPayment:
        def test_the_estimate_lands_on_the_last_day_of_february(self) -> None:
            last = TestRegoDue.rego("a", "2024-02-29")

            [card] = [dict(found) for found in find_insights([last], date(2025, 2, 20), set())]

            assert card["estimatedDueDate"] == "2025-02-28"

    class TestGivenADismissedCard:
        def test_it_returns_only_after_the_next_payment(self) -> None:
            last = TestRegoDue.rego("a", "2025-11-14")
            [card] = insights([last])

            assert insights([last], {card["id"]}) == []


class TestOrder:
    def test_rego_then_duplicates_then_price_rises(self) -> None:
        everything = [
            *subscription([1699, 1699, 2099]),
            txn("a", days_ago(2)),
            txn("b", days_ago(2)),
            TestRegoDue.rego("c", "2025-11-14"),
        ]

        assert types(insights(everything)) == ["rego_due", "possible_duplicate", "price_rise"]
