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


class WeatherService:
    """Tiny async weather lookup with an in-memory cache."""

    def __init__(self, latitude: float, longitude: float, city_label: str) -> None:
        self._lat = latitude
        self._lon = longitude
        self._city = city_label
        self._cached: WeatherSnapshot | None = None
        self._fetched_at: float = 0.0
        self._lock = asyncio.Lock()

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
