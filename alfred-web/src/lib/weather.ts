// Typed client for the backend's weather forecast endpoint plus a
// small WMO-code → emoji icon table used by the HUD widget.
//
// The backend caches Open-Meteo for 10 minutes, so the widget can
// poll once per minute or so without worry.

import { API_BASE } from "@/lib/api";

export interface DailyForecast {
  date: string;
  weather_code: number;
  condition: string;
  temperature_min_f: number;
  temperature_max_f: number;
}

export interface WeatherForecast {
  city: string;
  timezone: string;
  temperature_f: number;
  feels_like_f: number;
  humidity_pct: number;
  weather_code: number;
  condition: string;
  wind_mph: number;
  is_day: boolean;
  daily: DailyForecast[];
}

export async function fetchForecast(): Promise<WeatherForecast> {
  const res = await fetch(`${API_BASE}/api/weather/forecast`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Weather request failed: ${res.status}`);
  }
  return (await res.json()) as WeatherForecast;
}

// WMO weather-code → emoji icon. We pick a small icon vocabulary
// (rather than a full SVG sprite sheet) so the widget stays self-
// contained and matches the rest of the HUD's "lo-fi telemetry" feel.
// ``isDay`` swaps the few icons that have a sensible night variant
// (clear sky → moon, etc).
export function weatherIcon(code: number, isDay = true): string {
  switch (code) {
    case 0:
      return isDay ? "☀️" : "🌙";
    case 1:
    case 2:
      return isDay ? "🌤️" : "☁️";
    case 3:
      return "☁️";
    case 45:
    case 48:
      return "🌫️";
    case 51:
    case 53:
    case 55:
      return "🌦️";
    case 61:
    case 63:
    case 65:
    case 80:
    case 81:
    case 82:
      return "🌧️";
    case 71:
    case 73:
    case 75:
    case 77:
    case 85:
    case 86:
      return "❄️";
    case 95:
    case 96:
    case 99:
      return "⛈️";
    default:
      return "·";
  }
}

// Format an ISO date (YYYY-MM-DD) into a 3-letter weekday label
// (``Mon``, ``Tue``, …) using the user's locale. Returns ``Today``
// for the first match against the local day.
export function formatForecastDay(iso: string, todayIso: string): string {
  if (iso === todayIso) return "TODAY";
  // Append T00:00:00 so the date is treated as local rather than UTC,
  // which would shift one day back for users west of GMT.
  const date = new Date(`${iso}T00:00:00`);
  return date
    .toLocaleDateString(undefined, { weekday: "short" })
    .toUpperCase();
}

// Format a date in the user's locale as YYYY-MM-DD without timezone
// shifting. Used by ``formatForecastDay`` to identify "today".
export function localIsoDate(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
