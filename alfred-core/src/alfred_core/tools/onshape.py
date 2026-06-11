"""Onshape API client.

Onshape uses an HMAC-SHA256 signature scheme for API authentication
that has a few notoriously easy-to-get-wrong corners. The full spec
lives at https://onshape-public.github.io/docs/api-intro/ but the
short version:

  - Every request carries three custom headers:
        On-Nonce  — random 25-char nonce
        Date      — RFC 1123 date in GMT
        Authorization — "On <ACCESS_KEY>:HmacSHA256:<base64sig>"
  - The signature is HMAC-SHA256(secret_key, signing_string), where
    signing_string concatenates (each lowercased, separated by '\\n'):
        method, nonce, date, content-type, path, query
  - Path is the URL path BELOW the API base (e.g. ``/api/v6/documents``)
  - Query is the URL-encoded query string sorted alphabetically by key
  - For GET / DELETE the body is empty and content-type is omitted

This module ships a slim async client with the four endpoints the
Design3DView needs:
    - list_documents
    - list_document_elements
    - get_document_thumbnail (returns PNG bytes)
    - create_document

Single-user only — keys live in the backend ``.env`` and are never
exposed to the frontend.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import string
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

import httpx

_API_BASE = "https://cad.onshape.com"  # Production base; user can override via env.
_HTTP_TIMEOUT = 20.0
_NONCE_ALPHA = string.ascii_letters + string.digits


class OnshapeUnconfiguredError(RuntimeError):
    """Onshape access/secret key pair is missing from the environment."""


class OnshapeError(RuntimeError):
    """A signed request reached Onshape but came back with a non-2xx
    status, or the network call itself failed. The message includes
    status + response body (truncated) so the API layer can surface
    a useful 503 to the frontend."""


class OnshapeClient:
    """Async Onshape REST client.

    Construct once per request via the FastAPI dependency below — the
    underlying ``httpx.AsyncClient`` is short-lived (one client per
    request) so we never have to worry about its event loop lifecycle.
    """

    def __init__(self, access_key: str, secret_key: str, *, api_base: str = _API_BASE) -> None:
        self._access_key = access_key
        self._secret_key = secret_key
        self._api_base = api_base.rstrip("/")

    # ─── Public API ──────────────────────────────────────────────────

    async def list_documents(
        self,
        *,
        query: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List the user's recent documents.

        ``query`` is a free-text filter; passing ``None`` returns the
        most-recently-modified docs (which is what people usually
        want from a "Design" tab home view).
        """
        params: dict[str, Any] = {
            "limit": min(20, max(1, limit)),  # Onshape caps at 20/page
            "offset": max(0, offset),
            "sortColumn": "modifiedAt",
            "sortOrder": "desc",
        }
        if query and query.strip():
            params["q"] = query.strip()
        body = await self._request("GET", "/api/v6/documents", params=params)
        items = body.get("items") if isinstance(body, dict) else None
        return [self._compact_document(d) for d in (items or []) if isinstance(d, dict)]

    async def list_document_elements(self, document_id: str) -> list[dict[str, Any]]:
        """List elements (Part Studios, Assemblies, …) inside a doc.

        We resolve the workspace ID via the document's
        ``defaultWorkspace`` because the elements endpoint requires
        ``/d/{did}/w/{wid}/elements`` — there's no standalone
        ``/documents/{did}/elements`` route.
        """
        if not document_id:
            raise OnshapeError("document_id is required.")
        # Step 1: fetch doc to find its default workspace ID.
        doc = await self._request("GET", f"/api/v6/documents/{document_id}")
        if not isinstance(doc, dict):
            raise OnshapeError("Onshape returned an unexpected document payload.")
        wid = ((doc.get("defaultWorkspace") or {}).get("id")) or ""
        if not wid:
            raise OnshapeError("Document has no default workspace; cannot list elements.")
        # Step 2: list elements in that workspace.
        body = await self._request(
            "GET", f"/api/v6/documents/d/{document_id}/w/{wid}/elements"
        )
        if not isinstance(body, list):
            return []
        return [
            self._compact_element(e, document_id=document_id, workspace_id=wid)
            for e in body
            if isinstance(e, dict)
        ]

    async def get_document_thumbnail(self, document_id: str, *, size: str = "300x300") -> bytes:
        """Fetch the auto-generated PNG thumbnail for a document."""
        if not document_id:
            raise OnshapeError("document_id is required.")
        path = f"/api/v6/thumbnails/d/{document_id}/s/{size}"
        # Thumbnail endpoint streams binary, so don't go through the
        # JSON helper — handle the response ourselves.
        return await self._raw_request("GET", path, accept="image/png")

    async def create_document(self, name: str) -> dict[str, Any]:
        """Create a new blank Onshape document and return its summary."""
        clean = (name or "").strip()
        if not clean:
            raise OnshapeError("name is required.")
        body = await self._request(
            "POST", "/api/v6/documents", json_body={"name": clean}
        )
        if not isinstance(body, dict):
            raise OnshapeError("Onshape returned an unexpected create payload.")
        return self._compact_document(body)

    # ─── Compact projections (slim payloads for the UI) ─────────────

    @staticmethod
    def _compact_document(doc: dict[str, Any]) -> dict[str, Any]:
        owner = doc.get("owner") or {}
        thumb_info = doc.get("thumbnail") or {}
        # Onshape returns href + sizes[]; we store the doc id so the
        # frontend can hit our proxy ``/api/design/documents/{id}/thumbnail``
        # (signed server-side) instead of the raw Onshape href (which
        # would require the secret on the client).
        return {
            "id": str(doc.get("id") or ""),
            "name": str(doc.get("name") or ""),
            "owner": str(owner.get("name") or ""),
            "modified_at": str(doc.get("modifiedAt") or ""),
            "created_at": str(doc.get("createdAt") or ""),
            "default_workspace_id": str(
                ((doc.get("defaultWorkspace") or {}).get("id")) or ""
            ),
            "has_thumbnail": bool(thumb_info),
        }

    @staticmethod
    def _compact_element(
        element: dict[str, Any], *, document_id: str, workspace_id: str
    ) -> dict[str, Any]:
        return {
            "id": str(element.get("id") or ""),
            "name": str(element.get("name") or ""),
            "type": str(element.get("elementType") or element.get("type") or ""),
            "document_id": document_id,
            "workspace_id": workspace_id,
        }

    # ─── HMAC signing + transport ───────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> Any:
        """Issue a signed JSON request and return the decoded response.

        Splits ``_raw_request`` so the JSON-decode + error-shaping is
        in one place; binary endpoints (thumbnails) skip the decode.
        """
        body_bytes = b""
        content_type = ""
        if json_body is not None:
            import json as _json

            body_bytes = _json.dumps(json_body).encode("utf-8")
            content_type = "application/json; charset=UTF-8"

        raw = await self._raw_request(
            method,
            path,
            params=params,
            body=body_bytes,
            content_type=content_type,
            accept="application/json",
        )
        if not raw:
            return None
        import json as _json

        try:
            return _json.loads(raw)
        except ValueError as exc:
            raise OnshapeError(
                f"Onshape returned non-JSON response (first 200 bytes: {raw[:200]!r})."
            ) from exc

    async def _raw_request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: bytes = b"",
        content_type: str = "",
        accept: str = "application/json",
    ) -> bytes:
        """Issue the signed HTTP request and return raw response bytes.

        Raises ``OnshapeError`` for any non-2xx status or transport
        failure so the API layer can fold the failure into a 503.
        """
        date = self._rfc1123_now()
        nonce = self._make_nonce()
        # Onshape signs a sorted, URL-encoded query string. Empty
        # params → empty string, NOT "?".
        query_string = ""
        if params:
            query_string = urlencode(sorted(params.items(), key=lambda kv: kv[0]))

        signature = self._sign(
            method=method,
            nonce=nonce,
            date=date,
            content_type=content_type,
            path=path,
            query=query_string,
        )

        headers: dict[str, str] = {
            "Date": date,
            "On-Nonce": nonce,
            "Authorization": f"On {self._access_key}:HmacSHA256:{signature}",
            "Accept": accept,
        }
        if content_type:
            headers["Content-Type"] = content_type

        url = f"{self._api_base}{path}"
        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
                resp = await client.request(
                    method,
                    url,
                    params=params,
                    content=body if body else None,
                    headers=headers,
                )
        except httpx.HTTPError as exc:
            raise OnshapeError(
                f"Couldn't reach Onshape ({exc.__class__.__name__})."
            ) from exc

        if resp.status_code >= 400:
            # Truncate the body so a giant HTML error page doesn't
            # clog up the chat reply / log line.
            text_preview = resp.text[:200] if resp.text else ""
            raise OnshapeError(
                f"Onshape API HTTP {resp.status_code}: {text_preview}"
            )
        return resp.content

    def _sign(
        self,
        *,
        method: str,
        nonce: str,
        date: str,
        content_type: str,
        path: str,
        query: str,
    ) -> str:
        """Build & return the base64-encoded HMAC-SHA256 signature.

        Onshape's signing string is EXACTLY seven lines — six fields
        each followed by ``\\n``, producing a trailing newline at the
        end. Every field is lowercased before concatenation. Dropping
        the trailing ``\\n`` produces a signature that validates
        locally against any hand-computed HMAC tool but is rejected
        by Onshape with a generic 401 "Unauthenticated". Reference:
        https://onshape-public.github.io/docs/auth/apikeys/ and the
        canonical ``onshape-public/apikey`` Node.js implementation.
        """
        signing = (
            "\n".join(
                [
                    method,
                    nonce,
                    date,
                    content_type,
                    path,
                    query,
                ]
            )
            + "\n"  # Trailing newline is mandatory — see docstring.
        ).lower().encode("utf-8")
        digest = hmac.new(
            self._secret_key.encode("utf-8"),
            signing,
            hashlib.sha256,
        ).digest()
        return base64.b64encode(digest).decode("ascii")

    @staticmethod
    def _rfc1123_now() -> str:
        """Return the current UTC time formatted per RFC 1123 (HTTP-date).

        Example: ``Wed, 30 Apr 2026 18:01:24 GMT``. ``%a``/``%b`` use
        the C locale (English short names), which is what Onshape
        expects regardless of the host's locale.
        """
        return datetime.now(UTC).strftime("%a, %d %b %Y %H:%M:%S GMT")

    @staticmethod
    def _make_nonce() -> str:
        """25-character ASCII nonce; Onshape rejects shorter/longer."""
        return "".join(secrets.choice(_NONCE_ALPHA) for _ in range(25))


def build_onshape_client(settings: Any) -> OnshapeClient:
    """Factory that reads keys from ``Settings`` and raises if missing.

    Used by the FastAPI dependency in ``api/design.py`` so the API
    layer can return a clean 503 if the user hasn't filled in their
    keys yet — instead of every endpoint raising a Pydantic validation
    error.
    """
    access = (getattr(settings, "alfred_onshape_access_key", "") or "").strip()
    secret = (getattr(settings, "alfred_onshape_secret_key", "") or "").strip()
    if not access or not secret:
        raise OnshapeUnconfiguredError(
            "Onshape isn't configured. Set ALFRED_ONSHAPE_ACCESS_KEY + "
            "ALFRED_ONSHAPE_SECRET_KEY in .env."
        )
    base = (
        getattr(settings, "alfred_onshape_api_base", "") or _API_BASE
    ).strip() or _API_BASE
    return OnshapeClient(access, secret, api_base=base)
