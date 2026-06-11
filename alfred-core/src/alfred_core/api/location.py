"""Device location tracking — used by the holographic Earth to show
where the user (and any other device they own) physically is.

Single-user app: locations are scoped by ``device_id`` (a label the
client picks, e.g. "iphone" / "laptop" / "main-pc"). The phone
PWA auto-registers as ``phone-<short-id>`` on first GPS share.

Storage is in-memory because:
  - locations are ephemeral (the user only cares about "where am I
    NOW", not "where was I last week");
  - the most recent fix per device is < 200 bytes, so a 50-device
    cap is < 10 KB; well within process memory;
  - persisting to Postgres would require a migration + serializer
    for a feature that's strictly real-time.

If you want history-tracking (breadcrumb trail / route replay),
swap the in-memory dict for a ``device_locations`` SQLAlchemy table.
"""

from __future__ import annotations

import time
from threading import Lock
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/location", tags=["location"])

_MAX_DEVICES = 50  # cap so a runaway client can't OOM the process
_STALE_AFTER_S = 60 * 60 * 24  # locations older than 24 h are pruned

_lock = Lock()
# device_id → {lat, lon, accuracy_m, label, ts}
_locations: dict[str, dict[str, Any]] = {}


class LocationUpdate(BaseModel):
    device_id: str = Field(..., min_length=1, max_length=64)
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0)
    label: str | None = Field(default=None, max_length=64)


class DeviceLocationOut(BaseModel):
    device_id: str
    lat: float
    lon: float
    accuracy_m: float | None = None
    label: str | None = None
    ts: float


class LocationListResponse(BaseModel):
    items: list[DeviceLocationOut]


def _prune_locked() -> None:
    """Drop entries older than _STALE_AFTER_S. Caller holds the lock."""
    cutoff = time.time() - _STALE_AFTER_S
    stale = [k for k, v in _locations.items() if v.get("ts", 0) < cutoff]
    for k in stale:
        _locations.pop(k, None)


@router.post("/me", response_model=DeviceLocationOut)
async def update_my_location(payload: LocationUpdate) -> DeviceLocationOut:
    """Record the latest GPS fix for ``device_id``.

    The phone PWA hits this on a 30 s interval while the user has
    location sharing enabled; the desktop hits it once on first
    load (no continuous polling — the desktop doesn't move).
    """
    record = {
        "device_id": payload.device_id,
        "lat": payload.lat,
        "lon": payload.lon,
        "accuracy_m": payload.accuracy_m,
        "label": payload.label or payload.device_id,
        "ts": time.time(),
    }
    with _lock:
        _prune_locked()
        if len(_locations) >= _MAX_DEVICES and payload.device_id not in _locations:
            # Drop the oldest non-conflicting entry to make room.
            oldest = min(_locations.items(), key=lambda kv: kv[1]["ts"])[0]
            _locations.pop(oldest, None)
        _locations[payload.device_id] = record
    return DeviceLocationOut(**record)


@router.get("/all", response_model=LocationListResponse)
async def list_locations() -> LocationListResponse:
    """Return every known device location sorted newest-first."""
    with _lock:
        _prune_locked()
        items = sorted(
            _locations.values(), key=lambda r: r["ts"], reverse=True
        )
    return LocationListResponse(items=[DeviceLocationOut(**r) for r in items])


@router.delete("/{device_id}")
async def forget_location(device_id: str) -> dict[str, bool]:
    """Manually remove a device's location (e.g. user revoked sharing)."""
    if not device_id:
        raise HTTPException(status_code=400, detail="device_id is required.")
    with _lock:
        existed = _locations.pop(device_id, None) is not None
    return {"forgotten": existed}
