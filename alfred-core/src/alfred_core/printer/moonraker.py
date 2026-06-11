"""Moonraker HTTP API client for Klipper-based printers (incl. Creality K1 / K1 Max).

Moonraker spec: https://moonraker.readthedocs.io/en/latest/web_api/

We deliberately keep this client minimal — only the four
operations Alfred actually exposes to the user (status, pause,
resume, cancel) plus a helper to upload + start a gcode file.
Anything else the user wants can be reached via the printer's
Moonraker UI directly.

Design notes
------------
- The K1 / K1 Max ship with Moonraker already enabled and listening
  on port 7125 of the printer's LAN IP. No auth by default; if the
  user has put their printer behind a reverse-proxy with an API
  token, set ``ALFRED_PRINTER_API_KEY`` in ``.env`` and we send it
  as the ``X-Api-Key`` header.
- Moonraker returns the live state through a single ``printer.objects.query``
  endpoint. We hit a curated subset of objects (print_stats,
  display_status, extruder, heater_bed, virtual_sdcard) so the
  payload is small enough to poll on a 3 s loop without breaking
  a Pi-hosted Moonraker instance.
- All blocking I/O is wrapped in async via httpx.AsyncClient so we
  don't block the FastAPI event loop.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class TempReading(BaseModel):
    actual: float = 0.0
    target: float = 0.0


class TempPair(BaseModel):
    extruder: TempReading = Field(default_factory=TempReading)
    bed: TempReading = Field(default_factory=TempReading)
    chamber: TempReading | None = None


class PrinterStatus(BaseModel):
    """Compact status payload Alfred renders in the Design tab strip."""

    state: str = "unknown"
    state_message: str = ""
    filename: str | None = None
    progress: float = 0.0
    print_duration: float = 0.0
    estimated_time_left_seconds: float | None = None
    temps: TempPair = Field(default_factory=TempPair)
    configured: bool = False


# Moonraker's print_stats.state values map roughly to ours like so;
# anything we don't recognize falls back to "unknown".
_STATE_MAP = {
    "standby": "ready",
    "printing": "printing",
    "paused": "paused",
    "complete": "ready",
    "cancelled": "ready",
    "error": "error",
}


class MoonrakerClient:
    """Thin async HTTP client around Moonraker.

    The constructor takes the printer's base URL (no trailing slash;
    ``http://192.168.1.42:7125``) and an optional API key. Both come
    from ``Settings`` so the secrets stay server-side.
    """

    def __init__(
        self,
        base_url: str | None,
        api_key: str | None = None,
        timeout: float = 4.0,
    ) -> None:
        self.base_url = base_url.rstrip("/") if base_url else ""
        self.api_key = api_key or ""
        self.timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def _headers(self) -> dict[str, str]:
        if self.api_key:
            return {"X-Api-Key": self.api_key}
        return {}

    async def status(self) -> PrinterStatus:
        if not self.configured:
            return PrinterStatus(state="disconnected", configured=False)
        url = (
            f"{self.base_url}/printer/objects/query"
            "?print_stats&display_status&extruder&heater_bed"
            "&heater_generic chamber&virtual_sdcard"
        )
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.get(url, headers=self._headers())
                resp.raise_for_status()
                payload = resp.json().get("result", {}).get("status", {})
        except httpx.HTTPError as exc:
            logger.warning("Moonraker status fetch failed: %s", exc)
            return PrinterStatus(
                state="disconnected",
                state_message=str(exc),
                configured=True,
            )
        return _parse_status(payload)

    async def pause(self) -> None:
        await self._post("/printer/print/pause")

    async def resume(self) -> None:
        await self._post("/printer/print/resume")

    async def cancel(self) -> None:
        await self._post("/printer/print/cancel")

    async def _post(self, path: str) -> None:
        if not self.configured:
            raise RuntimeError("Printer is not configured (ALFRED_PRINTER_URL is empty).")
        url = f"{self.base_url}{path}"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(url, headers=self._headers())
            resp.raise_for_status()


def _parse_status(payload: dict[str, Any]) -> PrinterStatus:
    print_stats = payload.get("print_stats", {})
    display_status = payload.get("display_status", {})
    extruder = payload.get("extruder", {})
    heater_bed = payload.get("heater_bed", {})
    chamber = payload.get("heater_generic chamber") or payload.get("chamber")
    virtual_sd = payload.get("virtual_sdcard", {})

    raw_state = (print_stats.get("state") or "").lower()
    state = _STATE_MAP.get(raw_state, "unknown")

    progress = float(display_status.get("progress") or 0.0)
    if not progress and virtual_sd:
        progress = float(virtual_sd.get("progress") or 0.0)
    progress = max(0.0, min(1.0, progress))

    print_duration = float(print_stats.get("print_duration") or 0.0)

    # Moonraker doesn't return ETA directly; estimate from elapsed
    # time + progress. Fall back to None on the very first second.
    eta: float | None = None
    if progress > 0.005 and print_duration > 0:
        total = print_duration / progress
        remaining = total - print_duration
        eta = max(0.0, remaining)

    temps = TempPair(
        extruder=TempReading(
            actual=float(extruder.get("temperature") or 0.0),
            target=float(extruder.get("target") or 0.0),
        ),
        bed=TempReading(
            actual=float(heater_bed.get("temperature") or 0.0),
            target=float(heater_bed.get("target") or 0.0),
        ),
        chamber=(
            TempReading(
                actual=float(chamber.get("temperature") or 0.0),
                target=float(chamber.get("target") or 0.0),
            )
            if chamber
            else None
        ),
    )

    filename = print_stats.get("filename") or None
    if filename == "":
        filename = None

    return PrinterStatus(
        state=state,
        state_message=print_stats.get("message") or "",
        filename=filename,
        progress=progress,
        print_duration=print_duration,
        estimated_time_left_seconds=eta,
        temps=temps,
        configured=True,
    )
