import base64
import json

import pytest

from ledger_api.data.cursor import InvalidCursorError, cursor_secret_from, decode_cursor, encode_cursor

KEY = {"pk": "USER#u1", "sk": "TXN#2026-10-26#01ARZ3NDEKTSV4RRFFQ69G5FAV", "gsi2sk": "菜"}

# Made by src/data/cursor.ts: cursorSecretFrom("test-signing-secret"), then encodeCursor(KEY, secret).
TS_SECRET = "fbEzLSx-YHtLwKggbvVBROO1E0x42UpBTiStJpnngeA"
TS_CURSOR = (
    "eyJwayI6IlVTRVIjdTEiLCJzayI6IlRYTiMyMDI2LTEwLTI2IzAxQVJaM05ERUtUU1Y0UlJGRlE2OUc1RkFWIiwiZ3NpMnNrIjoi6I-cIn0"
    ".ZmHrqan5tYwqgvSIUyrWfTumye8jHSbFVGKtaQLcjcs"
)


class TestGivenAListCursor:
    def test_decodes_back_to_the_dynamodb_key_it_was_made_from(self) -> None:
        assert decode_cursor(encode_cursor(KEY, "secret"), "secret") == KEY

    def test_is_rejected_when_its_contents_are_changed(self) -> None:
        _, signature = encode_cursor(KEY, "secret").split(".")
        forged = base64.urlsafe_b64encode(json.dumps({**KEY, "pk": "USER#someone-else"}).encode()).rstrip(b"=")

        with pytest.raises(InvalidCursorError):
            decode_cursor(f"{forged.decode()}.{signature}", "secret")

    def test_is_rejected_when_signed_with_another_secret(self) -> None:
        with pytest.raises(InvalidCursorError):
            decode_cursor(encode_cursor(KEY, "other"), "secret")

    @pytest.mark.parametrize("cursor", ["", "garbage", "a.b.c", "!!!.???"])
    def test_rejects_a_malformed_cursor(self, cursor: str) -> None:
        with pytest.raises(InvalidCursorError):
            decode_cursor(cursor, "secret")


class TestGivenTheTypeScriptCursors:
    def test_derives_the_same_cursor_key_from_the_signing_secret(self) -> None:
        assert cursor_secret_from("test-signing-secret") == TS_SECRET

    def test_encodes_a_key_exactly_as_typescript_does(self) -> None:
        assert encode_cursor(KEY, TS_SECRET) == TS_CURSOR

    def test_decodes_a_typescript_cursor(self) -> None:
        assert decode_cursor(TS_CURSOR, TS_SECRET) == KEY
