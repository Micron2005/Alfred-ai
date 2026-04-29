# HUD Style Polish — Final Pass (queued)

User-provided JARVIS reference screenshot for stylistic inspiration.
**Will be applied as the LAST thing we do**, after all functional work.

## Inspiration to take (tastefully, no direct copying)

- **Title block**: Outlined rectangular frame around "ALFRED" wordmark
  at the top, with thin corner notches — replaces the current flat
  floating header. Different typography from JARVIS (sticking with
  Alfred's existing font choice).

- **Activity Monitor panel** (bottom-left): timestamped event log
  showing what Alfred is currently doing:
  ```
  16:14:52  RESPONDING
  16:14:51  LISTENING
  16:14:40  COMMAND RECEIVED
  16:14:43  PROCESSING
  16:14:34  STANDBY
  ```
  Genuinely useful — surfaces the wake-word + voice loop state.
  Alfred-flavoured: maybe rename to "OPERATIONS LOG" so it doesn't
  feel JARVIS-y.

- **System Status pill** (top-right): vertical list of named indicators
  with green/amber dots (System Online, Microphone, Wake Detected,
  API Connection, Memory Sync, etc.). Replaces / consolidates several
  scattered status indicators currently in the toolbar.

- **System Info panel** (right side): large monospace clock + weather
  + uptime + commands-this-session counters. Alfred already has
  most of these as separate widgets — consolidate into a single
  styled card.

- **Greeting card** (bottom-center): framed "Good evening, sir." card
  near the orb. Currently just a "STANDING BY" line — upgrade to a
  proper bordered card with the persona attribution.

- **Page corner brackets** (4 corners of viewport): Alfred has some
  bracket cues already; tighten + use the same stroke weight as
  the new title block frame.

## What to deliberately NOT copy

- **Color**: keep Alfred's blue-cyan palette (`#6cd6ff`). Reference is
  green-teal — would feel like a clone.
- **Plasma orb**: keep the see-through glass + ring orb (the user
  explicitly chose this). Reference's nebula-plasma orb is different
  visual language.
- **JARVIS** branding obviously.
- **Heavy panel borders**: Alfred's current 1px hairline aesthetic is
  cleaner. Don't go to the 2px+ glow-stack the reference uses.

## When to do this

LAST — after all functional work is done (tabs, swipe, OnShape,
K1 Max, voice change). User explicitly said "doesn't matter when
it gets done".
