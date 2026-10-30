from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError

from ledger_api.log import Logger
from ledger_api.log import log as default_log
from ledger_api.notify.emails import EmailSettings, emails_for


@dataclass(frozen=True)
class OutgoingEmail:
    # The From address, in the domain SES has verified.
    sender: str
    to: str
    subject: str
    text: str


type SendEmail = Callable[[OutgoingEmail], None]
type BatchResponse = dict[str, list[dict[str, str]]]

# SES refuses these for good (an unverified recipient in the sandbox, a malformed address), so a retry can't help.
PERMANENT_ERRORS = frozenset({"MessageRejected", "BadRequestException"})

_deserializer = TypeDeserializer()


def _image(attributes: dict[str, Any] | None) -> dict[str, Any] | None:
    return {k: _deserializer.deserialize(v) for k, v in attributes.items()} if attributes else None


def _error_name(err: Exception) -> str:
    return str(err.response.get("Error", {}).get("Code")) if isinstance(err, ClientError) else type(err).__name__


def _error_message(err: Exception) -> str:
    return str(err.response.get("Error", {}).get("Message", "")) if isinstance(err, ClientError) else str(err)


def create_notify_handler(
    *, sender: str, settings: EmailSettings, send_email: SendEmail, log: Logger = default_log
) -> Callable[[dict[str, Any]], BatchResponse]:
    """
    Reads the Users table's stream and sends the account emails. Records are handled in order. An
    email SES refuses outright is logged and skipped. On any other failed send it reports that record,
    so the stream retries from there (and the records after it come again with it), until the retries
    run out and the batch goes to the failure queue. A retried sign-up sends both of its emails again,
    so one can arrive twice.
    """

    def handler(event: dict[str, Any]) -> BatchResponse:
        for record in event.get("Records", []):
            change = record.get("dynamodb", {})
            for email in emails_for(_image(change.get("OldImage")), _image(change.get("NewImage")), settings):
                try:
                    send_email(OutgoingEmail(sender=sender, to=email.to, subject=email.subject, text=email.text))
                    log({"event": "email_sent", "kind": email.kind, "userId": email.user_id}, "info")
                except Exception as err:
                    # SES names the recipient in some errors; keep the address out of the logs.
                    error = {"name": _error_name(err), "message": _error_message(err).replace(email.to, "[email]")}
                    if error["name"] in PERMANENT_ERRORS:
                        log(
                            {"event": "email_rejected", "kind": email.kind, "userId": email.user_id, "error": error},
                            "error",
                        )
                        continue
                    log(
                        {"event": "notify_failed", "kind": email.kind, "userId": email.user_id, "error": error}, "error"
                    )
                    return {"batchItemFailures": [{"itemIdentifier": str(change.get("SequenceNumber", ""))}]}
        return {"batchItemFailures": []}

    return handler
