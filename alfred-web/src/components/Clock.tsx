"use client";

import { useEffect, useState } from "react";

// Monospace HUD clock — displays HH:MM:SS plus the day-of-week and
// date. Pinned to the top-left of the full-HUD layout. Updates every
// second; the effect's interval is cleared on unmount so it doesn't
// leak when the user toggles full HUD off.
export function Clock() {
  const [now, setNow] = useState<Date | null>(null);

  // We initialize ``now`` lazily inside an effect rather than at
  // module load so the SSR pass and the first client render produce
  // the same markup (avoiding a hydration mismatch). The clock just
  // shows blank dashes for one frame, which is imperceptible.
  useEffect(() => {
    setNow(new Date());
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!now) {
    return (
      <div className="hud-clock" aria-label="Current time">
        <div className="hud-clock-time">--:--:--</div>
        <div className="hud-clock-date">·</div>
      </div>
    );
  }

  const time = now.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const weekday = now
    .toLocaleDateString(undefined, { weekday: "long" })
    .toUpperCase();
  const date = now.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div className="hud-clock" aria-label="Current time">
      <div className="hud-clock-time">{time}</div>
      <div className="hud-clock-date">
        {weekday} · {date}
      </div>
    </div>
  );
}
