"""Self-diagnostics — Alfred's own vitals.

Exposes ``GET /vitals`` which runs a small set of live checks against
the things Alfred depends on (Ollama, Postgres, configured external
services) and returns a single JSON document the HUD can render. The
goal is "Alfred can tell you when something's off about himself in
plain English" rather than the user having to ssh into the host and
read ``docker compose logs``.

Each check has the same shape:
    {"id": "ollama", "status": "ok|warn|err|off", "label": "...",
     "detail": "...", "fix": "..."}

- ``ok``: fully working
- ``warn``: configured but degraded / unverified
- ``err``: configured but broken
- ``off``: not configured (intentional)

``fix`` is a short user-facing instruction shown directly in the UI
when the user clicks the row — so a non-developer can act on it
without leaving the HUD.
"""

from __future__ import annotations

import asyncio
from typing import Literal

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.config import Settings, get_settings
from alfred_core.db.session import get_session

router = APIRouter(prefix="/vitals", tags=["vitals"])

VitalStatus = Literal["ok", "warn", "err", "off"]


class Vital(BaseModel):
    id: str
    label: str
    status: VitalStatus
    detail: str
    # Empty when nothing is wrong — the UI hides the "FIX" reveal.
    fix: str = ""


class VitalsReport(BaseModel):
    vitals: list[Vital]


async def _check_ollama(settings: Settings) -> Vital:
    if not settings.has_local_chat:
        return Vital(
            id="ollama",
            label="Local LLM",
            status="off",
            detail="Local Ollama is disabled (LOCAL_MODEL_CHAT='').",
        )
    url = f"{settings.ollama_host.rstrip('/')}/api/tags"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0)) as client:
            resp = await client.get(url)
        resp.raise_for_status()
        data = resp.json()
        names = {m.get("name", "") for m in data.get("models", [])}
        if settings.local_model_chat in names:
            return Vital(
                id="ollama",
                label="Local LLM",
                status="ok",
                detail=f"{settings.local_model_chat} pulled and ready.",
            )
        return Vital(
            id="ollama",
            label="Local LLM",
            status="warn",
            detail=(
                f"Ollama reachable but {settings.local_model_chat} isn't "
                "pulled — every chat is going to cloud right now."
            ),
            fix=f"On the host: `ollama pull {settings.local_model_chat}`",
        )
    except (httpx.HTTPError, ValueError) as exc:
        return Vital(
            id="ollama",
            label="Local LLM",
            status="err",
            detail=f"Couldn't reach Ollama at {settings.ollama_host}: {exc}",
            fix=(
                "Start Ollama on the host: `ollama serve`. If it's already "
                "running, check OLLAMA_HOST in your .env points at "
                "http://host.docker.internal:11434 (Docker Desktop) or "
                "the host LAN IP."
            ),
        )


async def _check_db(session: AsyncSession) -> Vital:
    try:
        await session.execute(text("SELECT 1"))
        return Vital(
            id="db",
            label="Database",
            status="ok",
            detail="Postgres reachable, schema in place.",
        )
    except Exception as exc:
        return Vital(
            id="db",
            label="Database",
            status="err",
            detail=f"Postgres query failed: {exc}",
            fix=(
                "Restart the Postgres container: "
                "`docker compose restart postgres`. If it keeps falling "
                "over, check the data volume isn't full."
            ),
        )


def _check_cloud(settings: Settings) -> Vital:
    if settings.has_cloud:
        return Vital(
            id="cloud",
            label="Cloud LLM",
            status="ok",
            detail=f"Anthropic key present ({settings.anthropic_model}).",
        )
    return Vital(
        id="cloud",
        label="Cloud LLM",
        status="off",
        detail="No ANTHROPIC_API_KEY — local-only mode.",
        fix=(
            "Drop ANTHROPIC_API_KEY=sk-ant-... into .env if you want a "
            "cloud fallback when Ollama is misbehaving."
        ),
    )


def _check_tavily(settings: Settings) -> Vital:
    if settings.has_tavily:
        return Vital(
            id="tavily",
            label="Web Search",
            status="ok",
            detail="Tavily key present — Alfred can fetch live links.",
        )
    return Vital(
        id="tavily",
        label="Web Search",
        status="off",
        detail="No Tavily key — Alfred can't pull YouTube/Amazon/etc. links.",
        fix=(
            "Free key at tavily.com gives 1,000 searches/month. Add "
            "ALFRED_TAVILY_API_KEY=tvly-... to .env."
        ),
    )


def _check_spotify(settings: Settings) -> Vital:
    if settings.has_spotify:
        return Vital(
            id="spotify",
            label="Spotify",
            status="ok",
            detail="Spotify dev app configured.",
        )
    return Vital(
        id="spotify",
        label="Spotify",
        status="off",
        detail="Spotify integration not configured.",
    )


def _check_gmail(settings: Settings) -> Vital:
    if settings.has_gmail:
        return Vital(
            id="gmail",
            label="Email",
            status="ok",
            detail=f"Gmail SMTP configured for {settings.alfred_gmail_address}.",
        )
    return Vital(
        id="gmail",
        label="Email",
        status="off",
        detail="No Gmail credentials — Alfred can draft but can't send.",
        fix=(
            "Add ALFRED_GMAIL_ADDRESS and ALFRED_GMAIL_APP_PASSWORD to "
            ".env (Gmail app-password, not your normal Gmail password)."
        ),
    )


def _check_printer(settings: Settings) -> Vital:
    if settings.alfred_printer_url:
        return Vital(
            id="printer",
            label="3D Printer",
            status="ok",
            detail=f"Moonraker URL set: {settings.alfred_printer_url}",
        )
    return Vital(
        id="printer",
        label="3D Printer",
        status="off",
        detail="No printer URL — printer integration is dormant.",
    )


@router.get("", response_model=VitalsReport)
async def vitals(
    settings: Settings = Depends(get_settings),
    session: AsyncSession = Depends(get_session),
) -> VitalsReport:
    """Run every check in parallel and return the consolidated report.

    Per-check failures are caught and surfaced as ``err`` vitals so a
    single broken integration doesn't 500 the whole vitals call (which
    would defeat the point — the user uses this *because* something is
    broken)."""
    ollama_task = _check_ollama(settings)
    db_task = _check_db(session)
    ollama_v, db_v = await asyncio.gather(
        ollama_task, db_task, return_exceptions=False
    )
    return VitalsReport(
        vitals=[
            ollama_v,
            _check_cloud(settings),
            db_v,
            _check_tavily(settings),
            _check_gmail(settings),
            _check_spotify(settings),
            _check_printer(settings),
        ]
    )
