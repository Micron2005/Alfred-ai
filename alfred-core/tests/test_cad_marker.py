"""Unit tests for the ``[CAD]`` marker parser."""

from __future__ import annotations

from alfred_core.tools.cad_marker import (
    extract_requests,
    replace_marker,
    strip_markers,
)


def test_full_marker_with_name_notes_and_script() -> None:
    reply = (
        "On it, sir.\n"
        "[CAD]\n"
        "name: bracket\n"
        "notes: 30mm L-bracket with two 5mm holes\n"
        "script:\n"
        "difference() {\n"
        "    cube([30, 20, 4]);\n"
        "    translate([7, 10, -1]) cylinder(d=5, h=6, $fn=40);\n"
        "    translate([23, 10, -1]) cylinder(d=5, h=6, $fn=40);\n"
        "}\n"
        "[/CAD]"
    )
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    req = reqs[0]
    assert req.name == "bracket"
    assert req.notes == "30mm L-bracket with two 5mm holes"
    assert req.script.startswith("difference()")
    assert req.script.rstrip().endswith("}")
    assert req.raw_match.startswith("[CAD]")
    assert req.raw_match.endswith("[/CAD]")


def test_marker_without_header_treats_block_as_script() -> None:
    """Headerless form is accepted — body is the script."""
    reply = "[CAD]\ncube([10, 10, 10]);\n[/CAD]"
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    assert reqs[0].script == "cube([10, 10, 10]);"
    assert reqs[0].name is None
    assert reqs[0].notes is None


def test_dollar_special_var_in_script_not_treated_as_header() -> None:
    """The ``script:`` delimiter protects ``$fn = 40;`` lines.

    Without the delimiter, a naive header parser could see the ``$fn``
    line and decide it was a malformed name field — or worse, strip
    it. The ``script:`` marker is the explicit boundary between
    header and body.
    """
    reply = (
        "[CAD]\n"
        "name: gear\n"
        "script:\n"
        "$fn = 40;\n"
        "cylinder(d=20, h=5);\n"
        "[/CAD]"
    )
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    assert reqs[0].name == "gear"
    assert "$fn = 40;" in reqs[0].script
    assert "cylinder" in reqs[0].script


def test_empty_script_skipped() -> None:
    reply = "[CAD]\nname: foo\nscript:\n\n[/CAD]"
    assert extract_requests(reply) == []


def test_two_markers_in_one_reply() -> None:
    reply = (
        "[CAD]\nname: a\nscript:\ncube([5, 5, 5]);\n[/CAD]\n"
        "and a sphere:\n"
        "[CAD]\nname: b\nscript:\nsphere(r=3);\n[/CAD]"
    )
    reqs = extract_requests(reply)
    assert len(reqs) == 2
    assert reqs[0].name == "a"
    assert reqs[1].name == "b"


def test_replace_marker_substitutes_only_the_match() -> None:
    reply = (
        "Top text. "
        "[CAD]\nscript:\ncube([1, 1, 1]);\n[/CAD]"
        " Bottom text."
    )
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    out = replace_marker(reply, reqs[0], "_(Rendered.)_")
    assert "_(Rendered.)_" in out
    assert "[CAD]" not in out
    assert "Top text." in out
    assert "Bottom text." in out


def test_strip_markers_removes_all() -> None:
    reply = (
        "Sure.\n"
        "[CAD]\nname: foo\nscript:\ncube([1, 1, 1]);\n[/CAD]\n"
        "Done."
    )
    out = strip_markers(reply)
    assert "[CAD]" not in out
    assert "Sure." in out
    assert "Done." in out


def test_case_insensitive_tags() -> None:
    """Tags are matched case-insensitively to be tolerant of LLM drift."""
    reply = "[cad]\nscript:\ncube([1, 1, 1]);\n[/CAD]"
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    assert "cube" in reqs[0].script
