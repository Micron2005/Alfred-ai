"""Tests for the in-memory device-location store."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from alfred_core.api import location as location_module


@pytest.fixture(autouse=True)
def _clear_store() -> None:
    """Reset the global store between tests."""
    location_module._locations.clear()
    yield
    location_module._locations.clear()


@pytest.fixture()
def client() -> TestClient:
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(location_module.router)
    return TestClient(app)


def test_post_then_list(client: TestClient) -> None:
    resp = client.post(
        "/api/location/me",
        json={"device_id": "iphone", "lat": 40.71, "lon": -74.0, "label": "iPhone"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["device_id"] == "iphone"
    assert body["lat"] == 40.71

    resp2 = client.get("/api/location/all")
    assert resp2.status_code == 200
    assert len(resp2.json()["items"]) == 1


def test_overwrite_keeps_one_entry(client: TestClient) -> None:
    """Posting the same device_id twice overwrites — doesn't duplicate."""
    client.post(
        "/api/location/me",
        json={"device_id": "iphone", "lat": 40.71, "lon": -74.0},
    )
    client.post(
        "/api/location/me",
        json={"device_id": "iphone", "lat": 40.72, "lon": -74.0},
    )
    items = client.get("/api/location/all").json()["items"]
    assert len(items) == 1
    assert items[0]["lat"] == 40.72


def test_validates_lat_range(client: TestClient) -> None:
    resp = client.post(
        "/api/location/me",
        json={"device_id": "x", "lat": 91.0, "lon": 0.0},
    )
    assert resp.status_code == 422


def test_forget_removes(client: TestClient) -> None:
    client.post(
        "/api/location/me",
        json={"device_id": "iphone", "lat": 40.71, "lon": -74.0},
    )
    resp = client.delete("/api/location/iphone")
    assert resp.status_code == 200
    assert resp.json()["forgotten"] is True
    items = client.get("/api/location/all").json()["items"]
    assert len(items) == 0


def test_prune_drops_stale(client: TestClient) -> None:
    """Locations older than 24h are pruned on the next read."""
    location_module._locations["old"] = {
        "device_id": "old",
        "lat": 0,
        "lon": 0,
        "accuracy_m": None,
        "label": "old",
        "ts": time.time() - 25 * 3600,
    }
    items = client.get("/api/location/all").json()["items"]
    assert len(items) == 0


def test_max_devices_enforced(client: TestClient) -> None:
    """Beyond the 50-device cap, oldest entry is dropped."""
    for i in range(51):
        client.post(
            "/api/location/me",
            json={"device_id": f"d{i}", "lat": 0.0, "lon": 0.0},
        )
        # Manually backdate so insertion order != ts order
        location_module._locations[f"d{i}"]["ts"] = time.time() + i

    # We've pushed 51 entries; the cap is 50 so one must have been dropped.
    items = client.get("/api/location/all").json()["items"]
    assert len(items) == 50
    # The newest 50 (d1..d50) survived; d0 (oldest ts) is gone.
    ids = {it["device_id"] for it in items}
    assert "d0" not in ids
