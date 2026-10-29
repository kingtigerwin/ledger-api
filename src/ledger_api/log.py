"""The one place log lines are written, so secrets and email addresses are stripped no matter who logs what."""

import json
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Literal, cast

SECRET_KEYS = frozenset(
    {"password", "passwordhash", "refreshtoken", "accesstoken", "authorization", "cookie", "cookies", "email"}
)

type LogEntry = dict[str, Any]
type Level = Literal["info", "error"]
type Logger = Callable[[LogEntry, Level], None]


def redact(value: Any) -> Any:
    """A copy of value with every secret key's value replaced, at any depth, whatever the key's case."""
    if isinstance(value, BaseException):
        return {"name": type(value).__name__, "message": str(value)}
    if isinstance(value, list | tuple):
        return [redact(v) for v in cast(Sequence[Any], value)]
    if isinstance(value, Mapping):
        items = cast(Mapping[str, Any], value).items()
        return {key: "[REDACTED]" if key.lower() in SECRET_KEYS else redact(v) for key, v in items}
    return value


def log(entry: LogEntry, level: Level = "info") -> None:
    """Writes one JSON line, the same shape as the TypeScript Lambdas', so Logs Insights finds the same fields."""
    line: str = json.dumps(redact(entry), default=str)
    print(line, file=sys.stderr if level == "error" else sys.stdout, flush=True)
