# The Design Pad

A built-in sketch pad that **is the DESIGN tab** in the Alfred web UI
(it replaced the old CAD placeholder view), made for a touchscreen
monitor but fully usable with a mouse. Open it by:

- clicking the **DESIGN** tab (next to HUD / CHAT / WORKOUT),
- picking the **DESIGN — Sketch Pad** module in the radial menu
  (click the orb, or say "open the menu"),
- the **✏ DESIGN** button in the chat header,
- or just asking: *"Alfred, pull up the design tab."*

Switching tabs never loses your drawing — the layer bitmaps live
outside the tab and are re-attached when you come back.

## Drawing

- **Tools**: pencil (translucent, strongly pressure-driven), pen
  (opaque ink), marker (wide, builds up with overlapping strokes),
  eraser. Pressure comes from the Pointer Events API — a stylus or
  pressure-capable touchscreen modulates stroke width; mouse and
  finger fall back to a constant mid pressure.
- **Colours**: ten HUD-themed swatches plus a free colour picker.
- **Brush size**: 1–64 px slider with a live preview dot.
- **Layers**: add, delete, rename (double-click the name), reorder
  (▲/▼), show/hide (👁), per-layer opacity. New layers go on top and
  become active. Strokes land on the active layer only.
- **Undo / redo**: per-stroke, up to 30 steps. Clearing a layer is
  undoable too.
- **Export**: ⤓ EXPORT downloads the flattened sketch as a PNG.
- The canvas is a fixed 1600×1000 logical space scaled to your
  window, so resizing the browser never distorts or clears artwork.
  Closing the pad keeps the sketch; it's still there when you reopen.

## Alfred drives it

The LLM gets a set of `[SKETCH_…]` markers (same pattern as Spotify
and email). Say any of these out loud (or type them):

| You say | Alfred emits | Effect |
| --- | --- | --- |
| "pull up the design tab" | `[SKETCH_OPEN]` | opens the pad |
| "close the pad" | `[SKETCH_CLOSE]` | closes it (sketch kept) |
| "switch to the pencil" | `[SKETCH_TOOL: pencil]` | changes tool |
| "give me a red pen" | `[SKETCH_TOOL: pen]` + `[SKETCH_COLOR: red]` | both at once |
| "bigger brush" | `[SKETCH_BRUSH: 24]` | sets brush size |
| "new layer called shading" | `[SKETCH_LAYER_ADD: Shading]` | adds + activates a layer |
| "go back to the base layer" | `[SKETCH_LAYER_SELECT: Base]` | switches active layer |
| "undo that" | `[SKETCH_UNDO]` | undoes the last stroke |
| "clear this layer" | `[SKETCH_CLEAR]` | clears the active layer |
| "analyze my sketch" | `[SKETCH_ANALYZE]` | see below |

Markers are executed client-side: the chat reply carries a
`sketch_commands` list that the React app applies to the canvas. Any
command (other than CLOSE) auto-opens the pad if it was closed.

While the pad is open, every chat turn includes its live state
(active tool, colour, brush size, layer list) in Alfred's CURRENT
CONTEXT block — so *"what tool am I using?"* gets a real answer.

## Sketch analysis

When the pad is open, each message you send also carries a flattened
PNG snapshot of the visible layers. If Alfred emits
`[SKETCH_ANALYZE]`, the backend re-prompts the model with that
snapshot as an image turn — routed to your vision model
(`LOCAL_MODEL_VISION`, e.g. llama3.2-vision, or Anthropic as
fallback) — and Alfred replies with a critique of what is actually
drawn. No vision backend configured → the capability isn't offered.

## Implementation map

- `alfred-core/src/alfred_core/tools/sketch_marker.py` — marker parser.
- `alfred-core/src/alfred_core/api/chat.py` — `SketchSignal` request
  field, `sketch_commands` reply field, `[SKETCH_ANALYZE]` handling in
  the tool loop, marker → command post-processing.
- `alfred-core/src/alfred_core/persona.py` — `SKETCH_TOOL_PROMPT`,
  `SKETCH_ANALYZE_PROMPT`, design-pad context line.
- `alfred-web/src/lib/sketchStore.ts` — shared pad state + command
  application (external store, same pattern as `orbState`).
- `alfred-web/src/components/SketchPad.tsx` — the overlay: layered
  canvases, pressure strokes, layers panel, undo history, export.
- Tests: `alfred-core/tests/test_sketch_marker.py`,
  `alfred-core/tests/test_sketch_chat.py`.
