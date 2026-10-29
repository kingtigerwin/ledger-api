from dataclasses import dataclass
from typing import Any, Literal

type EmailKind = Literal["pending", "approved", "new_signup"]
type Item = dict[str, Any] | None


@dataclass(frozen=True)
class Email:
    kind: EmailKind
    # The customer the email is about, whoever it goes to.
    user_id: str
    to: str
    subject: str
    text: str


@dataclass(frozen=True)
class EmailSettings:
    # The API's public URL, for the admin's approve and reject calls when there's no admin page.
    api_url: str
    # Where sign-ups are sent for approval; without it only customers are emailed.
    admin_email: str | None = None
    # ledger-ui's admin page, where the admin approves or rejects sign-ups from a browser.
    admin_page_url: str | None = None


def emails_for(before: Item, after: Item, settings: EmailSettings) -> list[Email]:
    """
    The emails a change to a Users-table item calls for. A customer who has just registered hears
    they're waiting for approval, and the admin is asked to approve or reject them; the customer
    hears again when first enabled. Re-enabling a disabled customer sends nothing, and customers
    without an email are never written to.
    """
    if not after or after.get("sk") != "PROFILE" or after.get("role") != "customer":
        return []
    user_id = str(after["id"])
    username = str(after["username"])
    customer_email = after.get("email") if isinstance(after.get("email"), str) else None
    emails: list[Email] = []

    if not before and after.get("status") == "pending":
        # The admin's first, so a customer's address SES won't take can't hold it up.
        if settings.admin_email:
            user = f"{settings.api_url}/api/v1/admin/users/{user_id}"
            review = (
                f"Approve or reject them on the admin page, under Pending:\n\n  {settings.admin_page_url}\n\n"
                if settings.admin_page_url
                else "Signed in as an admin, either:\n\n"
                f"  Approve:  POST {user}/enable\n"
                f"  Reject:   POST {user}/disable\n\n"
            )
            emails.append(
                Email(
                    kind="new_signup",
                    user_id=user_id,
                    to=settings.admin_email,
                    subject=f"New Ledger sign-up: {username} is waiting for approval",
                    text=(
                        f"{username} has signed up to Ledger and is waiting for approval.\n\n"
                        f"  Username: {username}\n"
                        f"  Email:    {customer_email or '(none)'}\n"
                        f"  User ID:  {user_id}\n\n"
                        f"{review}"
                        "Approving emails them that they can sign in. Rejecting sends them nothing.\n"
                    ),
                )
            )
        if customer_email:
            emails.append(
                Email(
                    kind="pending",
                    user_id=user_id,
                    to=customer_email,
                    subject="Your Ledger account is waiting for approval",
                    text=(
                        f"Hi {username},\n\n"
                        "Thanks for signing up to Ledger. Your account has been created and is waiting for an admin "
                        "to approve it.\n\n"
                        "We'll email you again as soon as you can sign in.\n"
                    ),
                )
            )
    if before and before.get("status") == "pending" and after.get("status") == "active" and customer_email:
        emails.append(
            Email(
                kind="approved",
                user_id=user_id,
                to=customer_email,
                subject="Your Ledger account is approved",
                text=f"Hi {username},\n\nYour Ledger account has been approved. You can now sign in as {username}.\n",
            )
        )
    return emails
