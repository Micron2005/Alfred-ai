"""Unit tests for the Open-Meteo-backed forecast endpoint + service."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from alfred_core.api import weather as weather_api
from alfred_core.config import Settings, get_settings
from alfred_core.main import app
from alfred_core.weather import WeatherService

_SAMPLE_PAYLOAD: dict[str, Any] = {
    "timezone": "America/Chicago",
    "current": {
        "temperature_2m": 78.4,
        "apparent_temperature": 82.1,
        "relative_humidity_2m": 55,
        "weather_code": 2,
        "wind_speed_10m": 6.7,
        "is_day": 1,
    },
    "daily": {
        "time": [
            "2026-04-27",
            "2026-04-28",
            "2026-04-29",
            "2026-04-30",
            "2026-05-01",
            "2026-05-02",
            "2026-05-03",
        ],
        "weather_code": [2, 3, 61, 0, 1, 2, 80],
        "temperature_2m_max": [80, 78, 72, 85, 88, 86, 81],
        "temperature_2m_min": [62, 60, 58, 64, 67, 66, 63],
    },
}


def _patched_async_client(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    real = httpx.AsyncClient

    class _Patched(real):  # type: ignore[misc, valid-type]
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr("alfred_core.weather.httpx.AsyncClient", _Patched)


@pytest.mark.asyncio
async def test_get_forecast_parses_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "forecast" in str(request.url)
        return httpx.Response(200, json=_SAMPLE_PAYLOAD)

    _patched_async_client(monkeypatch, handler)
    service = WeatherService(latitude=30.0, longitude=-97.0, city_label="Austin, TX")
    forecast = await service.get_forecast()

    assert forecast is not None
    assert forecast.city == "Austin, TX"
    assert forecast.timezone == "America/Chicago"
    assert forecast.temperature_f == pytest.approx(78.4)
    assert forecast.feels_like_f == pytest.approx(82.1)
    assert forecast.humidity_pct == 55
    assert forecast.weather_code == 2
    assert forecast.is_day is True
    assert len(forecast.daily) == 7
    assert forecast.daily[0].date == "2026-04-27"
    assert forecast.daily[0].temperature_max_f == pytest.approx(80.0)
    assert forecast.daily[0].temperature_min_f == pytest.approx(62.0)
    assert forecast.daily[2].weather_code == 61


@pytest.mark.asyncio
async def test_get_forecast_returns_none_on_http_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    _patched_async_client(monkeypatch, handler)
    service = WeatherService(latitude=30.0, longitude=-97.0, city_label="Austin, TX")
    assert await service.get_forecast() is None


@pytest.mark.asyncio
async def test_get_forecast_uses_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Second call within the cache window must not hit the network."""
    calls = {"count": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(200, json=_SAMPLE_PAYLOAD)

    _patched_async_client(monkeypatch, handler)
    service = WeatherService(latitude=30.0, longitude=-97.0, city_label="Austin, TX")
    first = await service.get_forecast()
    second = await service.get_forecast()
    assert first is not None and second is not None
    assert calls["count"] == 1


def test_endpoint_returns_503_when_backend_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    _patched_async_client(monkeypatch, handler)
    # Reset module-level singleton so the test gets a fresh service.
    weather_api._service = None
    weather_api._service_key = None

    def _override() -> Settings:
        return Settings(
            alfred_location_city="Test City",
            alfred_location_latitude=30.0,
            alfred_location_longitude=-97.0,
        )

    app.dependency_overrides[get_settings] = _override
    try:
        client = TestClient(app)
        response = client.get("/api/weather/forecast")
        assert response.status_code == 503
    finally:
        app.dependency_overrides.pop(get_settings, None)
        weather_api._service = None
        weather_api._service_key = None


def test_endpoint_returns_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_SAMPLE_PAYLOAD)

    _patched_async_client(monkeypatch, handler)
    weather_api._service = None
    weather_api._service_key = None

    def _override() -> Settings:
        return Settings(
            alfred_location_city="Test City",
            alfred_location_latitude=30.0,
            alfred_location_longitude=-97.0,
        )

    app.dependency_overrides[get_settings] = _override
    try:
        client = TestClient(app)
        response = client.get("/api/weather/forecast")
        assert response.status_code == 200
        body = response.json()
        assert body["city"] == "Test City"
        assert body["humidity_pct"] == 55
        assert len(body["daily"]) == 7
        assert body["daily"][0]["temperature_max_f"] == 80.0
    finally:
        app.dependency_overrides.pop(get_settings, None)
        weather_api._service = None
        weather_api._service_key = None
