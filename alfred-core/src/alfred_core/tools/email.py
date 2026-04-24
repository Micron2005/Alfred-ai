"""Outgoing email via Gmail SMTP (app-password auth).

We use plain SMTP rather than the Gmail API to keep onboarding to a
single secret: an app password generated at
https://myaccount.google.com/apppasswords. No OAuth round-trip, no
client secrets, no token storage. The downside is that the user must
have 2-step verification enabled on their Google account, but that's
already a sensible baseline.

Sending is intentionally synchronous and fail-fast — we want the LLM
to receive a concrete success/failure signal rather than a fire-and-
forget queue. Async callers must offload via ``asyncio.to_thread`` so
this blocking I/O does not stall the event loop.
"""

from __future__ import annotations

import logging
import re
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr

from alfred_core.config import Settings

# Pragmatic, intentionally permissive. We're not trying to be RFC 5322
# compliant; we just want to reject obvious typos before contacting Gmail.
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

_SMTP_HOST = "smtp.gmail.com"
_SMTP_PORT = 587

_log = logging.getLogger(__name__)


class EmailError(Exception):
    """Raised for any failure to send an email."""


@dataclass(frozen=True)
class EmailResult:
    """Outcome of a successful send."""

    to: str
    subject: str
    message_id: str | None


def _validate_recipient(recipient: str) -> None:
    if not _EMAIL_RE.match(recipient):
        raise EmailError(f"Invalid recipient address: {recipient!r}")


def send_email(
    *,
    to: str,
    subject: str,
    body: str,
    settings: Settings,
) -> EmailResult:
    """Send a plain-text email via Gmail SMTP.

    Raises ``EmailError`` if Gmail isn't configured or SMTP rejects the
    message. The caller is responsible for confirming with the user that
    the email *should* be sent — this function just performs the send.
    """
    if not settings.has_gmail:
        raise EmailError(
            "Gmail isn't configured. Set ALFRED_GMAIL_ADDRESS and "
            "ALFRED_GMAIL_APP_PASSWORD in .env to enable email sending."
        )
    _validate_recipient(to.strip())

    sender = settings.alfred_gmail_address.strip()
    display = settings.alfred_gmail_display_name.strip() or "Alfred"

    msg = EmailMessage()
    msg["From"] = formataddr((display, sender))
    msg["To"] = to.strip()
    msg["Subject"] = subject.strip()
    msg.set_content(body)

    try:
        with smtplib.SMTP(_SMTP_HOST, _SMTP_PORT, timeout=20) as smtp:
            smtp.starttls()
            smtp.login(sender, settings.alfred_gmail_app_password)
            smtp.send_message(msg)
    except smtplib.SMTPAuthenticationError as exc:
        raise EmailError(
            "Gmail rejected the app password. Double-check that 2-Step "
            "Verification is on for the account and that you copied the "
            "16-character app password without spaces."
        ) from exc
    except smtplib.SMTPException as exc:
        raise EmailError(f"Gmail SMTP error: {exc}") from exc
    except OSError as exc:
        raise EmailError(f"Could not reach Gmail SMTP: {exc}") from exc

    _log.info("Sent email to %s subject=%r", to, subject)
    return EmailResult(to=to.strip(), subject=subject.strip(), message_id=msg.get("Message-ID"))
