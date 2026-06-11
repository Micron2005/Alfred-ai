"""Tests for the Valhalla routing proxy (``/api/routing/*``).

The proxy itself is thin — we test it by stubbing ``httpx.AsyncClient``
so we never hit the network. The tests exercise:

- ``/status`` when nothing is configured
- ``/status`` when ``STADIA_API_KEY`` is set
- ``/status`` when ``VALHALLA_BASE_URL`` overrides the Stadia key
- ``/route`` proxies the body through and returns the upstream JSON
- Unknown endpoints get a 404
- Network errors get a clear 502
- Backend 503 when no upstream is configured at all
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alfred_core.api import routing as routing_module
from alfred_core.config import get_settings


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(routing_module.router)
    return app


def _override_settings(*, stadia: str = "", base: str = ""):
    def _factory():
        s = get_settings()
        object.__setattr__(s, "stadia_api_key", stadia)
        object.__setattr__(s, "valhalla_base_url", base)
        return s

    return _factory


def test_status_unconfigured() -> None:
    app = _make_app()
    app.dependency_overrides[get_settings] = _override_settings()
    cli = TestClient(app)
    resp = cli.get("/api/routing/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is False
    assert body["backend"] is None
    assert "STADIA_API_KEY" in body["fix_hint"]


def test_status_stadia_configured() -> None:
    app = _make_app()
    app.dependency_overrides[get_settings] = _override_settings(stadia="testkey")
    cli = TestClient(app)
    resp = cli.get("/api/routing/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is True
    assert body["backend"] == "stadia"


def test_status_self_host_wins() -> None:
    """When both ``VALHALLA_BASE_URL`` and ``STADIA_API_KEY`` are set,
    the self-host URL wins. The frontend never sees the Stadia key
    and the proxy never bothers Stadia."""
    app = _make_app()
    app.dependency_overrides[get_settings] = _override_settings(
        stadia="testkey", base="http://valhalla:8002",
    )
    cli = TestClient(app)
    resp = cli.get("/api/routing/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is True
    assert body["backend"] == "self_hosted"
    assert body["base_url"] == "http://valhalla:8002"


def test_route_unknown_endpoint() -> None:
    app = _make_app()
    app.dependency_overrides[get_settings] = _override_settings(stadia="k")
    cli = TestClient(app)
    resp = cli.post("/api/routing/eat_my_shorts", json={})
    assert resp.status_code == 404


def test_route_unconfigured_returns_503() -> None:
    app = _make_app()
    app.dependency_overrides[get_settings] = _override_settings()
    cli = TestClient(app)
    resp = cli.post("/api/routing/route", json={"locations": [], "costing": "auto"})
    assert resp.status_code == 503
    assert "STADIA_API_KEY" in resp.json()["detail"]


def test_route_proxies_body_and_response(monkeypatch: pytest.MonkeyPatch) -> None:
    """Happy path — the proxy forwards the JSON body to Valhalla and
    returns the upstream JSON verbatim."""

    fake_response = {
        "trip": {
            "legs": [{"shape": "abc", "summary": {"length": 12.4, "time": 600}}],
            "summary": {"length": 12.4, "time": 600},
            "status": 0,
            "status_message": "Found route between points",
            "units": "miles",
        }
    }
    captured: dict[str, Any] = {}

    class _FakeResponse:
        status_code = 200
        headers = {"content-type": "application/json"}
        content = b""

        def json(self) -> dict[str, Any]:
            return fake_response

    class _FakeClient:
        def __init__(self, *_: Any, **__: Any) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc: Any) -> None:
            return None

        async def post(self, url: str, json: Any, params: Any) -> _FakeResponse:
            captured["url"] = url
            captured["json"] = json
            captured["params"] = params
            return _FakeResponse()

    monkeypatch.setattr(routing_module.httpx, "AsyncClient", _FakeClient)

    app = _make_app()
    app.dependency_overrides[get_settings] = _override_settings(stadia="testkey")
    cli = TestClient(app)
    payload = {
        "locations": [
            {"lat": 38.3, "lon": -77.4, "type": "break"},
            {"lat": 40.6, "lon": -73.7, "type": "break"},
        ],
        "costing": "auto",
        "directions_options": {"units": "miles"},
    }
    resp = cli.post("/api/routing/route", json=payload)
    assert resp.status_code == 200
    assert resp.json() == fake_response
    assert captured["url"] == "https://api.stadiamaps.com/valhalla/v1/route"
    assert captured["json"] == payload
    assert captured["params"] == {"api_key": "testkey"}


def test_route_self_host_omits_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Self-host mode must NOT send the Stadia api_key — the open-
    source Valhalla rejects unexpected query params on some
    deployments."""
    captured: dict[str, Any] = {}

    class _FakeResponse:
        status_code = 200
        headers = {"content-type": "application/json"}
        content = b""

        def json(self) -> dict[str, Any]:
            return {"ok": True}

    class _FakeClient:
        def __init__(self, *_: Any, **__: Any) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc: Any) -> None:
            return None

        async def post(self, url: str, json: Any, params: Any) -> _FakeResponse:
            captured["url"] = url
            captured["params"] = params
            return _FakeResponse()

    monkeypatch.setattr(routing_module.httpx, "AsyncClient", _FakeClient)

    app = _make_app()
    app.dependency_overrides[get_settings] = _override_settings(
        stadia="testkey", base="http://valhalla:8002",
    )
    cli = TestClient(app)
    resp = cli.post("/api/routing/route", json={"locations": [], "costing": "auto"})
    assert resp.status_code == 200
    assert captured["url"] == "http://valhalla:8002/route"
    assert captured["params"] == {}


def test_route_network_error_returns_502(monkeypatch: pytest.MonkeyPatch) -> None:
    class _FakeClient:
        def __init__(self, *_: Any, **__: Any) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc: Any) -> None:
            return None

        async def post(self, *_: Any, **__: Any) -> None:
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(routing_module.httpx, "AsyncClient", _FakeClient)

    app = _make_app()
    app.dependency_overrides[get_settings] = _override_settings(stadia="k")
    cli = TestClient(app)
    resp = cli.post("/api/routing/route", json={})
    assert resp.status_code == 502
    assert "connection refused" in resp.json()["detail"]


def test_route_upstream_error_passthrough(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 4xx from Stadia should bubble up with the upstream JSON body
    so the frontend's user-facing message can quote the real error."""

    class _FakeResponse:
        status_code = 400
        headers = {"content-type": "application/json"}
        content = b""

        def json(self) -> dict[str, Any]:
            return {"error_code": 154, "error": "No through route found between locations"}

    class _FakeClient:
        def __init__(self, *_: Any, **__: Any) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc: Any) -> None:
            return None

        async def post(self, *_: Any, **__: Any) -> _FakeResponse:
            return _FakeResponse()

    monkeypatch.setattr(routing_module.httpx, "AsyncClient", _FakeClient)

    app = _make_app()
    app.dependency_overrides[get_settings] = _override_settings(stadia="k")
    cli = TestClient(app)
    resp = cli.post("/api/routing/route", json={})
    assert resp.status_code == 400
    assert resp.json()["error_code"] == 154
