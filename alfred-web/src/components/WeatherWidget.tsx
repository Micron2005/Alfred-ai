"use client";

import { useEffect, useRef, useState } from "react";
import {
  type WeatherForecast,
  fetchForecast,
  formatForecastDay,
  localIsoDate,
  weatherIcon,
} from "@/lib/weather";

const REFRESH_MS = 60_000;

// HUD-side weather widget. Two parts:
//
//   - The "current" pane (city, temperature, condition, feels-like
//     and humidity) which sits in the top-right corner of the full
//     HUD layout.
//   - The 7-day forecast strip rendered below the orb.
//
// Both share the same fetched payload — splitting the JSX rather than
// the data lets us position the two halves independently in the HUD
// grid without coupling them or making two HTTP requests.
export function WeatherWidget({ variant }: { variant: "current" | "strip" }) {
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cache the last successful payload across refreshes so a transient
  // Open-Meteo blip doesn't blank the widget. The error is only
  // surfaced if we have NO data at all.
  const lastGoodRef = useRef<WeatherForecast | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await fetchForecast();
        if (cancelled) return;
        lastGoodRef.current = data;
        setForecast(data);
        setError(null);
      } catch (exc) {
        if (cancelled) return;
        // Keep the last-good payload visible so the HUD doesn't blank
        // out on a transient hiccup. Only show the inline error when
        // we've never had data to display.
        if (!lastGoodRef.current) {
          const message = exc instanceof Error ? exc.message : String(exc);
          setError(message);
        }
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

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
