"""Valhalla routing proxy.

Proxies the frontend's routing / isochrone / map-matching requests
through ``alfred-core`` to Stadia Maps (or a self-hosted Valhalla
Docker instance) so the browser never talks to Stadia directly. We
take this round-trip for three reasons:

1. **Origin restrictions** — Stadia's hosted keys require the calling
   origin to be a real (non-``localhost``) domain whitelisted on the
   property. From a laptop running ``docker compose``, the browser's
   origin is ``http://localhost:3000`` and Stadia rejects it as a
   "root domain". Routing the request through ``alfred-core`` makes
   the originating IP the *server*, which Stadia accepts on any
   key without the origin check.

2. **Key hygiene** — the Stadia key never lands in the JS bundle.
   Browsers DevTools / cached service workers / curious phone-LAN
   users on Tailscale never see it.

3. **Swap path** — flip ``VALHALLA_BASE_URL`` to ``http://valhalla:8002``
   when the user later spins up a self-hosted ``gisops/valhalla``
   service alongside ``alfred-core``. No frontend rebuild needed.

The router whitelists exactly the eight Valhalla v1 endpoints the
frontend needs and pipes the request body through unchanged. The
backend deliberately doesn't try to validate the payload — Valhalla
itself returns rich JSON errors that the frontend already surfaces.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, Response

from alfred_core.config import Settings, get_settings

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/routing", tags=["routing"])

# Whitelist the exact Valhalla endpoints the frontend uses. Anything
# else 404s — we don't want to be a generic proxy.
_ALLOWED_ENDPOINTS: frozenset[str] = frozenset({
    "route",
    "isochrone",
    "sources_to_targets",
    "optimized_route",
    "trace_route",
    "trace_attributes",
    "height",
    "locate",
    "expansion",
    "status",
})


def _resolve_base(settings: Settings) -> tuple[str, dict[str, str], bool]:
    """Pick the upstream Valhalla URL + auth.

    Returns ``(base_url_without_trailing_slash, query_params, is_stadia)``.
    """
    self_host = (settings.valhalla_base_url or "").strip().rstrip("/")
    if self_host:
        return self_host, {}, False
    key = (settings.stadia_api_key or "").strip()
    if not key:
        raise HTTPException(
            status_code=503,
            detail=(
                "Routing isn't configured. Set STADIA_API_KEY in .env "
                "(get one at https://client.stadiamaps.com) or "
                "VALHALLA_BASE_URL to a self-hosted Valhalla instance, "
                "then `docker compose restart alfred-core`."
            ),
        )
    # Stadia exposes Valhalla under ``/valhalla/v1``.
    return "https://api.stadiamaps.com/valhalla/v1", {"api_key": key}, True


@router.get("/status")
async def routing_status(
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Cheap readiness probe.

    The frontend's "Wingman" diagnostic page hits this to tell the
    user whether routing is wired up at all — and which backend
    (hosted Stadia vs. self-hosted Valhalla) it'll be using.
    """
    self_host = (settings.valhalla_base_url or "").strip()
    key = (settings.stadia_api_key or "").strip()
    if self_host:
        return {"configured": True, "backend": "self_hosted", "base_url": self_host}
    if key:
        return {"configured": True, "backend": "stadia", "base_url": "https://api.stadiamaps.com"}
    return {
        "configured": False,
        "backend": None,
        "fix_hint": (
            "Set STADIA_API_KEY in .env (signup: "
            "https://client.stadiamaps.com), or VALHALLA_BASE_URL to a "
            "self-hosted Valhalla instance, then `docker compose restart "
            "alfred-core`."
        ),
    }


@router.post("/{endpoint}")
async def proxy(
    endpoint: str,
    payload: dict[str, Any],
    settings: Settings = Depends(get_settings),
) -> Response:
    """Proxy ``POST /api/routing/<endpoint>`` to Valhalla.

    The frontend speaks Valhalla v1 JSON directly — we just relay the
    request and pipe the response body back. Errors from Valhalla
    (4xx with a ``{"error": ...}`` body) propagate to the frontend
    so the chat handler can surface the upstream message verbatim
    instead of guessing.
    """
    if endpoint not in _ALLOWED_ENDPOINTS:
        raise HTTPException(
            status_code=404,
            detail=f"Endpoint '{endpoint}' isn't whitelisted on the routing proxy.",
        )
    base, params, _is_stadia = _resolve_base(settings)
    url = f"{base}/{endpoint}"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(url, json=payload, params=params)
    except httpx.HTTPError as e:
        _log.warning("Valhalla proxy network error: %s", e)
        raise HTTPException(
            status_code=502,
            detail=f"Couldn't reach the routing backend: {e!s}",
        ) from e
    # Pass the body through as JSON when it's JSON; otherwise raw.
    # Stadia and Valhalla both always reply with JSON on success or
    # error, but we don't want to crash if a gateway returns HTML.
    content_type = resp.headers.get("content-type", "application/json")
    if "json" in content_type.lower():
        try:
            return JSONResponse(
                content=resp.json(),
                status_code=resp.status_code,
            )
        except ValueError:
            # Body claimed JSON but isn't — fall through to raw passthrough.
            pass
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=content_type,
    )
