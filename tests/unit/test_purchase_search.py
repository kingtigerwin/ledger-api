from typing import Any, ClassVar

import pytest

from ledger_api.data.purchase_search import MAX_MATCHES, find_purchases
from ledger_api.data.schemas import Transaction


def txn(id: str, on: str = "2026-11-01", amount_cents: int = 1000, **overrides: Any) -> Transaction:
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


def scanned(id: str, *lines: tuple[str, str | None, int], **fields: Any) -> Transaction:
    built = [
        {"name": name, "amountCents": cents} | ({"product": product} if product else {})
        for name, product, cents in lines
    ]
    return txn(id, item=f"{len(lines)} items", receipt={"totalCents": 1000, "lines": built, **fields})


COLES = scanned(
    "coles",
    ("BANANAS PERKG", "bananas", 284),
    ("CLS CHKN DRUMSTICKS 2KG", "chicken drumsticks", 770),
    ("BANDANA", "headscarf", 500),
)


class TestMatching:
    @pytest.mark.parametrize(
        ("term", "names"),
        [
            pytest.param("banana", ["BANANAS PERKG"], id="the-start-of-a-word"),
            pytest.param("BANANA", ["BANANAS PERKG"], id="any-case"),
            pytest.param("chicken", ["CLS CHKN DRUMSTICKS 2KG"], id="the-plain-product-name"),
            pytest.param("chkn", ["CLS CHKN DRUMSTICKS 2KG"], id="the-printed-name"),
            pytest.param("drumsticks", ["CLS CHKN DRUMSTICKS 2KG"], id="a-later-word"),
            pytest.param("ana", [], id="not-the-middle-of-a-word"),
            pytest.param("bananas perkg", ["BANANAS PERKG"], id="several-words"),
            pytest.param("kiwi", [], id="nothing-bought"),
        ],
    )
    def test_finds_the_lines_it_should(self, term: str, names: list[str]) -> None:
        found = find_purchases([COLES], [term])

        assert [match["name"] for match in found["matches"]] == names

    def test_a_chinese_term_matches_anywhere(self) -> None:
        receipt = scanned("tan-hung", ("新鲜香蕉", None, 392))

        assert find_purchases([receipt], ["香蕉"])["count"] == 1

    def test_several_terms_find_one_line_once(self) -> None:
        receipt = scanned("two", ("BANANAS", "bananas 香蕉", 392))

        found = find_purchases([receipt], ["banana", "香蕉"])

        assert (found["count"], found["totalCents"]) == (1, 392)

    def test_punctuation_in_a_term_is_plain_text(self) -> None:
        receipt = scanned("odd", ("SPRING ONION (B&R) 2/3.5", None, 350))

        assert find_purchases([receipt], ["(b&r)"])["count"] == 1


class TestGivenAnExpenseTypedIntoTheChat:
    def test_searches_its_item(self) -> None:
        found = find_purchases([txn("typed", item="bananas", amount_cents=300)], ["banana"])

        assert found["matches"] == [
            {"transactionId": "typed", "date": "2026-11-01", "merchant": "Coles", "name": "bananas", "amountCents": 300}
        ]

    def test_has_no_merchant_when_none_was_given(self) -> None:
        found = find_purchases([txn("typed", item="bananas", merchant=None)], ["banana"])

        assert found["matches"][0]["merchant"] is None


class TestGivenAScannedReceipt:
    def test_a_one_line_receipt_counts_once_though_its_item_names_the_line(self) -> None:
        lines = [{"name": "B.BARRAMUNDI", "product": "barramundi", "amountCents": 1774}]
        one_line = txn("one", item="barramundi", receipt={"totalCents": 1774, "lines": lines})

        assert find_purchases([one_line], ["barramundi"])["count"] == 1

    def test_its_item_of_18_items_is_not_searched(self) -> None:
        assert find_purchases([COLES], ["items"])["count"] == 0

    def test_a_discount_line_comes_off_the_total(self) -> None:
        receipt = scanned("deal", ("BANANAS", None, 400), ("BANANA DISCOUNT", None, -100))

        assert find_purchases([receipt], ["banana"])["totalCents"] == 300


class TestTotals:
    def test_adds_up_every_match_across_transactions(self) -> None:
        found = find_purchases([COLES, txn("typed", item="bananas", amount_cents=300)], ["banana"])

        assert (found["count"], found["totalCents"], found["currency"]) == (2, 584, "AUD")

    def test_keeps_the_order_it_was_given_which_is_newest_first(self) -> None:
        found = find_purchases(
            [txn("new", "2026-11-02", item="bananas"), txn("old", "2026-11-01", item="bananas")], ["banana"]
        )

        assert [match["transactionId"] for match in found["matches"]] == ["new", "old"]

    def test_finds_nothing_with_no_transactions(self) -> None:
        assert find_purchases([], ["banana"]) == {
            "matches": [],
            "count": 0,
            "totalCents": 0,
            "currency": "AUD",
            "includesPoints": False,
        }

    def test_returns_only_so_many_lines_but_counts_them_all(self) -> None:
        many = [txn(str(i), item="bananas", amount_cents=100) for i in range(MAX_MATCHES + 5)]

        found = find_purchases(many, ["banana"])

        assert len(found["matches"]) == MAX_MATCHES
        assert (found["count"], found["totalCents"]) == (MAX_MATCHES + 5, (MAX_MATCHES + 5) * 100)


class TestPoints:
    POINTS: ClassVar[dict[str, Any]] = {
        "payments": [
            {"label": "Flybuys value redeemed", "kind": "points", "amountCents": 900},
            {"label": "EFT", "kind": "money", "amountCents": 100},
        ]
    }

    def test_says_when_a_match_was_paid_partly_with_points(self) -> None:
        receipt = scanned("points", ("BANANAS", None, 284), **self.POINTS)

        assert find_purchases([receipt], ["banana"])["includesPoints"] is True

    def test_points_on_a_receipt_that_didnt_match_dont_count(self) -> None:
        receipt = scanned("points", ("BREAD", None, 284), **self.POINTS)

        assert find_purchases([receipt], ["banana"])["includesPoints"] is False
