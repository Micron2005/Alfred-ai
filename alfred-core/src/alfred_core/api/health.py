"""Health check endpoints."""

from __future__ import annotations

from fastapi import APIRouter

from alfred_core import __version__

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}
