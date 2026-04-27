"use client";

import { useEffect, useRef, useState } from "react";
import { useForecast } from "@/lib/useForecast";
import {
  formatForecastDay,
  localIsoDate,
  weatherIcon,
} from "@/lib/weather";

/** Minimum pixel width for one forecast day card to stay legible. If
 *  the strip is narrower than this, we simply render fewer days
 *  (rightmost days drop first) instead of crushing each cell. */
const FORECAST_DAY_MIN_WIDTH = 72;

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

  return <ForecastStrip forecast={forecast} />;
}

/**
 * Forecast strip with responsive day count: when the user resizes
 * the widget narrower (in customize mode), we drop days from the
 * right rather than letting the cells get crushed. The widget shows
 * exactly as many days as fit at ``FORECAST_DAY_MIN_WIDTH`` per
 * cell. A trailing "+N" pill indicates how many more days exist if
 * the strip can't show them all.
 */
function ForecastStrip({
  forecast,
}: {
  forecast: NonNullable<ReturnType<typeof useForecast>["data"]>;
}) {
  const todayIso = localIsoDate();
  const containerRef = useRef<HTMLDivElement>(null);
  const totalDays = forecast.daily.length;
  const [visibleDays, setVisibleDays] = useState(totalDays);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      // Floor at 1 so we always show at least today.
      const fits = Math.max(
        1,
        Math.min(totalDays, Math.floor(w / FORECAST_DAY_MIN_WIDTH)),
      );
      setVisibleDays(fits);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [totalDays]);

  const shown = forecast.daily.slice(0, visibleDays);
  const overflow = totalDays - visibleDays;

  return (
    <div
      ref={containerRef}
      className="hud-forecast"
      aria-label={`${visibleDays}-day forecast`}
      // Override the default ``grid-template-columns: repeat(7,
      // 1fr)`` so the strip lays out exactly the days it's showing.
      // CSS variable wins over the .hud-forecast rule because it's
      // applied as inline style.
      style={{
        gridTemplateColumns: `repeat(${visibleDays}, minmax(${FORECAST_DAY_MIN_WIDTH}px, 1fr))`,
      }}
    >
      {shown.map((day) => (
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
      {overflow > 0 ? (
        <div
          className="hud-forecast__overflow"
          title={`${overflow} more day${overflow === 1 ? "" : "s"} hidden — drag the corner wider to show more`}
          aria-label={`${overflow} more days hidden`}
        >
          +{overflow}
        </div>
      ) : null}
    </div>
  );
}
