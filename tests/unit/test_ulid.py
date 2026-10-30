from datetime import UTC, datetime

import pytest

from ledger_api.data.ulid import is_ulid, new_ulid, ulid_time

# From the ulid library's README: ulid(1469918176385) -> "01ARYZ6S41TSV4RRFFQ69G5FAV".
SPEC_EXAMPLE = "01ARYZ6S41TSV4RRFFQ69G5FAV"


class TestGivenAULID:
    def test_accepts_a_well_formed_one(self) -> None:
        assert is_ulid(SPEC_EXAMPLE)

    def test_reads_the_creation_time_from_its_first_10_characters(self) -> None:
        assert ulid_time(SPEC_EXAMPLE) == datetime.fromtimestamp(1469918176.385, UTC)

    @pytest.mark.parametrize(
        "value",
        [
            pytest.param("01ARZ3NDEKTSV4RRFFQ69G5FA", id="too short"),
            pytest.param("01ARZ3NDEKTSV4RRFFQ69G5FAVX", id="too long"),
            pytest.param("01ARZ3NDEKTSV4RRFFQ69G5FAU", id="with a letter Crockford base32 excludes (U)"),
            pytest.param("01arz3ndektsv4rrffq69g5fav", id="lowercase"),
            pytest.param("81ARZ3NDEKTSV4RRFFQ69G5FAV", id="beyond the largest timestamp (starts with 8)"),
            pytest.param("01ARZ3NDEKTSV4RRFFQ69G5FAV\n", id="with a trailing newline"),
        ],
    )
    def test_rejects_a_malformed_one(self, value: str) -> None:
        assert not is_ulid(value)


class TestNewUlid:
    def test_makes_a_ulid_that_reads_back_its_time_to_the_millisecond(self) -> None:
        at = datetime(2026, 10, 30, 1, 2, 3, 456000, tzinfo=UTC)

        ulid = new_ulid(at)

        assert is_ulid(ulid)
        assert ulid_time(ulid) == at
