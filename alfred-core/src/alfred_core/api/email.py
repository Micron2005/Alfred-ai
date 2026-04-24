"""Direct email API for power-user / scripted use cases.

The chat flow already handles most email needs (Alfred drafts, you
confirm, he sends). This endpoint exists as a backstop for quick
testing (``curl /email/send``) and for any future UI that wants to
side-step the chat round-trip.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from alfred_core.config import get_settings
from alfred_core.tools.email import EmailError, send_email

router = APIRouter(prefix="/email", tags=["email"])


class EmailIn(BaseModel):
    to: str = Field(..., min_length=3, max_length=320)
    subject: str = Field(..., min_length=1, max_length=200)
    body: str = Field(..., min_length=1, max_length=20_000)


class EmailOut(BaseModel):
    to: str
    subject: str
    message_id: str | None


@router.post("/send", response_model=EmailOut)
async def send(payload: EmailIn) -> EmailOut:
    settings = get_settings()
    try:
        result = send_email(
            to=payload.to,
            subject=payload.subject,
            body=payload.body,
            settings=settings,
        )
    except EmailError as exc:
        # 503 if Gmail isn't configured at all; 502 for SMTP-side rejections.
        status = 503 if not settings.has_gmail else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return EmailOut(to=result.to, subject=result.subject, message_id=result.message_id)
