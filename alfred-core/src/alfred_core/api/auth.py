"""Single-user password gate for Alfred.

Endpoints
---------
- ``POST /api/auth/login``    — body {password: str}; sets httpOnly cookies
- ``GET  /api/auth/me``       — returns {authed: true, user: "Mukarram"}
- ``POST /api/auth/logout``   — clears cookies
- ``POST /api/auth/refresh``  — mints a new access token from refresh cookie
- ``POST /api/auth/change``   — body {old, new}; returns the new bcrypt hash
                                that the user pastes into .env

Why so simple?
--------------
There is one user (the owner of this Alfred instance). Multi-user
support would mean a users table, registration, password-reset email
flow — none of which earn their keep on a single-user home server.

Brute-force protection is in-memory: a small dict keyed by client IP.
Single-process FastAPI means the dict is the source of truth; if you
ever scale Alfred horizontally, swap this for Postgres or Redis.
"""

from __future__ import annotations

import logging
import os
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import bcrypt
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from alfred_core.config import Settings, get_settings

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

JWT_ALGORITHM = "HS256"
ACCESS_COOKIE = "alfred_access"
REFRESH_COOKIE = "alfred_refresh"


# ─── Brute-force tracker ───────────────────────────────────────────────────


@dataclass
class _AttemptState:
    failures: int = 0
    locked_until: datetime | None = None
    last_attempt: datetime = field(default_factory=lambda: datetime.now(UTC))


_attempts: dict[str, _AttemptState] = defaultdict(_AttemptState)


def _client_ip(request: Request) -> str:
    """Best-effort client IP. Behind a reverse proxy we honour the standard
    forwarded headers. The auth gate is meant to make brute-forcing
    miserable, not to forensically attribute every request."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_lockout(ip: str, settings: Settings) -> None:
    state = _attempts[ip]
    now = datetime.now(UTC)
    if state.locked_until and state.locked_until > now:
        retry_in = int((state.locked_until - now).total_seconds())
        raise HTTPException(
            status_code=429,
            detail=(
                f"Too many failed attempts. Try again in {retry_in} seconds."
            ),
        )
    # Expire stale failure counters so a one-off typo doesn't haunt
    # forever.
    if state.last_attempt < now - timedelta(hours=1):
        state.failures = 0


def _record_failure(ip: str, settings: Settings) -> None:
    state = _attempts[ip]
    state.failures += 1
    state.last_attempt = datetime.now(UTC)
    if state.failures >= settings.alfred_login_max_failures:
        state.locked_until = state.last_attempt + timedelta(
            minutes=settings.alfred_login_lockout_minutes
        )
        state.failures = 0  # reset for the next window
        _log.warning(
            "Locking %s out of /auth/login for %d minutes after repeated failures.",
            ip,
            settings.alfred_login_lockout_minutes,
        )


def _record_success(ip: str) -> None:
    _attempts[ip] = _AttemptState()  # full reset


# ─── JWT helpers ───────────────────────────────────────────────────────────


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _create_access_token(settings: Settings) -> str:
    payload = {
        "sub": "alfred-owner",
        "type": "access",
        "exp": _now_utc()
        + timedelta(minutes=settings.alfred_jwt_access_ttl_minutes),
    }
    return jwt.encode(payload, settings.alfred_jwt_secret, algorithm=JWT_ALGORITHM)


def _create_refresh_token(settings: Settings) -> str:
    payload = {
        "sub": "alfred-owner",
        "type": "refresh",
        "exp": _now_utc() + timedelta(days=settings.alfred_jwt_refresh_ttl_days),
    }
    return jwt.encode(payload, settings.alfred_jwt_secret, algorithm=JWT_ALGORITHM)


def _decode(token: str, settings: Settings) -> dict[str, Any]:
    return jwt.decode(token, settings.alfred_jwt_secret, algorithms=[JWT_ALGORITHM])


def _set_cookies(
    response: Response, settings: Settings, *, access: str, refresh: str
) -> None:
    """Set httpOnly cookies. ``secure=True`` is keyed off the
    ``ALFRED_COOKIE_SECURE`` env so the dev experience over plain HTTP
    works the same as HTTPS-on-Tailscale prod. Default is secure-on
    when ``HTTPS`` env is detected; explicit override wins."""
    secure = _cookie_secure_from_env()
    response.set_cookie(
        key=ACCESS_COOKIE,
        value=access,
        httponly=True,
        secure=secure,
        samesite="lax",
        max_age=settings.alfred_jwt_access_ttl_minutes * 60,
        path="/",
    )
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=refresh,
        httponly=True,
        secure=secure,
        samesite="lax",
        max_age=settings.alfred_jwt_refresh_ttl_days * 86400,
        path="/",
    )


def _cookie_secure_from_env() -> bool:
    raw = os.environ.get("ALFRED_COOKIE_SECURE", "").lower().strip()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    # Default: secure off in dev (no HTTPS terminator), on in prod
    # (Tailscale Funnel / Cloudflare Tunnel terminate TLS upstream).
    return os.environ.get("ALFRED_ENV", "").lower() == "production"


# ─── FastAPI dependency: protects /api/* routes ────────────────────────────


def require_auth(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Dependency the rest of the API uses to gate endpoints. When auth
    is disabled (``has_auth == False``), this is a no-op so every
    deployment that *isn't* exposing Alfred publicly keeps working
    without changes."""
    if not settings.has_auth:
        return {"authed": False, "reason": "auth-disabled"}
    token = request.cookies.get(ACCESS_COOKIE)
    if not token:
        # Allow Bearer tokens too — handy for curl-from-the-host
        # debugging and for the workshop's diagnose flow.
        auth_header = request.headers.get("authorization", "")
        if auth_header.lower().startswith("bearer "):
            token = auth_header[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    try:
        payload = _decode(token, settings)
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="Token expired.") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid token.") from exc
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Wrong token type.")
    return {"authed": True, "user": "alfred-owner"}


# ─── Endpoints ─────────────────────────────────────────────────────────────


class _LoginIn(BaseModel):
    password: str = Field(..., min_length=1)


class _LoginOut(BaseModel):
    authed: bool
    user: str


@router.post("/login", response_model=_LoginOut)
async def login(
    body: _LoginIn,
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
) -> _LoginOut:
    if not settings.has_auth:
        # Auth not enabled — login is meaningless. Fail loudly so the
        # frontend can route around the login page entirely.
        raise HTTPException(
            status_code=400,
            detail=(
                "Auth is not enabled on this Alfred instance. Set "
                "ALFRED_PASSWORD_HASH in .env to turn it on."
            ),
        )
    ip = _client_ip(request)
    _check_lockout(ip, settings)
    ok = bcrypt.checkpw(
        body.password.encode("utf-8"),
        settings.alfred_password_hash.encode("utf-8"),
    )
    if not ok:
        _record_failure(ip, settings)
        raise HTTPException(status_code=401, detail="Wrong password.")
    _record_success(ip)
    access = _create_access_token(settings)
    refresh = _create_refresh_token(settings)
    _set_cookies(response, settings, access=access, refresh=refresh)
    return _LoginOut(authed=True, user="alfred-owner")


class _MeOut(BaseModel):
    authed: bool
    user: str | None = None
    auth_enabled: bool


@router.get("/me", response_model=_MeOut)
async def me(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> _MeOut:
    """Stateless probe used by the frontend to decide whether to show
    the login page. Returns ``auth_enabled=False`` when the gate is
    off so the frontend can skip the gate entirely."""
    if not settings.has_auth:
        return _MeOut(authed=True, user="alfred-owner", auth_enabled=False)
    token = request.cookies.get(ACCESS_COOKIE)
    if not token:
        return _MeOut(authed=False, auth_enabled=True)
    try:
        payload = _decode(token, settings)
        if payload.get("type") != "access":
            return _MeOut(authed=False, auth_enabled=True)
    except jwt.InvalidTokenError:
        return _MeOut(authed=False, auth_enabled=True)
    return _MeOut(authed=True, user="alfred-owner", auth_enabled=True)


@router.post("/logout")
async def logout(response: Response) -> dict[str, bool]:
    response.delete_cookie(ACCESS_COOKIE, path="/")
    response.delete_cookie(REFRESH_COOKIE, path="/")
    return {"ok": True}


@router.post("/refresh", response_model=_LoginOut)
async def refresh(
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
) -> _LoginOut:
    if not settings.has_auth:
        raise HTTPException(status_code=400, detail="Auth disabled.")
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="No refresh token.")
    try:
        payload = _decode(token, settings)
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Bad refresh token.") from exc
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Wrong token type.")
    new_access = _create_access_token(settings)
    new_refresh = _create_refresh_token(settings)
    _set_cookies(response, settings, access=new_access, refresh=new_refresh)
    return _LoginOut(authed=True, user="alfred-owner")


class _ChangeIn(BaseModel):
    old_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8)


class _ChangeOut(BaseModel):
    """Returns the bcrypt hash of the new password. We deliberately do
    NOT update the running config — the user pastes the hash into
    ``.env`` and restarts. That keeps the source of truth one place
    (the .env file) and avoids needing a writable secrets store."""

    new_password_hash: str
    instructions: str


@router.post("/change", response_model=_ChangeOut)
async def change(
    body: _ChangeIn,
    request: Request,
    settings: Settings = Depends(get_settings),
    _: dict[str, Any] = Depends(require_auth),
) -> _ChangeOut:
    if not settings.has_auth:
        raise HTTPException(status_code=400, detail="Auth disabled.")
    ip = _client_ip(request)
    _check_lockout(ip, settings)
    ok = bcrypt.checkpw(
        body.old_password.encode("utf-8"),
        settings.alfred_password_hash.encode("utf-8"),
    )
    if not ok:
        _record_failure(ip, settings)
        raise HTTPException(status_code=401, detail="Old password is wrong.")
    new_hash = bcrypt.hashpw(
        body.new_password.encode("utf-8"), bcrypt.gensalt()
    ).decode("utf-8")
    return _ChangeOut(
        new_password_hash=new_hash,
        instructions=(
            "Paste this into your .env as ALFRED_PASSWORD_HASH=... "
            "(no quotes, no spaces) and run ./scripts/alfred-update.sh "
            "to restart. The change is NOT live until that restart."
        ),
    )
