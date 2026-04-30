"""Unit tests for the CAD-rendering module.

We don't shell out to a real OpenSCAD here — the integration test
(verifying actual STL bytes come back) belongs in a Docker-based
end-to-end harness with the OpenSCAD binary present. These tests
cover the surface around the subprocess: error mapping, script-size
guard, missing-binary handling.
"""

from __future__ import annotations

import pytest

from alfred_core.tools import cad as cad_module
from alfred_core.tools.cad import CadError, render_openscad


@pytest.mark.asyncio
async def test_missing_binary_raises_cad_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Calling ``render_openscad`` with no OpenSCAD installed should
    raise ``CadError`` with a clear message — *not* propagate a
    ``FileNotFoundError`` from ``asyncio.create_subprocess_exec``.

    The chat handler relies on this contract to fold the failure
    into a polite apology rather than 500ing the whole turn.
    """

    monkeypatch.setattr(cad_module, "_find_openscad", lambda: None)
    with pytest.raises(CadError) as excinfo:
        await render_openscad("cube([1, 1, 1]);")
    assert "OpenSCAD" in str(excinfo.value)


@pytest.mark.asyncio
async def test_oversize_script_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 100 KB script blows past the 64 KB cap and must be refused
    *before* any subprocess is spawned. We assert the binary lookup
    is not even called — the size check has to short-circuit so a
    runaway prompt loop can't cost us a process spawn per attempt.
    """

    called = {"n": 0}

    def _spy() -> str | None:
        called["n"] += 1
        return "/usr/bin/openscad"

    monkeypatch.setattr(cad_module, "_find_openscad", _spy)
    huge = "// pad\n" * 20_000  # ~140 KB
    with pytest.raises(CadError) as excinfo:
        await render_openscad(huge)
    assert "too large" in str(excinfo.value).lower()
    assert called["n"] == 0


def test_has_openscad_returns_bool() -> None:
    """``has_openscad`` is gated on by the persona builder; it must
    always return a real bool, never ``None`` or the resolved path
    (those would still be truthy but break ``settings.has_cad``'s
    type contract)."""

    assert isinstance(cad_module.has_openscad(), bool)
