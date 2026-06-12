"""Unit tests for the ``[SKETCH_…]`` marker parser."""

from __future__ import annotations

from alfred_core.tools.sketch_marker import (
    SketchAction,
    confirmation_for,
    extract_invocations,
    replace_marker,
    strip_markers,
)


def test_open_marker() -> None:
    reply = "Very good, sir. [SKETCH_OPEN]"
    invs = extract_invocations(reply)
    assert len(invs) == 1
    assert invs[0].action is SketchAction.OPEN
    assert invs[0].value == ""
    assert invs[0].raw_match == "[SKETCH_OPEN]"


def test_tool_marker_with_value() -> None:
    invs = extract_invocations("[SKETCH_TOOL: pen]")
    assert len(invs) == 1
    assert invs[0].action is SketchAction.TOOL
    assert invs[0].value == "pen"


def test_color_and_brush() -> None:
    invs = extract_invocations("[SKETCH_COLOR: #ff4d4d]\n[SKETCH_BRUSH: 12]")
    assert [i.action for i in invs] == [SketchAction.COLOR, SketchAction.BRUSH]
    assert invs[0].value == "#ff4d4d"
    assert invs[1].value == "12"


def test_layer_add_named_and_unnamed() -> None:
    invs = extract_invocations("[SKETCH_LAYER_ADD: Shading]\n[SKETCH_LAYER_ADD]")
    assert len(invs) == 2
    assert invs[0].action is SketchAction.LAYER_ADD
    assert invs[0].value == "Shading"
    assert invs[1].value == ""


def test_layer_select_not_confused_with_layer_add() -> None:
    invs = extract_invocations("[SKETCH_LAYER_SELECT: Base]")
    assert len(invs) == 1
    assert invs[0].action is SketchAction.LAYER_SELECT
    assert invs[0].value == "Base"


def test_undo_redo_clear_analyze() -> None:
    reply = "[SKETCH_UNDO][SKETCH_REDO][SKETCH_CLEAR][SKETCH_ANALYZE]"
    invs = extract_invocations(reply)
    assert [i.action for i in invs] == [
        SketchAction.UNDO,
        SketchAction.REDO,
        SketchAction.CLEAR,
        SketchAction.ANALYZE,
    ]


def test_opacity_marker() -> None:
    invs = extract_invocations("[SKETCH_OPACITY: 60]")
    assert len(invs) == 1
    assert invs[0].action is SketchAction.OPACITY
    assert invs[0].value == "60"


def test_layer_merge_lock_unlock() -> None:
    reply = (
        "[SKETCH_LAYER_MERGE]\n"
        "[SKETCH_LAYER_MERGE: Shading]\n"
        "[SKETCH_LAYER_LOCK: Base]\n"
        "[SKETCH_LAYER_UNLOCK]"
    )
    invs = extract_invocations(reply)
    assert [i.action for i in invs] == [
        SketchAction.LAYER_MERGE,
        SketchAction.LAYER_MERGE,
        SketchAction.LAYER_LOCK,
        SketchAction.LAYER_UNLOCK,
    ]
    assert invs[0].value == ""
    assert invs[1].value == "Shading"
    assert invs[2].value == "Base"
    assert confirmation_for(invs[0]) == "_(Merged the layer down.)_"
    assert "Shading" in confirmation_for(invs[1])
    assert confirmation_for(invs[2]) == "_(Layer \u201cBase\u201d locked.)_"
    assert confirmation_for(invs[3]) == "_(Layer unlocked.)_"


def test_case_insensitive() -> None:
    invs = extract_invocations("[sketch_tool: Marker]")
    assert len(invs) == 1
    assert invs[0].action is SketchAction.TOOL
    assert invs[0].value == "Marker"


def test_no_markers() -> None:
    assert extract_invocations("A fine sketch, sir.") == []


def test_multiple_markers_in_one_reply() -> None:
    reply = (
        "Right away, sir.\n"
        "[SKETCH_LAYER_ADD: Outline]\n"
        "[SKETCH_TOOL: pen]\n"
        "[SKETCH_COLOR: red]"
    )
    invs = extract_invocations(reply)
    assert [i.action for i in invs] == [
        SketchAction.LAYER_ADD,
        SketchAction.TOOL,
        SketchAction.COLOR,
    ]


def test_replace_marker_swaps_exactly_one() -> None:
    reply = "Done. [SKETCH_UNDO] [SKETCH_UNDO]"
    invs = extract_invocations(reply)
    out = replace_marker(reply, invs[0], "_(Undone.)_")
    assert out == "Done. _(Undone.)_ [SKETCH_UNDO]"


def test_strip_markers_removes_all() -> None:
    reply = "Opening it now. [SKETCH_OPEN]\n[SKETCH_TOOL: pencil]"
    assert strip_markers(reply) == "Opening it now."


def test_confirmations() -> None:
    invs = extract_invocations(
        "[SKETCH_OPEN][SKETCH_TOOL: pen][SKETCH_LAYER_ADD: Shading]"
        "[SKETCH_LAYER_ADD][SKETCH_CLEAR]"
    )
    assert confirmation_for(invs[0]) == "_(Design pad open.)_"
    assert confirmation_for(invs[1]) == "_(Switched to the pen.)_"
    assert "Shading" in confirmation_for(invs[2])
    assert confirmation_for(invs[3]) == "_(Added a new layer.)_"
    assert confirmation_for(invs[4]) == "_(Active layer cleared.)_"
