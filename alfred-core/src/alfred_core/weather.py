"""Current-weather lookup via Open-Meteo.

Open-Meteo is free, keyless, and has a generous fair-use policy. We cache
the last fetch in-process for a short window so chatter doesn't hammer the
API.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import httpx

_CACHE_TTL_SECONDS = 600  # 10 minutes
_REQUEST_TIMEOUT = httpx.Timeout(5.0)

# WMO weather code → human description (subset of the official table).
_WMO_CODES: dict[int, str] = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "rime fog",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    77: "snow grains",
    80: "light rain showers",
    81: "rain showers",
    82: "violent rain showers",
    85: "light snow showers",
    86: "heavy snow showers",
    95: "thunderstorm",
    96: "thunderstorm with hail",
    99: "severe thunderstorm with hail",
}


@dataclass(frozen=True)
class WeatherSnapshot:
    temperature_f: float
    condition: str
    wind_mph: float
    city: str

    def summary(self) -> str:
        return (
            f"{self.temperature_f:.0f}°F, {self.condition}, "
            f"wind {self.wind_mph:.0f} mph (in {self.city})"
        )


@dataclass(frozen=True)
class DailyForecast:
    """One day in the 7-day forecast strip."""

    # ISO date for this day (YYYY-MM-DD).
    date: str
    temperature_min_f: float
    temperature_max_f: float
    weather_code: int
    condition: str


@dataclass(frozen=True)
class WeatherForecast:
    """Full payload for the HUD widget — current snapshot + daily strip."""

    city: str
    timezone: str
    # Current conditions (extends ``WeatherSnapshot`` with feels-like
    # and humidity, which the HUD widget shows but the persona doesn't
    # need).
    temperature_f: float
    feels_like_f: float
    humidity_pct: int
    weather_code: int
    condition: str
    wind_mph: float
    is_day: bool
    daily: tuple[DailyForecast, ...]


class WeatherService:
    """Tiny async weather lookup with an in-memory cache."""

    def __init__(self, latitude: float, longitude: float, city_label: str) -> None:
        self._lat = latitude
        self._lon = longitude
        self._city = city_label
        self._cached: WeatherSnapshot | None = None
        self._fetched_at: float = 0.0
        self._cached_forecast: WeatherForecast | None = None
        self._forecast_fetched_at: float = 0.0
        self._lock = asyncio.Lock()
        self._forecast_lock = asyncio.Lock()

    async def get(self) -> WeatherSnapshot | None:
        async with self._lock:
            now = time.monotonic()
            if self._cached is not None and (now - self._fetched_at) < _CACHE_TTL_SECONDS:
                return self._cached
            snapshot = await self._fetch()
            if snapshot is not None:
                self._cached = snapshot
                self._fetched_at = now
            return snapshot

    async def get_forecast(self) -> WeatherForecast | None:
        """Return current + 7-day forecast for the HUD widget.

        Cached separately from :py:meth:`get` because the API request is
        slightly heavier (current+daily vs current-only) and the widget
        polls more aggressively than the persona-context refresh.
        """
        async with self._forecast_lock:
            now = time.monotonic()
            if (
                self._cached_forecast is not None
                and (now - self._forecast_fetched_at) < _CACHE_TTL_SECONDS
            ):
                return self._cached_forecast
            forecast = await self._fetch_forecast()
            if forecast is not None:
                self._cached_forecast = forecast
                self._forecast_fetched_at = now
            return forecast

    async def _fetch(self) -> WeatherSnapshot | None:
        params: dict[str, str | float] = {
            "latitude": self._lat,
            "longitude": self._lon,
            "current": "temperature_2m,weather_code,wind_speed_10m",
            "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph",
            "timezone": "auto",
        }
        try:
            async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as client:
                resp = await client.get("https://api.open-meteo.com/v1/forecast", params=params)
                resp.raise_for_status()
                data = resp.json()
        except (httpx.HTTPError, ValueError):
            # Weather is a nice-to-have; never break chat if the API blips.
            return None

        current = data.get("current") or {}
        code = int(current.get("weather_code", 0))
        return WeatherSnapshot(
            temperature_f=float(current.get("temperature_2m", 0.0)),
            condition=_WMO_CODES.get(code, "unknown conditions"),
            wind_mph=float(current.get("wind_speed_10m", 0.0)),
            city=self._city,
        )

    async def _fetch_forecast(self) -> WeatherForecast | None:
        # We ask for ``current`` + ``daily`` in one shot — Open-Meteo
        # bundles them in a single response, so this is one HTTP round
        # trip rather than two.
        params: dict[str, str | float] = {
            "latitude": self._lat,
            "longitude": self._lon,
            "current": (
                "temperature_2m,apparent_temperature,relative_humidity_2m,"
                "weather_code,wind_speed_10m,is_day"
            ),
            "daily": (
                "weather_code,temperature_2m_max,temperature_2m_min"
            ),
            "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph",
            "timezone": "auto",
            "forecast_days": 7,
        }
        try:
            async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as client:
                resp = await client.get(
                    "https://api.open-meteo.com/v1/forecast", params=params
                )
                resp.raise_for_status()
                data = resp.json()
        except (httpx.HTTPError, ValueError):
            # As with ``_fetch``: weather is a nice-to-have, never crash
            # the widget if Open-Meteo hiccups. The frontend keeps the
            # last good payload visible.
            return None

        current = data.get("current") or {}
        current_code = int(current.get("weather_code", 0))
        daily = data.get("daily") or {}
        dates: list[str] = list(daily.get("time") or [])
        codes: list[int] = list(daily.get("weather_code") or [])
        highs: list[float] = list(daily.get("temperature_2m_max") or [])
        lows: list[float] = list(daily.get("temperature_2m_min") or [])
        forecast_days: list[DailyForecast] = []
        # Zip across all four parallel arrays. Open-Meteo guarantees
        # they're aligned; if any are short we bail at the shortest.
        for date, code, high, low in zip(dates, codes, highs, lows, strict=False):
            forecast_days.append(
                DailyForecast(
                    date=str(date),
                    weather_code=int(code),
                    temperature_max_f=float(high),
                    temperature_min_f=float(low),
                    condition=_WMO_CODES.get(int(code), "unknown conditions"),
                )
            )

        return WeatherForecast(
            city=self._city,
            timezone=str(data.get("timezone") or "UTC"),
            temperature_f=float(current.get("temperature_2m", 0.0)),
            feels_like_f=float(current.get("apparent_temperature", 0.0)),
            humidity_pct=int(current.get("relative_humidity_2m", 0)),
            weather_code=current_code,
            condition=_WMO_CODES.get(current_code, "unknown conditions"),
            wind_mph=float(current.get("wind_speed_10m", 0.0)),
            is_day=bool(current.get("is_day", 1)),
            daily=tuple(forecast_days),
        )
