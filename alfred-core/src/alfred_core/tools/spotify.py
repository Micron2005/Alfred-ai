"""Spotify Web API client wired to a single linked account.

Alfred is single-user, so we keep exactly one row in the
``spotify_accounts`` table and treat that as "the user's Spotify".
The OAuth flow lives in :mod:`alfred_core.api.spotify`; this module
holds the actual API surface — token refresh, now-playing, playback
control, search, audio-analysis fetch.

Failure modes we surface explicitly:

- :class:`SpotifyUnconfiguredError`: the developer-app credentials
  aren't set in the environment. Caller should turn this into a
  graceful "music control isn't wired up" reply.
- :class:`SpotifyNotLinkedError`: the user hasn't gone through the
  OAuth flow yet. Caller should prompt them to click the Connect
  Spotify button in the HUD.
- :class:`SpotifyError`: anything else — Spotify returned an error,
  the network failed, the user has no active device, etc. Caller
  should fold the message into a polite reply rather than 500.

Premium check: a few endpoints (start playback, skip, transfer
device) require Premium. We rely on Spotify's own ``403`` response
for that and translate it into :class:`SpotifyError` with the
Premium hint, rather than trying to mirror their entitlement
table.
"""

from __future__ import annotations

import base64
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from urllib.parse import urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.config import Settings
from alfred_core.db.models import SpotifyAccount

# Scopes we request when the user links their account. Tightly
# scoped to what Alfred actually needs:
#
#   user-read-playback-state    — read current track + device list
#   user-modify-playback-state  — start/pause/skip/seek/volume
#   user-read-currently-playing — fine-grained "what's playing right now"
#   streaming                   — required for the Web Playback SDK to
#                                 register Alfred as a Connect device
#   user-read-email/user-read-private — read display name + product
#                                        tier (so the UI can show
#                                        "Connected as X").
SPOTIFY_SCOPES = (
    "user-read-playback-state user-modify-playback-state "
    "user-read-currently-playing streaming "
    "user-read-email user-read-private"
)

_AUTH_BASE = "https://accounts.spotify.com"
_API_BASE = "https://api.spotify.com/v1"
# How early to refresh access tokens before their expiry. Spotify
# tokens last 1 h; refreshing 60 s early keeps us out of 401 territory
# without burning unnecessary refresh calls.
_REFRESH_LEEWAY = timedelta(seconds=60)
_HTTP_TIMEOUT = 12.0


class SpotifyUnconfiguredError(RuntimeError):
    """The Spotify developer app credentials aren't configured."""


class SpotifyNotLinkedError(RuntimeError):
    """The user hasn't completed the OAuth flow yet."""


class SpotifyError(RuntimeError):
    """Spotify returned an error or the network call failed."""


@dataclass(frozen=True)
class TrackInfo:
    """Just enough about the currently-playing track to feed the LLM."""

    track_id: str
    title: str
    artists: str
    album: str
    duration_ms: int
    progress_ms: int
    is_playing: bool
    # Open Spotify URL for the track (so the UI can deep-link to it).
    track_url: str
    # Album art at ~300 px (Spotify provides 64/300/640 — we pick the
    # middle for the HUD widget).
    image_url: str


@dataclass(frozen=True)
class StatusInfo:
    """Status payload returned by :func:`SpotifyClient.get_status`."""

    configured: bool
    linked: bool
    display_name: str
    user_id: str


def build_auth_url(settings: Settings, state: str) -> str:
    """Build the Spotify authorize-URL the browser should redirect to."""
    if not settings.has_spotify:
        raise SpotifyUnconfiguredError(
            "Spotify isn't configured. Set ALFRED_SPOTIFY_CLIENT_ID and "
            "ALFRED_SPOTIFY_CLIENT_SECRET in .env (free dev account at "
            "developer.spotify.com/dashboard) and restart the containers "
            "to enable music control."
        )
    params = {
        "client_id": settings.alfred_spotify_client_id,
        "response_type": "code",
        "redirect_uri": settings.alfred_spotify_redirect_uri,
        "scope": SPOTIFY_SCOPES,
        "state": state,
        # Always show the auth dialog so the user can switch accounts /
        # confirm scope grants. Without this Spotify silently re-uses
        # the previous grant which is confusing during dev.
        "show_dialog": "true",
    }
    return f"{_AUTH_BASE}/authorize?{urlencode(params)}"


def make_state_token() -> str:
    """Cryptographically random state for CSRF protection in the OAuth dance."""
    return secrets.token_urlsafe(24)


class SpotifyClient:
    """Server-side Spotify API wrapper for the linked account."""

    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self._session = session
        self._settings = settings

    # ─── Status / OAuth lifecycle ────────────────────────────────────

    async def get_status(self) -> StatusInfo:
        """Public status payload for the frontend's auth-check call."""
        if not self._settings.has_spotify:
            return StatusInfo(
                configured=False, linked=False, display_name="", user_id=""
            )
        account = await self._load_account()
        if account is None:
            return StatusInfo(
                configured=True, linked=False, display_name="", user_id=""
            )
        return StatusInfo(
            configured=True,
            linked=True,
            display_name=account.display_name or "",
            user_id=account.spotify_user_id or "",
        )

    async def complete_auth(self, code: str) -> SpotifyAccount:
        """Exchange the OAuth ``code`` for tokens and persist the account."""
        if not self._settings.has_spotify:
            raise SpotifyUnconfiguredError(
                "Spotify isn't configured; can't complete OAuth."
            )
        token_payload = await self._exchange_code(code)
        access_token = str(token_payload["access_token"])
        # Fetch the linked user's profile so we can display "Connected
        # as X" in the UI.
        profile = await self._fetch_profile(access_token)
        account = await self._load_account()
        expires_at = self._expiry_from(token_payload)
        scope_raw = token_payload.get("scope") or SPOTIFY_SCOPES
        scope = str(scope_raw)
        user_id = str(profile.get("id") or "")
        display_name = str(profile.get("display_name") or profile.get("id") or "")
        refresh_token = str(token_payload.get("refresh_token") or "")
        if account is None:
            if not refresh_token:
                # Spotify *must* return a refresh token on the
                # initial authorization. Bail loudly if it didn't —
                # without it we can't keep the account linked beyond
                # the first hour.
                raise SpotifyError(
                    "Spotify didn't return a refresh token on initial auth."
                )
            account = SpotifyAccount(
                account_key="default",
                spotify_user_id=user_id,
                display_name=display_name,
                access_token=access_token,
                refresh_token=refresh_token,
                scope=scope,
                expires_at=expires_at,
            )
            self._session.add(account)
        else:
            account.spotify_user_id = user_id or account.spotify_user_id
            account.display_name = display_name or account.display_name
            account.access_token = access_token
            # Spotify only returns refresh_token on first authorization;
            # on subsequent re-grants it may be omitted, so keep the
            # existing one.
            if refresh_token:
                account.refresh_token = refresh_token
            account.scope = scope
            account.expires_at = expires_at
        await self._session.commit()
        await self._session.refresh(account)
        return account

    async def disconnect(self) -> bool:
        """Forget the linked account. Returns whether anything was deleted."""
        account = await self._load_account()
        if account is None:
            return False
        await self._session.delete(account)
        await self._session.commit()
        return True

    # ─── Access-token plumbing ───────────────────────────────────────

    async def get_access_token(self) -> str:
        """Return a non-expired access token, refreshing if needed."""
        account = await self._require_account()
        # Compare in aware UTC. Old rows written before we made
        # _utcnow tz-aware may be naive; treat those as expired.
        now = datetime.now(UTC)
        expiry = account.expires_at
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=UTC)
        if expiry - _REFRESH_LEEWAY > now:
            return account.access_token
        token_payload = await self._refresh(account.refresh_token)
        account.access_token = str(token_payload["access_token"])
        account.expires_at = self._expiry_from(token_payload)
        new_refresh = token_payload.get("refresh_token")
        if new_refresh:
            account.refresh_token = str(new_refresh)
        await self._session.commit()
        return account.access_token

    # ─── Public API surface used by the chat tool + HUD ──────────────

    async def now_playing(self) -> TrackInfo | None:
        """Return what's currently playing, or ``None`` if nothing is."""
        token = await self.get_access_token()
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.get(
                f"{_API_BASE}/me/player/currently-playing",
                headers=self._auth_headers(token),
            )
        # 204: no track playing right now (could be paused, idle, or no
        # active device). The endpoint distinguishes "no content" via
        # status code rather than body, hence this check.
        if response.status_code == 204:
            return None
        if response.status_code == 401:
            raise SpotifyError("Spotify rejected the access token; try reconnecting.")
        if response.status_code >= 400:
            raise SpotifyError(
                f"Spotify currently-playing returned HTTP {response.status_code}: "
                f"{response.text[:200]}"
            )
        body: dict[str, Any] = response.json()
        item: dict[str, Any] = body.get("item") or {}
        if not item:
            return None
        artist_list: list[dict[str, Any]] = item.get("artists") or []
        artists = ", ".join(str(a.get("name", "")) for a in artist_list)
        album: dict[str, Any] = item.get("album") or {}
        images: list[dict[str, Any]] = album.get("images") or []
        # Spotify orders images largest-first. The middle one (index 1)
        # is typically 300px which is what the HUD widget wants.
        image_url = ""
        if images:
            picked = images[1] if len(images) > 1 else images[0]
            image_url = str(picked.get("url") or "")
        external_urls: dict[str, Any] = item.get("external_urls") or {}
        return TrackInfo(
            track_id=str(item.get("id") or ""),
            title=str(item.get("name") or ""),
            artists=artists,
            album=str(album.get("name") or ""),
            duration_ms=int(item.get("duration_ms") or 0),
            progress_ms=int(body.get("progress_ms") or 0),
            is_playing=bool(body.get("is_playing")),
            track_url=str(external_urls.get("spotify") or ""),
            image_url=image_url,
        )

    async def play(
        self,
        *,
        device_id: str | None = None,
        uris: list[str] | None = None,
        context_uri: str | None = None,
    ) -> None:
        """Start or resume playback.

        - With no arguments: resumes whatever was playing.
        - With ``uris``: plays those tracks.
        - With ``context_uri``: plays an album/playlist/artist.
        """
        token = await self.get_access_token()
        params = {"device_id": device_id} if device_id else None
        body: dict[str, Any] = {}
        if uris:
            body["uris"] = uris
        if context_uri:
            body["context_uri"] = context_uri
        await self._playback_call("PUT", "/me/player/play", token, params=params, json=body or None)

    async def pause(self, *, device_id: str | None = None) -> None:
        token = await self.get_access_token()
        params = {"device_id": device_id} if device_id else None
        await self._playback_call("PUT", "/me/player/pause", token, params=params)

    async def next_track(self, *, device_id: str | None = None) -> None:
        token = await self.get_access_token()
        params = {"device_id": device_id} if device_id else None
        await self._playback_call("POST", "/me/player/next", token, params=params)

    async def previous_track(self, *, device_id: str | None = None) -> None:
        token = await self.get_access_token()
        params = {"device_id": device_id} if device_id else None
        await self._playback_call("POST", "/me/player/previous", token, params=params)

    async def transfer_playback(self, device_id: str, *, play: bool = True) -> None:
        """Move playback to the given device, optionally starting it."""
        token = await self.get_access_token()
        body: dict[str, Any] = {"device_ids": [device_id], "play": play}
        await self._playback_call("PUT", "/me/player", token, json=body)

    async def search_track(self, query: str) -> str | None:
        """Find the top matching track URI for a free-form query.

        Used by the chat tool: "Alfred, play something by Foals" →
        search → take the top hit's URI → ``play(uris=[uri])``.
        Returns ``None`` if Spotify finds nothing.
        """
        token = await self.get_access_token()
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.get(
                f"{_API_BASE}/search",
                headers=self._auth_headers(token),
                params={"q": query, "type": "track", "limit": 1},
            )
        if response.status_code >= 400:
            raise SpotifyError(
                f"Spotify search returned HTTP {response.status_code}: "
                f"{response.text[:200]}"
            )
        body: dict[str, Any] = response.json()
        tracks: dict[str, Any] = body.get("tracks") or {}
        items: list[dict[str, Any]] = tracks.get("items") or []
        if not items:
            return None
        uri = items[0].get("uri")
        return str(uri) if uri else None

    async def audio_analysis(self, track_id: str) -> dict[str, Any]:
        """Fetch beat/segment-level analysis for the visualizer.

        Spotify's audio-analysis endpoint returns a fairly large JSON
        document (~50-200 KB) describing beats, bars, sections, and
        per-segment loudness/timbre. The frontend uses ``segments`` to
        drive the spectrum bars.
        """
        if not track_id:
            raise SpotifyError("track_id is required for audio analysis.")
        token = await self.get_access_token()
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.get(
                f"{_API_BASE}/audio-analysis/{track_id}",
                headers=self._auth_headers(token),
            )
        if response.status_code == 404:
            raise SpotifyError("No audio analysis available for that track.")
        if response.status_code >= 400:
            raise SpotifyError(
                f"Spotify audio-analysis returned HTTP {response.status_code}: "
                f"{response.text[:200]}"
            )
        return cast(dict[str, Any], response.json())

    # ─── Internals ───────────────────────────────────────────────────

    async def _load_account(self) -> SpotifyAccount | None:
        result = await self._session.execute(
            select(SpotifyAccount).where(SpotifyAccount.account_key == "default")
        )
        return result.scalar_one_or_none()

    async def _require_account(self) -> SpotifyAccount:
        if not self._settings.has_spotify:
            raise SpotifyUnconfiguredError(
                "Spotify isn't configured. Set ALFRED_SPOTIFY_CLIENT_ID + "
                "ALFRED_SPOTIFY_CLIENT_SECRET in .env."
            )
        account = await self._load_account()
        if account is None:
            raise SpotifyNotLinkedError(
                "Spotify isn't linked yet. Click the Connect Spotify button "
                "in Alfred's UI to authorize the integration."
            )
        return account

    def _basic_auth(self) -> str:
        creds = (
            f"{self._settings.alfred_spotify_client_id}:"
            f"{self._settings.alfred_spotify_client_secret}"
        )
        return "Basic " + base64.b64encode(creds.encode("utf-8")).decode("ascii")

    @staticmethod
    def _auth_headers(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    @staticmethod
    def _expiry_from(token_payload: dict[str, Any]) -> datetime:
        raw_ttl = token_payload.get("expires_in") or 0
        ttl = int(raw_ttl) if isinstance(raw_ttl, (int, float, str)) else 0
        return datetime.now(UTC) + timedelta(seconds=max(ttl, 30))

    async def _exchange_code(self, code: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.post(
                f"{_AUTH_BASE}/api/token",
                headers={
                    "Authorization": self._basic_auth(),
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": self._settings.alfred_spotify_redirect_uri,
                },
            )
        if response.status_code >= 400:
            raise SpotifyError(
                f"Token exchange failed (HTTP {response.status_code}): "
                f"{response.text[:200]}"
            )
        return cast(dict[str, Any], response.json())

    async def _refresh(self, refresh_token: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.post(
                f"{_AUTH_BASE}/api/token",
                headers={
                    "Authorization": self._basic_auth(),
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                },
            )
        if response.status_code >= 400:
            # If the refresh token is rejected the user has to re-link;
            # surface that distinctly so the UI can prompt them.
            if response.status_code == 400:
                raise SpotifyNotLinkedError(
                    "Spotify rejected the refresh token; please reconnect."
                )
            raise SpotifyError(
                f"Token refresh failed (HTTP {response.status_code}): "
                f"{response.text[:200]}"
            )
        return cast(dict[str, Any], response.json())

    async def _fetch_profile(self, access_token: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.get(
                f"{_API_BASE}/me",
                headers=self._auth_headers(access_token),
            )
        if response.status_code >= 400:
            raise SpotifyError(
                f"Couldn't fetch Spotify profile (HTTP {response.status_code})."
            )
        return cast(dict[str, Any], response.json())

    async def _playback_call(
        self,
        method: str,
        path: str,
        token: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, Any] | None = None,
    ) -> None:
        """Issue a playback-control call and translate Spotify's quirks."""
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            response = await client.request(
                method,
                f"{_API_BASE}{path}",
                headers=self._auth_headers(token),
                params=params,
                json=json,
            )
        # 204 is the success signal for most playback calls.
        if response.status_code in (200, 202, 204):
            return
        if response.status_code == 401:
            raise SpotifyError(
                "Spotify rejected the access token; try reconnecting."
            )
        if response.status_code == 403:
            # 403 typically means "Premium required" or "restriction
            # violated" (e.g. skipping in a non-premium region). Pass
            # the body through so the user knows what's actually wrong.
            detail = response.text[:200]
            raise SpotifyError(
                "Spotify refused the playback request — this usually "
                f"means Premium is required: {detail}"
            )
        if response.status_code == 404:
            # 404 from /me/player typically means "no active device".
            # Spell that out — telling the user "Spotify returned 404"
            # is useless.
            raise SpotifyError(
                "No active Spotify device. Open the Spotify app on your "
                "phone or desktop, or click Alfred as a Connect device "
                "in the HUD, then try again."
            )
        if response.status_code >= 400:
            raise SpotifyError(
                f"Spotify call to {path} returned HTTP {response.status_code}: "
                f"{response.text[:200]}"
            )
