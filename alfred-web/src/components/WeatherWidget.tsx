"use client";

import { useForecast } from "@/lib/useForecast";
import {
  formatForecastDay,
  localIsoDate,
  weatherIcon,
} from "@/lib/weather";

// HUD-side weather widget. Two parts:
//
//   - The "current" pane (city, temperature, condition, feels-like
//     and humidity) which sits in the top-right corner of the full
//     HUD layout.
//   - The 7-day forecast strip rendered below the orb.
//
// Both variants subscribe to the shared ``useForecast`` hook, which
// keeps a single module-level cache + polling interval no matter how
// many <WeatherWidget> instances are mounted. So mounting both panes
// at once is exactly one HTTP request per refresh, and the two halves
// can never display inconsistent data.
export function WeatherWidget({ variant }: { variant: "current" | "strip" }) {
  const { data: forecast, error } = useForecast();

  if (error && !forecast) {
    return variant === "current" ? (
      <div className="hud-weather hud-weather--error">
        <div className="hud-weather__city">WEATHER · OFFLINE</div>
      </div>
    ) : null;
  }

  if (!forecast) {
    return variant === "current" ? (
      <div className="hud-weather hud-weather--loading">
        <div className="hud-weather__city">·</div>
      </div>
    ) : null;
  }

  if (variant === "current") {
    return (
      <div className="hud-weather">
        <div className="hud-weather__city">{forecast.city}</div>
        <div className="hud-weather__row">
          <div
            className="hud-weather__icon"
            aria-hidden="true"
            role="presentation"
          >
            {weatherIcon(forecast.weather_code, forecast.is_day)}
          </div>
          <div className="hud-weather__temp">
            {Math.round(forecast.temperature_f)}°
          </div>
        </div>
        <div className="hud-weather__condition">{forecast.condition}</div>
        <div className="hud-weather__detail">
          FEELS {Math.round(forecast.feels_like_f)}° ·{" "}
          {forecast.humidity_pct}% RH
        </div>
      </div>
    );
  }

  const todayIso = localIsoDate();
  return (
    <div className="hud-forecast" aria-label="Seven-day forecast">
      {forecast.daily.map((day) => (
        <div key={day.date} className="hud-forecast__day">
          <div className="hud-forecast__label">
            {formatForecastDay(day.date, todayIso)}
          </div>
          <div
            className="hud-forecast__icon"
            aria-hidden="true"
            role="presentation"
            title={day.condition}
          >
            {weatherIcon(day.weather_code, true)}
          </div>
          <div className="hud-forecast__high">
            {Math.round(day.temperature_max_f)}°
          </div>
          <div className="hud-forecast__low">
            {Math.round(day.temperature_min_f)}°
          </div>
        </div>
      ))}
    </div>
  );
}
