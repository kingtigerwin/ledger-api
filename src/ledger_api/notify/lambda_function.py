import os
from typing import TYPE_CHECKING, Any

import boto3

from ledger_api.notify.emails import EmailSettings
from ledger_api.notify.handler import BatchResponse, OutgoingEmail, create_notify_handler

if TYPE_CHECKING:
    # Dev-only stubs; the Lambda runtime has boto3 but not these.
    from mypy_boto3_sesv2 import SESV2Client

# Only some services' stubs are installed, so boto3.client's overloads for the rest are unknown to pyright.
_ses: "SESV2Client" = boto3.client("sesv2")  # pyright: ignore[reportUnknownMemberType]


def _send_email(email: OutgoingEmail) -> None:
    _ses.send_email(
        FromEmailAddress=email.sender,
        Destination={"ToAddresses": [email.to]},
        Content={
            "Simple": {
                "Subject": {"Data": email.subject, "Charset": "UTF-8"},
                "Body": {"Text": {"Data": email.text, "Charset": "UTF-8"}},
            }
        },
    )


_notify = create_notify_handler(
    sender=os.environ["EMAIL_FROM"],
    settings=EmailSettings(
        api_url=os.environ["API_URL"],
        admin_email=os.environ.get("ADMIN_EMAIL") or None,
        admin_page_url=os.environ.get("ADMIN_PAGE_URL") or None,
    ),
    send_email=_send_email,
)


def handler(event: dict[str, Any], context: Any) -> BatchResponse:
    return _notify(event)
