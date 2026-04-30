"""Tests for the vitals self-diagnostics endpoint."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alfred_core.api import vitals as vitals_mod
from alfred_core.config import Settings, get_settings


def _make_app(settings: Settings) -> FastAPI:
    """A standalone FastAPI app wrapping just the vitals router with a
    no-op DB session — we don't want this test pulling in Postgres."""
    app = FastAPI()
    app.include_router(vitals_mod.router, prefix="/api")
    app.dependency_overrides[get_settings] = lambda: settings

    # Stub the DB session dependency. The vitals DB check just runs
    # ``SELECT 1`` on whatever it gets, so we hand it an object that
    # ``await session.execute(text)`` is happy with.
    class _StubSession:
        async def execute(self, _sql: Any) -> None:
            return None

    from alfred_core.db.session import get_session

    app.dependency_overrides[get_session] = lambda: _StubSession()
    return app


def _ollama_mock(monkeypatch: pytest.MonkeyPatch, *, status: str) -> None:
    """Patch httpx.AsyncClient inside the vitals module so the Ollama
    probe doesn't actually hit the network."""

    class _Resp:
        def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
            self.status_code = status_code
            self._payload = payload

        def raise_for_status(self) -> None:
            if self.status_code >= 400:
                raise httpx.HTTPStatusError(
                    "boom",
                    request=httpx.Request("GET", "http://x"),
                    response=httpx.Response(self.status_code),
                )

        def json(self) -> dict[str, Any]:
            return self._payload

    class _Client:
        def __init__(self, *_a: Any, **_kw: Any) -> None:
            pass

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *_a: Any) -> None:
            return None

        async def get(self, _url: str) -> _Resp:
            if status == "ok":
                return _Resp(
                    200,
                    {"models": [{"name": "dolphin-llama3:8b-v2.9-q4_K_M"}]},
                )
            if status == "missing-model":
                return _Resp(200, {"models": []})
            if status == "down":
                raise httpx.ConnectError("connection refused")
            raise AssertionError(f"unknown stub status {status!r}")

    monkeypatch.setattr(vitals_mod.httpx, "AsyncClient", _Client)


def test_vitals_when_everything_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stock dev settings: no cloud key, no Tavily, no Spotify, no
    Gmail. Vitals should still return 200 and label each as ``off``
    rather than crashing."""
    s = Settings(
        alfred_password_hash="",
        alfred_jwt_secret="x" * 64,
        local_model_chat="",  # turn off ollama check too
    )
    app = _make_app(s)
    with TestClient(app) as client:
        r = client.get("/api/vitals")
        assert r.status_code == 200
        rows = {v["id"]: v for v in r.json()["vitals"]}
        # Every id must be present
        assert set(rows) == {"ollama", "cloud", "db", "tavily", "gmail", "spotify", "printer"}
        # Stock dev = nothing wired except DB
        assert rows["ollama"]["status"] == "off"
        assert rows["cloud"]["status"] == "off"
        assert rows["tavily"]["status"] == "off"
        assert rows["gmail"]["status"] == "off"
        assert rows["spotify"]["status"] == "off"
        assert rows["printer"]["status"] == "off"
        assert rows["db"]["status"] == "ok"


def test_vitals_ollama_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    s = Settings(
        alfred_password_hash="",
        alfred_jwt_secret="x" * 64,
        local_model_chat="dolphin-llama3:8b-v2.9-q4_K_M",
    )
    _ollama_mock(monkeypatch, status="ok")
    app = _make_app(s)
    with TestClient(app) as client:
        r = client.get("/api/vitals")
        assert r.status_code == 200
        rows = {v["id"]: v for v in r.json()["vitals"]}
        assert rows["ollama"]["status"] == "ok"
        assert "ready" in rows["ollama"]["detail"].lower()


def test_vitals_ollama_warns_on_missing_model(monkeypatch: pytest.MonkeyPatch) -> None:
    s = Settings(
        alfred_password_hash="",
        alfred_jwt_secret="x" * 64,
        local_model_chat="dolphin-llama3:8b-v2.9-q4_K_M",
    )
    _ollama_mock(monkeypatch, status="missing-model")
    app = _make_app(s)
    with TestClient(app) as client:
        r = client.get("/api/vitals")
        rows = {v["id"]: v for v in r.json()["vitals"]}
        assert rows["ollama"]["status"] == "warn"
        assert "ollama pull" in rows["ollama"]["fix"]


def test_vitals_ollama_err_when_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    s = Settings(
        alfred_password_hash="",
        alfred_jwt_secret="x" * 64,
        local_model_chat="dolphin-llama3:8b-v2.9-q4_K_M",
    )
    _ollama_mock(monkeypatch, status="down")
    app = _make_app(s)
    with TestClient(app) as client:
        r = client.get("/api/vitals")
        rows = {v["id"]: v for v in r.json()["vitals"]}
        assert rows["ollama"]["status"] == "err"
        assert "ollama serve" in rows["ollama"]["fix"]


def test_vitals_cloud_ok_when_anthropic_configured() -> None:
    s = Settings(
        alfred_password_hash="",
        alfred_jwt_secret="x" * 64,
        local_model_chat="",
        anthropic_api_key="sk-ant-fake",
    )
    app = _make_app(s)
    with TestClient(app) as client:
        r = client.get("/api/vitals")
        rows = {v["id"]: v for v in r.json()["vitals"]}
        assert rows["cloud"]["status"] == "ok"
