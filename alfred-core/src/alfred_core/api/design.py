"""Onshape integration endpoints used by the Design3DView.

Thin proxy that signs every request server-side (the access/secret
pair stays in the backend container's environment, never the
browser) and exposes a slim JSON API:

  GET  /api/design/status                 — config + ready/not-ready flag
  GET  /api/design/documents              — list user's documents
  GET  /api/design/documents/{id}         — list elements inside a doc
  GET  /api/design/documents/{id}/thumbnail — PNG (image proxy)
  POST /api/design/documents              — create a new blank doc

The router intentionally mirrors the Spotify integration's shape so
we get consistent error semantics across the radial-menu apps:

  - 503 for "configured but Onshape itself is unhappy"
  - 409 for "not configured / not linked"
  - 4xx forwarded as a polite ``OnshapeError`` body
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from alfred_core.config import Settings, get_settings
from alfred_core.tools.onshape import (
    OnshapeClient,
    OnshapeError,
    OnshapeUnconfiguredError,
    build_onshape_client,
)

router = APIRouter(prefix="/api/design", tags=["design"])


# ─── Schemas ──────────────────────────────────────────────────────────


class StatusResponse(BaseModel):
    configured: bool
    api_base: str = Field(
        default="",
        description="Onshape API base URL the backend will hit.",
    )


class DocumentSummary(BaseModel):
    id: str
    name: str
    owner: str
    modified_at: str
    created_at: str
    default_workspace_id: str
    has_thumbnail: bool


class DocumentList(BaseModel):
    items: list[DocumentSummary]


class ElementSummary(BaseModel):
    id: str
    name: str
    type: str
    document_id: str
    workspace_id: str


class ElementList(BaseModel):
    items: list[ElementSummary]


class CreateDocumentRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)


# ─── Helpers ──────────────────────────────────────────────────────────


def _client(settings: Settings) -> OnshapeClient:
    """Construct a request-scoped Onshape client.

    Wrapped in its own helper so the unconfigured-error → 409 mapping
    can stay in one place. ``OnshapeError`` from inside the actual
    request maps to 503 (transient — Onshape is down or the keys are
    invalid).
    """
    try:
        return build_onshape_client(settings)
    except OnshapeUnconfiguredError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


# ─── Endpoints ────────────────────────────────────────────────────────


@router.get("/status", response_model=StatusResponse)
async def status(settings: Settings = Depends(get_settings)) -> StatusResponse:
    """Return whether Onshape is wired up — used by the Design view to
    show a "configure Onshape" hint when the keys aren't set."""
    return StatusResponse(
        configured=settings.has_onshape,
        api_base=settings.alfred_onshape_api_base,
    )


@router.get("/documents", response_model=DocumentList)
async def list_documents(
    q: str | None = Query(default=None, description="Free-text search filter"),
    limit: int = Query(default=20, ge=1, le=20),
    offset: int = Query(default=0, ge=0),
    settings: Settings = Depends(get_settings),
) -> DocumentList:
    """List the user's documents (most-recently-modified first)."""
    client = _client(settings)
    try:
        items = await client.list_documents(query=q, limit=limit, offset=offset)
    except OnshapeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return DocumentList(items=[DocumentSummary(**i) for i in items])


@router.get("/documents/{document_id}", response_model=ElementList)
async def list_elements(
    document_id: str,
    settings: Settings = Depends(get_settings),
) -> ElementList:
    """List Part Studios / Assemblies inside a document."""
    client = _client(settings)
    try:
        items = await client.list_document_elements(document_id)
    except OnshapeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return ElementList(items=[ElementSummary(**i) for i in items])


@router.get("/documents/{document_id}/thumbnail")
async def document_thumbnail(
    document_id: str,
    size: str = Query(default="300x300", pattern=r"^\d{2,4}x\d{2,4}$"),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Stream the PNG thumbnail for a document.

    We deliberately return ``Response`` (not ``StreamingResponse``) —
    the underlying httpx call already buffers the whole body, and a
    bare ``Response`` lets us set ``Cache-Control`` cleanly. Cache for
    5 minutes; thumbnails update slowly on Onshape's side.
    """
    client = _client(settings)
    try:
        png = await client.get_document_thumbnail(document_id, size=size)
    except OnshapeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.post("/documents", response_model=DocumentSummary)
async def create_document(
    payload: CreateDocumentRequest,
    settings: Settings = Depends(get_settings),
) -> DocumentSummary:
    """Create a new blank document and return its summary."""
    client = _client(settings)
    try:
        doc: dict[str, Any] = await client.create_document(payload.name)
    except OnshapeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return DocumentSummary(**doc)
