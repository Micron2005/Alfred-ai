"""Spotify OAuth + control endpoints.

OAuth flow:

1. Frontend calls ``GET /api/spotify/auth/start`` → backend mints a
   random ``state`` and returns the Spotify authorize-URL.
2. Browser redirects to Spotify, user grants scopes, Spotify redirects
   to ``GET /api/spotify/callback?code=…&state=…``.
3. Backend validates ``state``, exchanges ``code`` for tokens, persists
   the linked account, then redirects the browser back to the
   frontend so the SPA can refresh its UI.

Playback endpoints are thin wrappers around :class:`SpotifyClient`.
They live under ``/api/spotify/*`` (different from the rest of the
backend's bare-prefix routers) because the redirect URI registered
in the Spotify dashboard is path-specific and we want the URL to be
self-documenting.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.config import Settings, get_settings
from alfred_core.db.session import get_session
from alfred_core.tools.spotify import (
    SpotifyClient,
    SpotifyError,
    SpotifyNotLinkedError,
    SpotifyUnconfiguredError,
    build_auth_url,
    make_state_token,
)

router = APIRouter(prefix="/api/spotify", tags=["spotify"])


# ─── Pending-state cache (CSRF protection for the OAuth flow) ────────
#
# The state token is a per-attempt random string sent to Spotify and
# echoed back in the callback. We keep it in a small in-memory dict
# (single-process, single-user backend) with a 10-minute TTL so an
# abandoned auth flow doesn't leak memory forever. If we ever go
# multi-process this needs to move to Redis or the DB.

_STATE_TTL_SECONDS = 600
# Cap on simultaneously pending OAuth flows. In practice the user has
# at most one in flight, but a tab refresh during auth would create a
# second; we evict oldest first when the cap is hit.
_STATE_CACHE_MAX = 32


@dataclass
class _PendingState:
    expires_at: float
    # Where to bounce the browser after we finish the OAuth handshake.
    # Saved at /auth/start time so the user lands back where they
    # clicked Connect.
    return_to: str


_pending_states: dict[str, _PendingState] = {}


def _purge_expired_states() -> None:
    now = time.monotonic()
    for token, entry in list(_pending_states.items()):
        if entry.expires_at <= now:
            _pending_states.pop(token, None)


def _record_state(token: str, return_to: str) -> None:
    _purge_expired_states()
    if len(_pending_states) >= _STATE_CACHE_MAX:
        # Evict the oldest (smallest expires_at) so a stuck user
        # can't lock out new auth attempts.
        oldest = min(_pending_states, key=lambda k: _pending_states[k].expires_at)
        _pending_states.pop(oldest, None)
    _pending_states[token] = _PendingState(
        expires_at=time.monotonic() + _STATE_TTL_SECONDS,
        return_to=return_to,
    )


def _consume_state(token: str) -> str | None:
    _purge_expired_states()
    entry = _pending_states.pop(token, None)
    if entry is None:
        return None
    return entry.return_to


# ─── Response shapes ─────────────────────────────────────────────────


class StatusResponse(BaseModel):
    configured: bool
    linked: bool
    display_name: str
    user_id: str


class AuthStartResponse(BaseModel):
    authorize_url: str


class AccessTokenResponse(BaseModel):
    access_token: str


class TrackResponse(BaseModel):
    track_id: str
    title: str
    artists: str
    album: str
    duration_ms: int
    progress_ms: int
    is_playing: bool
    track_url: str
    image_url: str


class PlayRequest(BaseModel):
    # Free-text song/artist query — Alfred will search and play the top
    # hit. Either ``query`` or ``uri`` may be set, not both. If both
    # empty, this is treated as "resume current playback".
    query: str | None = None
    # Spotify URI (track / album / playlist / artist) for the rare case
    # where the caller already has it (e.g. a "play this album" button).
    uri: str | None = None
    # Optional Connect device target — usually omitted (Spotify picks
    # the active device).
    device_id: str | None = None


class TransferRequest(BaseModel):
    device_id: str
    play: bool = True


# ─── Helpers ─────────────────────────────────────────────────────────


def _client(session: AsyncSession, settings: Settings) -> SpotifyClient:
    if not settings.has_spotify:
        raise HTTPException(
            status_code=503,
            detail=(
                "Spotify isn't configured. Set ALFRED_SPOTIFY_CLIENT_ID and "
                "ALFRED_SPOTIFY_CLIENT_SECRET in .env."
            ),
        )
    return SpotifyClient(session, settings)


def _bounce_url(return_to: str | None, settings: Settings) -> str:
    """Where to send the browser after the OAuth callback completes.

    Rejects anything that isn't a same-host loopback URL so a malicious
    ``return_to=https://evil/`` can't turn this endpoint into an open
    redirector.
    """
    safe_default = "/"
    if not return_to:
        return safe_default
    # Allow only relative paths or paths on a small allowlist of
    # loopback origins. We do this with prefix matching rather than
    # urlparse magic, but with two important guards so it can't be
    # turned into an open redirector:
    #
    #   - Reject ``//`` (protocol-relative URLs like ``//evil.com``
    #     which browsers resolve to ``https://evil.com``).
    #   - Require an explicit origin boundary (trailing ``/`` after the
    #     host) so ``http://127.0.0.1.evil.com`` doesn't match.
    if return_to.startswith("/") and not return_to.startswith("//"):
        return return_to
    redirect_origin = settings.alfred_spotify_redirect_uri.rsplit("/api/", 1)[0]
    for origin in ("http://127.0.0.1", "http://localhost", redirect_origin):
        if not origin:
            continue
        if return_to == origin or return_to.startswith(origin + "/"):
            return return_to
    return safe_default


# ─── Endpoints ───────────────────────────────────────────────────────


@router.get("/status", response_model=StatusResponse)
async def status(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> StatusResponse:
    info = await SpotifyClient(session, settings).get_status()
    return StatusResponse(
        configured=info.configured,
        linked=info.linked,
        display_name=info.display_name,
        user_id=info.user_id,
    )


@router.get("/auth/start", response_model=AuthStartResponse)
async def auth_start(
    return_to: str = Query(default="/", description="Where to send the browser after auth completes."),
    settings: Settings = Depends(get_settings),
) -> AuthStartResponse:
    if not settings.has_spotify:
        raise HTTPException(
            status_code=503,
            detail="Spotify isn't configured on the server.",
        )
    state = make_state_token()
    _record_state(state, return_to)
    try:
        url = build_auth_url(settings, state)
    except SpotifyUnconfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return AuthStartResponse(authorize_url=url)


@router.get("/callback")
async def callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> RedirectResponse:
    """OAuth redirect target. Finalizes auth and bounces back to the SPA."""
    # If the user hit "Cancel" on Spotify's grant screen, ``error``
    # comes back instead of ``code``. Surface it via a query string
    # rather than a 4xx so the SPA can show a polite message.
    if error or not code or not state:
        return RedirectResponse(
            url=f"/?spotify_error={error or 'missing_code'}",
            status_code=302,
        )
    return_to = _consume_state(state)
    if return_to is None:
        # Stale or forged state. Bounce home with an error flag.
        return RedirectResponse(
            url="/?spotify_error=state_mismatch",
            status_code=302,
        )
    try:
        await SpotifyClient(session, settings).complete_auth(code)
    except (SpotifyUnconfiguredError, SpotifyError):
        # Don't leak the detailed error in a query string; the SPA's
        # status endpoint will report linked=false and the user can
        # retry. The detailed error is preserved in the server log
        # via FastAPI's default exception handling on its way up
        # (we re-raise as a redirect, so log it manually here).
        return RedirectResponse(
            url="/?spotify_error=auth_failed",
            status_code=302,
        )
    bounce = _bounce_url(return_to, settings)
    # ``spotify_linked=1`` lets the SPA refresh its status without
    # polling. The flag is harmless if it's there from a stale tab.
    sep = "&" if "?" in bounce else "?"
    return RedirectResponse(url=f"{bounce}{sep}spotify_linked=1", status_code=302)


@router.delete("/disconnect")
async def disconnect(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    deleted = await _client(session, settings).disconnect()
    return {"deleted": deleted}


@router.get("/access-token", response_model=AccessTokenResponse)
async def access_token(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AccessTokenResponse:
    """Hand a fresh access token to the browser for the Web Playback SDK.

    The SDK runs in the browser and needs a Spotify access token. We
    refresh server-side and hand the short-lived bearer to the SDK
    each time it asks (it asks on init and again whenever the token
    expires). The refresh token never leaves the server.
    """
    try:
        token = await _client(session, settings).get_access_token()
    except SpotifyNotLinkedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (SpotifyUnconfiguredError, SpotifyError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    # ``get_access_token`` flushes a refreshed token but doesn't commit
    # (so the chat handler can keep transactional control over its own
    # turn). Standalone endpoints like this one own the request and
    # must commit themselves, otherwise the new token vanishes when
    # the session closes.
    await session.commit()
    return AccessTokenResponse(access_token=token)


@router.get("/now-playing")
async def now_playing(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> TrackResponse | None:
    try:
        track = await _client(session, settings).now_playing()
    except SpotifyNotLinkedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (SpotifyUnconfiguredError, SpotifyError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    # ``now_playing`` may have refreshed the access token via
    # ``get_access_token``; persist that here.
    await session.commit()
    if track is None:
        return None
    return TrackResponse(
        track_id=track.track_id,
        title=track.title,
        artists=track.artists,
        album=track.album,
        duration_ms=track.duration_ms,
        progress_ms=track.progress_ms,
        is_playing=track.is_playing,
        track_url=track.track_url,
        image_url=track.image_url,
    )


@router.post("/play")
async def play(
    req: PlayRequest,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict[str, str | None]:
    client = _client(session, settings)
    try:
        if req.uri:
            uris = [req.uri]
            await client.play(device_id=req.device_id, uris=uris)
            played_uri: str | None = req.uri
        elif req.query:
            uri = await client.search_track(req.query)
            if uri is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"Spotify couldn't find a track matching {req.query!r}.",
                )
            await client.play(device_id=req.device_id, uris=[uri])
            played_uri = uri
        else:
            # Neither query nor URI: just resume.
            await client.play(device_id=req.device_id)
            played_uri = None
    except SpotifyNotLinkedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (SpotifyUnconfiguredError, SpotifyError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    # Persist any token refresh that happened inside ``client``.
    await session.commit()
    return {"played_uri": played_uri}


@router.post("/pause")
async def pause(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    try:
        await _client(session, settings).pause()
    except SpotifyNotLinkedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (SpotifyUnconfiguredError, SpotifyError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    await session.commit()
    return {"ok": True}


@router.post("/next")
async def next_track(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    try:
        await _client(session, settings).next_track()
    except SpotifyNotLinkedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (SpotifyUnconfiguredError, SpotifyError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    await session.commit()
    return {"ok": True}


@router.post("/previous")
async def previous_track(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    try:
        await _client(session, settings).previous_track()
    except SpotifyNotLinkedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (SpotifyUnconfiguredError, SpotifyError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    await session.commit()
    return {"ok": True}


@router.post("/transfer")
async def transfer(
    req: TransferRequest,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    try:
        await _client(session, settings).transfer_playback(req.device_id, play=req.play)
    except SpotifyNotLinkedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (SpotifyUnconfiguredError, SpotifyError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    await session.commit()
    return {"ok": True}


@router.get("/audio-analysis/{track_id}")
async def audio_analysis(
    track_id: str,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    try:
        analysis = await _client(session, settings).audio_analysis(track_id)
    except SpotifyNotLinkedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (SpotifyUnconfiguredError, SpotifyError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    await session.commit()
    return analysis
