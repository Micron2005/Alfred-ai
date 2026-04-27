"""Weather forecast endpoint for the HUD widget.

Wraps :class:`alfred_core.weather.WeatherService` so the frontend can
poll a single endpoint for the current conditions plus a 7-day strip.
The underlying service caches Open-Meteo responses for 10 minutes, so
calling this on every page render is fine.

Returns an HTTP 503 (rather than empty JSON) when Open-Meteo is
unreachable so the frontend can keep its last good render and show a
small "stale" indicator instead of suddenly having no data.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from alfred_core.config import Settings, get_settings
from alfred_core.weather import WeatherForecast, WeatherService

router = APIRouter(prefix="/api/weather", tags=["weather"])


# Module-level singleton so the cache survives across requests. Built
# lazily on first call because ``Settings`` is read via FastAPI's
# dependency-injection (which lets tests override it cleanly).
_service: WeatherService | None = None
_service_key: tuple[float, float, str] | None = None


def _get_service(settings: Settings) -> WeatherService:
    global _service, _service_key
    key = (
        settings.alfred_location_latitude,
        settings.alfred_location_longitude,
        settings.alfred_location_city,
    )
    if _service is None or _service_key != key:
        _service = WeatherService(
            latitude=settings.alfred_location_latitude,
            longitude=settings.alfred_location_longitude,
            city_label=settings.alfred_location_city,
        )
        _service_key = key
    return _service


class DailyForecastResponse(BaseModel):
    date: str
    weather_code: int
    condition: str
    temperature_min_f: float
    temperature_max_f: float


class WeatherForecastResponse(BaseModel):
    city: str
    timezone: str
    temperature_f: float
    feels_like_f: float
    humidity_pct: int
    weather_code: int
    condition: str
    wind_mph: float
    is_day: bool
    daily: list[DailyForecastResponse]


def _serialize(forecast: WeatherForecast) -> WeatherForecastResponse:
    return WeatherForecastResponse(
        city=forecast.city,
        timezone=forecast.timezone,
        temperature_f=forecast.temperature_f,
        feels_like_f=forecast.feels_like_f,
        humidity_pct=forecast.humidity_pct,
        weather_code=forecast.weather_code,
        condition=forecast.condition,
        wind_mph=forecast.wind_mph,
        is_day=forecast.is_day,
        daily=[
            DailyForecastResponse(
                date=day.date,
                weather_code=day.weather_code,
                condition=day.condition,
                temperature_min_f=day.temperature_min_f,
                temperature_max_f=day.temperature_max_f,
            )
            for day in forecast.daily
        ],
    )


@router.get("/forecast", response_model=WeatherForecastResponse)
async def forecast(
    settings: Settings = Depends(get_settings),
) -> WeatherForecastResponse:
    """Current conditions + 7-day forecast for the configured location."""
    service = _get_service(settings)
    payload = await service.get_forecast()
    if payload is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Couldn't reach the weather service. The HUD will keep "
                "showing the last good reading."
            ),
        )
    return _serialize(payload)
