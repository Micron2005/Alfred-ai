"""Printer endpoints — proxy to Moonraker on the user's K1 / K1 Max.

The real printer URL never reaches the browser — the frontend
talks to ``/printer/*`` here, and the server holds
``ALFRED_PRINTER_URL`` + ``ALFRED_PRINTER_API_KEY`` from ``.env``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from alfred_core.config import get_settings
from alfred_core.printer.moonraker import MoonrakerClient, PrinterStatus

router = APIRouter(prefix="/printer", tags=["printer"])


def _client() -> MoonrakerClient:
    settings = get_settings()
    return MoonrakerClient(
        base_url=settings.alfred_printer_url or None,
        api_key=settings.alfred_printer_api_key or None,
    )


@router.get("/status", response_model=PrinterStatus)
async def status() -> PrinterStatus:
    return await _client().status()


@router.post("/pause")
async def pause() -> dict[str, str]:
    try:
        await _client().pause()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"status": "ok"}


@router.post("/resume")
async def resume() -> dict[str, str]:
    try:
        await _client().resume()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"status": "ok"}


@router.post("/cancel")
async def cancel() -> dict[str, str]:
    try:
        await _client().cancel()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"status": "ok"}
