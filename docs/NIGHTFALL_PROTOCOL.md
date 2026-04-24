# Nightfall Protocol

> *"The night is darkest just before the dawn — and I promise you, the dawn is coming."*

Nightfall Protocol is Alfred's alternate persona. When active, he becomes terser, graver, and more mission-focused. He continues to address you as **"sir"** but will also call you **"Batman"** when the moment warrants it.

## Activating

Any of these phrases will flip Alfred into Nightfall Protocol:

- "Alfred, activate Nightfall Protocol"
- "Activate Nightfall Protocol"
- "Alfred, engage Nightfall Protocol"
- "Alfred, initiate Nightfall Protocol"
- "Begin Nightfall Protocol"

The matching rule lives in [`alfred-core/src/alfred_core/wake.py`](../alfred-core/src/alfred_core/wake.py). It's a regex that accepts "activate / engage / enable / initiate / begin" followed (within a short window) by "Nightfall Protocol".

## Deactivating

Any of these phrases will return Alfred to Standard Mode:

- "Alfred, deactivate Nightfall Protocol"
- "Alfred, stand down"
- "Stand down"
- "End Nightfall Protocol"

## What changes

| | Standard Mode | Nightfall Protocol |
|---|---|---|
| **Address** | "sir" | "sir" + occasionally "Batman" |
| **Tone** | Dry, witty, warm | Clipped, grave, still dry |
| **Verbosity** | Moderate — a good butler doesn't ramble | Tighter — mission-style briefings |
| **UI theme** | Warm parchment (`--bg: #f6f4ef`) | Cave (`--bg: #0a0a0c`, gold accents) |
| **Humour** | Present and frequent | Present but rarer and darker |

## How it works under the hood

1. Your message hits `POST /chat`.
2. `wake.analyze()` inspects it for mode-change phrases.
3. If a change is detected, `mode_state` (a single-process in-memory flag) flips.
4. The persona module rebuilds the system prompt using the new mode's template.
5. The `/chat` response includes the new `mode`.
6. The frontend listens to that field and toggles the `nightfall` CSS class on `<body>`, which swaps the entire theme via CSS custom properties.

## Extending it

You can add more modes (e.g. a "focus" mode that makes Alfred extra terse, a "host" mode for when you have guests) by:

1. Adding a new value to `Mode` in `alfred_core/persona.py`.
2. Writing a new system-prompt template in the same file.
3. Handling it in `build_persona`.
4. Adding wake-phrase patterns in `alfred_core/wake.py`.
5. Optionally adding a theme class in `alfred-web/src/app/globals.css` and toggling it in `ChatWindow.tsx`.

## Design notes

The single global mode is deliberately simple for Phase 1. In later phases we'll move mode to be **per-conversation** so you can have one chat running in Nightfall Protocol while another stays in Standard Mode. The schema is already prepared: `Conversation.mode` is a string column waiting to be used.
