"""Tests for the Gmail send tool, marker parser, and /email/send endpoint."""

from __future__ import annotations

import smtplib
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alfred_core.api.email import router as email_router
from alfred_core.config import Settings
from alfred_core.tools.email import EmailError, send_email
from alfred_core.tools.email_marker import EmailMarkerError, _parse_inner, extract_drafts


@pytest.fixture
def configured() -> Settings:
    return Settings(
        alfred_gmail_address="alfred@example.com",
        alfred_gmail_app_password="abcdabcdabcdabcd",
        alfred_gmail_display_name="Alfred",
    )


@pytest.fixture
def unconfigured() -> Settings:
    return Settings(alfred_gmail_address="", alfred_gmail_app_password="")


@pytest.fixture
def mock_smtp() -> Iterator[MagicMock]:
    with patch("alfred_core.tools.email.smtplib.SMTP") as smtp_cls:
        instance = MagicMock()
        smtp_cls.return_value.__enter__.return_value = instance
        yield instance


def test_send_email_happy_path(configured: Settings, mock_smtp: MagicMock) -> None:
    result = send_email(
        to="bob@example.com",
        subject="Hello",
        body="Greetings.",
        settings=configured,
    )
    assert result.to == "bob@example.com"
    assert result.subject == "Hello"
    mock_smtp.starttls.assert_called_once()
    mock_smtp.login.assert_called_once_with("alfred@example.com", "abcdabcdabcdabcd")
    mock_smtp.send_message.assert_called_once()


def test_send_email_rejects_invalid_recipient(
    configured: Settings, mock_smtp: MagicMock
) -> None:
    with pytest.raises(EmailError, match="Invalid recipient"):
        send_email(to="not-an-email", subject="x", body="y", settings=configured)
    mock_smtp.send_message.assert_not_called()


def test_send_email_unconfigured_short_circuits(unconfigured: Settings) -> None:
    with patch("alfred_core.tools.email.smtplib.SMTP") as smtp_cls:
        with pytest.raises(EmailError, match="isn't configured"):
            send_email(
                to="bob@example.com", subject="x", body="y", settings=unconfigured
            )
        smtp_cls.assert_not_called()


def test_send_email_auth_failure(configured: Settings) -> None:
    with patch("alfred_core.tools.email.smtplib.SMTP") as smtp_cls:
        instance = MagicMock()
        smtp_cls.return_value.__enter__.return_value = instance
        instance.login.side_effect = smtplib.SMTPAuthenticationError(535, b"nope")
        with pytest.raises(EmailError, match="rejected the app password"):
            send_email(
                to="bob@example.com",
                subject="x",
                body="y",
                settings=configured,
            )


def test_extract_drafts_single() -> None:
    reply = """\
Right then.

[SEND_EMAIL]
to: bob@example.com
subject: Tonight's plans
body:
Bob,

Cancelled. Tomorrow instead.

— Alfred
[/SEND_EMAIL]

Anything else, sir?"""
    drafts = extract_drafts(reply)
    assert len(drafts) == 1
    d = drafts[0]
    assert d.to == "bob@example.com"
    assert d.subject == "Tonight's plans"
    assert d.body.startswith("Bob,")
    assert d.body.endswith("Alfred")


def test_extract_drafts_handles_multiple() -> None:
    reply = """\
[SEND_EMAIL]
to: a@x.com
subject: One
body:
First.
[/SEND_EMAIL]

[SEND_EMAIL]
to: b@x.com
subject: Two
body:
Second.
[/SEND_EMAIL]"""
    drafts = extract_drafts(reply)
    assert [d.to for d in drafts] == ["a@x.com", "b@x.com"]


def test_extract_drafts_body_cannot_override_headers() -> None:
    """Regression: body lines like 'to:' must not change the recipient."""
    reply = """\
[SEND_EMAIL]
to: alice@example.com
subject: Meeting notes
body:
Please forward
to: charlie@wrong.com
[/SEND_EMAIL]"""
    drafts = extract_drafts(reply)
    assert len(drafts) == 1
    assert drafts[0].to == "alice@example.com"
    assert drafts[0].subject == "Meeting notes"
    assert "charlie@wrong.com" in drafts[0].body


def test_extract_drafts_skips_malformed() -> None:
    reply = """\
[SEND_EMAIL]
to: bob@example.com
subject: missing body
[/SEND_EMAIL]"""
    assert extract_drafts(reply) == []


def test_parse_inner_raises_on_missing_field() -> None:
    with pytest.raises(EmailMarkerError):
        _parse_inner("to: x@y.com\nbody:\nhi\n")


def test_send_endpoint_503_when_unconfigured() -> None:
    app = FastAPI()
    app.include_router(email_router)
    client = TestClient(app)

    with patch("alfred_core.api.email.get_settings") as get:
        get.return_value = Settings(alfred_gmail_address="", alfred_gmail_app_password="")
        resp = client.post(
            "/email/send",
            json={"to": "bob@example.com", "subject": "Hi", "body": "Hello."},
        )
    assert resp.status_code == 503
    assert "isn't configured" in resp.json()["detail"]


def test_send_endpoint_happy_path() -> None:
    app = FastAPI()
    app.include_router(email_router)
    client = TestClient(app)

    with (
        patch("alfred_core.api.email.get_settings") as get,
        patch("alfred_core.tools.email.smtplib.SMTP") as smtp_cls,
    ):
        get.return_value = Settings(
            alfred_gmail_address="alfred@example.com",
            alfred_gmail_app_password="abcdabcdabcdabcd",
        )
        instance = MagicMock()
        smtp_cls.return_value.__enter__.return_value = instance
        resp = client.post(
            "/email/send",
            json={"to": "bob@example.com", "subject": "Hi", "body": "Hello."},
        )
    assert resp.status_code == 200
    assert resp.json()["to"] == "bob@example.com"
    instance.send_message.assert_called_once()
