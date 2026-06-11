"""Tests for the design-pad (sketch) chat plumbing.

Covers the three server-side pieces:

- ``_run_search_loop`` honouring ``[SKETCH_ANALYZE]`` by re-prompting
  with the pad snapshot as an image-bearing user turn;
- ``_process_sketch_markers`` turning markers into frontend commands
  plus inline confirmations (and refusing invalid arguments);
- ``_sketch_summary`` rendering the CURRENT CONTEXT line;
- the persona advertising the sketch tool markers.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from alfred_core.api import chat as chat_module
from alfred_core.api.chat import (
    SketchLayerSignal,
    SketchSignal,
    _process_sketch_markers,
    _sketch_summary,
)
from alfred_core.config import Settings
from alfred_core.llm.base import ChatImage, ChatMessage, ChatResponse
from alfred_core.persona import ContextBundle, Mode, build_persona

SNAPSHOT = ChatImage(data="aGVsbG8=", mime_type="image/png")


class _ScriptedRouter:
    """Returns canned replies in order, capturing images per turn."""

    def __init__(self, replies: list[str]) -> None:
        self._replies = list(replies)
        self.calls: list[list[ChatMessage]] = []

    async def complete(self, msgs: list[ChatMessage]) -> ChatResponse:
        self.calls.append(
            [
                ChatMessage(
                    role=m.role, content=m.content, images=list(m.images)
                )
                for m in msgs
            ]
        )
        if not self._replies:
            raise AssertionError("router ran out of scripted replies")
        return ChatResponse(
            content=self._replies.pop(0),
            backend="local",
            model="test-model",
        )


@pytest.fixture
def patched_router(
    monkeypatch: pytest.MonkeyPatch,
) -> Callable[[list[str]], _ScriptedRouter]:
    def _install(replies: list[str]) -> _ScriptedRouter:
        scripted = _ScriptedRouter(replies)
        monkeypatch.setattr(chat_module, "_llm_router", scripted)
        return scripted

    return _install


# ─── [SKETCH_ANALYZE] loop behaviour ────────────────────────────────────


@pytest.mark.asyncio
async def test_analyze_marker_triggers_vision_turn(
    patched_router: Callable[[list[str]], _ScriptedRouter],
) -> None:
    scripted = patched_router(
        [
            "Let me have a look, sir. [SKETCH_ANALYZE]",
            "A bold start — the proportions on the left wing need work.",
        ]
    )
    msgs = [
        ChatMessage(role="system", content="persona"),
        ChatMessage(role="user", content="Alfred, analyze my sketch."),
    ]

    outcome = await chat_module._run_search_loop(
        msgs, Settings(), sketch_snapshot=SNAPSHOT
    )

    assert outcome.sketch_analyzed is True
    assert "proportions on the left wing" in outcome.visible_reply
    # Two LLM calls: initial + the snapshot-bearing follow-up.
    assert len(scripted.calls) == 2
    second_history = scripted.calls[1]
    last_user = [m for m in second_history if m.role == "user"][-1]
    assert "[DESIGN PAD SNAPSHOT]" in last_user.content
    assert last_user.images == [SNAPSHOT]
    # The intermediate assistant turn fed back must not contain the marker.
    assistant_turns = [m for m in second_history if m.role == "assistant"]
    assert all("[SKETCH_" not in m.content for m in assistant_turns)


@pytest.mark.asyncio
async def test_analyze_without_snapshot_does_not_loop(
    patched_router: Callable[[list[str]], _ScriptedRouter],
) -> None:
    scripted = patched_router(["Certainly. [SKETCH_ANALYZE]"])
    msgs = [
        ChatMessage(role="system", content="persona"),
        ChatMessage(role="user", content="analyze my sketch"),
    ]

    outcome = await chat_module._run_search_loop(
        msgs, Settings(), sketch_snapshot=None
    )

    assert outcome.sketch_analyzed is False
    assert len(scripted.calls) == 1
    # Post-processing turns the dangling marker into an apology.
    reply, commands = _process_sketch_markers(
        outcome.visible_reply, analyzed=False, carried_invocations=[]
    )
    assert "[SKETCH_ANALYZE]" not in reply
    assert "can't see the design pad" in reply
    assert commands == []


@pytest.mark.asyncio
async def test_analyze_honoured_only_once(
    patched_router: Callable[[list[str]], _ScriptedRouter],
) -> None:
    """A model that re-emits ANALYZE after seeing the snapshot stops looping."""
    scripted = patched_router(
        [
            "[SKETCH_ANALYZE]",
            "Hmm. [SKETCH_ANALYZE]",  # second request — must NOT re-loop
        ]
    )
    msgs = [
        ChatMessage(role="system", content="persona"),
        ChatMessage(role="user", content="analyze it"),
    ]

    outcome = await chat_module._run_search_loop(
        msgs, Settings(), sketch_snapshot=SNAPSHOT
    )

    assert len(scripted.calls) == 2
    assert outcome.sketch_analyzed is True
    # Stray marker in the final reply is silently removed (analysis
    # already happened).
    reply, _ = _process_sketch_markers(
        outcome.visible_reply, analyzed=True, carried_invocations=[]
    )
    assert "[SKETCH_" not in reply
    assert "can't see the design pad" not in reply


@pytest.mark.asyncio
async def test_intermediate_sketch_commands_are_carried(
    patched_router: Callable[[list[str]], _ScriptedRouter],
) -> None:
    """[SKETCH_TOOL:] emitted alongside [SKETCH_ANALYZE] must not be lost."""
    patched_router(
        [
            "[SKETCH_TOOL: pen]\n[SKETCH_ANALYZE]",
            "Final analysis, sir.",
        ]
    )
    msgs = [
        ChatMessage(role="system", content="persona"),
        ChatMessage(role="user", content="grab the pen and analyze"),
    ]

    outcome = await chat_module._run_search_loop(
        msgs, Settings(), sketch_snapshot=SNAPSHOT
    )

    assert [i.action.value for i in outcome.collected_sketch_invocations] == [
        "tool"
    ]
    _, commands = _process_sketch_markers(
        outcome.visible_reply,
        analyzed=outcome.sketch_analyzed,
        carried_invocations=outcome.collected_sketch_invocations,
    )
    assert [(c.action, c.value) for c in commands] == [("tool", "pen")]


# ─── Marker → command post-processing ───────────────────────────────────


def test_commands_extracted_with_confirmations() -> None:
    reply = (
        "Right away, sir.\n"
        "[SKETCH_OPEN]\n"
        "[SKETCH_TOOL: Pen]\n"
        "[SKETCH_COLOR: red]\n"
        "[SKETCH_LAYER_ADD: Shading]"
    )
    out, commands = _process_sketch_markers(
        reply, analyzed=False, carried_invocations=[]
    )
    assert [(c.action, c.value) for c in commands] == [
        ("open", ""),
        ("tool", "pen"),  # normalised to lowercase
        ("color", "red"),
        ("layer_add", "Shading"),
    ]
    assert "[SKETCH_" not in out
    assert "_(Design pad open.)_" in out
    assert "_(Switched to the pen.)_" in out
    assert "_(Colour set to red.)_" in out
    assert "Shading" in out


def test_invalid_tool_is_refused() -> None:
    out, commands = _process_sketch_markers(
        "[SKETCH_TOOL: crayon]", analyzed=False, carried_invocations=[]
    )
    assert commands == []
    assert "pencil, pen, marker, and eraser" in out


def test_brush_size_is_clamped_and_bad_values_refused() -> None:
    out, commands = _process_sketch_markers(
        "[SKETCH_BRUSH: 200]\n[SKETCH_BRUSH: huge]",
        analyzed=False,
        carried_invocations=[],
    )
    assert [(c.action, c.value) for c in commands] == [("brush", "64")]
    assert "couldn't make sense of brush size" in out


# ─── Context summary + persona prompt ───────────────────────────────────


def test_sketch_summary_renders_state() -> None:
    sketch = SketchSignal(
        open=True,
        tool="pencil",
        color="#ff4d4d",
        brush_size=12,
        layers=[
            SketchLayerSignal(name="Shading", visible=True, active=True),
            SketchLayerSignal(name="Base", visible=False, active=False),
        ],
    )
    summary = _sketch_summary(sketch)
    assert "Active tool: pencil" in summary
    assert "#ff4d4d" in summary
    assert "brush size 12" in summary
    assert "\u201cShading\u201d (active, visible)" in summary
    assert "\u201cBase\u201d (hidden)" in summary


def test_sketch_summary_empty_when_closed_or_absent() -> None:
    assert _sketch_summary(None) == ""
    assert _sketch_summary(SketchSignal(open=False)) == ""


def test_persona_advertises_sketch_tool_and_context_line() -> None:
    settings = Settings()
    context = ContextBundle(
        sketch_summary="Active tool: pen, colour #6cd6ff, brush size 6."
    )
    persona = build_persona(Mode.STANDARD, settings, context)
    assert "[SKETCH_OPEN]" in persona.system_prompt
    assert "[SKETCH_LAYER_ADD" in persona.system_prompt
    assert "The design pad is OPEN" in persona.system_prompt
    assert "Active tool: pen" in persona.system_prompt


def test_persona_omits_design_pad_context_when_closed() -> None:
    persona = build_persona(Mode.STANDARD, Settings(), ContextBundle())
    # Tool markers are still advertised (pad can always be opened)…
    assert "[SKETCH_OPEN]" in persona.system_prompt
    # …but no claim that it is currently open.
    assert "The design pad is OPEN" not in persona.system_prompt


def test_persona_gates_analyze_on_vision() -> None:
    with_vision = build_persona(
        Mode.STANDARD, Settings(local_model_vision="llava"), None
    )
    without_vision = build_persona(
        Mode.STANDARD,
        Settings(local_model_vision="", anthropic_api_key=""),
        None,
    )
    assert "[SKETCH_ANALYZE]" in with_vision.system_prompt
    assert "[SKETCH_ANALYZE]" not in without_vision.system_prompt
