import json

import pytest

from ledger_api.log import log, redact


class TestRedact:
    class TestGivenAnEntryWithSecretsAndAddresses:
        def test_replaces_them_at_any_depth_whatever_the_keys_case(self) -> None:
            entry = {
                "event": "x",
                "Password": "pw",
                "user": {"email": "haoran@example.com", "username": "haoran"},
                "items": [{"refreshToken": "rt"}, {"authorization": "Bearer t"}],
            }

            assert redact(entry) == {
                "event": "x",
                "Password": "[REDACTED]",
                "user": {"email": "[REDACTED]", "username": "haoran"},
                "items": [{"refreshToken": "[REDACTED]"}, {"authorization": "[REDACTED]"}],
            }

    class TestGivenAnException:
        def test_keeps_its_name_and_message(self) -> None:
            assert redact({"error": ValueError("bad input")})["error"] == {"name": "ValueError", "message": "bad input"}


class TestLog:
    class TestGivenAnInfoEntry:
        def test_writes_it_redacted_as_one_json_line_to_stdout(self, capsys: pytest.CaptureFixture[str]) -> None:
            log({"event": "email_sent", "email": "haoran@example.com"})

            out, err = capsys.readouterr()
            assert json.loads(out) == {"event": "email_sent", "email": "[REDACTED]"}
            assert err == ""

    class TestGivenAnErrorEntry:
        def test_writes_it_to_stderr(self, capsys: pytest.CaptureFixture[str]) -> None:
            log({"event": "notify_failed"}, "error")

            out, err = capsys.readouterr()
            assert out == ""
            assert json.loads(err) == {"event": "notify_failed"}
