"""3D CAD generation via OpenSCAD (Phase 18a).

Alfred can author small parametric models — brackets, jigs, mounts,
parts — by emitting an OpenSCAD script in a chat marker. The chat
handler picks the marker up, hands the script to this module, and we
shell out to the local ``openscad`` binary to produce:

1. A binary STL — the actual mesh, ready for slicing/printing.
2. A PNG preview — front-three-quarter render at modest resolution,
   inlined into the chat bubble so the user can eyeball the result
   without opening a viewer.

Why OpenSCAD? It's free, scriptable, runs headlessly, has no
network dependency, and the language is compact enough that an LLM
can fluently produce it. We keep this module narrow on purpose: it
runs scripts, it does not validate them. Trust boundary: only the
LLM (which never sees user-provided files) writes scripts; we still
sandbox via a temp directory + a hard timeout so a runaway
``intersection``/``minkowski`` can't stall the request indefinitely.

Onshape (cloud, collaborative) is a planned sibling backend — see
``ONSHAPE_*`` env keys in ``config.py``. For now the cloud path
errors with a "not configured" message rather than going through
half-implemented; the local path is the supported v1.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Where we look for the ``openscad`` binary. Order matters: we prefer
# whatever's on PATH (so users can override via a custom image), then
# fall back to the standard install locations on Linux/macOS/Windows.
_OPENSCAD_CANDIDATES: tuple[str, ...] = (
    "openscad",
    "openscad-nogui",
    "/usr/bin/openscad",
    "/usr/bin/openscad-nogui",
    "/usr/local/bin/openscad",
    "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD",
    r"C:\Program Files\OpenSCAD\openscad.exe",
)

# Cap on script execution. CSG ops in OpenSCAD can hit pathological
# cases on bad input (especially ``minkowski`` with high-poly shapes);
# 60 s is enough for any sensibly-parametric part and short enough
# that a chat turn never feels hung from the user's side.
_TIMEOUT_S = 60.0

# Preview render resolution. Big enough to read clearly in the chat
# bubble (which already maxes out at 480 px wide), small enough that
# the base64 payload doesn't bloat conversation history.
_PREVIEW_SIZE = (640, 480)

# Hard limit on the OpenSCAD script size we'll accept. The LLM has
# no business shipping anything bigger than this — the marker is
# meant for parametric scripts, not pre-baked geometry. Cap protects
# us from a runaway prompt loop that pasted the same script ten
# times into one marker.
_MAX_SCRIPT_BYTES = 64 * 1024


@dataclass(frozen=True)
class CadResult:
    """One rendered model — both the STL bytes and a PNG preview.

    ``stl_data`` is the raw binary STL (suitable for slicer / printer).
    ``preview_data`` is a PNG render, suitable for inlining into the
    chat as an image attachment. Both are stored as bytes so the
    chat handler can base64-encode them for ``metadata_json``.

    ``document_url`` is populated when the part was also published to
    an Onshape document (Phase 18b, ``backend: onshape``). The frontend
    renders a "View in Onshape" link when this is set.
    """

    script: str
    stl_data: bytes
    preview_data: bytes
    name: str
    document_url: str | None = None


class CadError(RuntimeError):
    """OpenSCAD failed to render the supplied script.

    Always carries a single-line, human-readable message — Alfred
    folds it directly into the visible reply so the user gets a
    sensible apology rather than a stack trace.
    """


def _find_openscad() -> str | None:
    """Locate the ``openscad`` binary, or return ``None`` if absent."""
    for cand in _OPENSCAD_CANDIDATES:
        # ``shutil.which`` only resolves bare names against PATH; the
        # absolute paths we have to test with ``os.path.exists``.
        if os.path.isabs(cand):
            if os.path.isfile(cand) and os.access(cand, os.X_OK):
                return cand
        else:
            resolved = shutil.which(cand)
            if resolved:
                return resolved
    return None


def has_openscad() -> bool:
    """Cheap check used by the persona builder to gate the tool prompt."""
    return _find_openscad() is not None


async def _run_openscad(args: list[str], timeout: float = _TIMEOUT_S) -> tuple[int, bytes, bytes]:
    """Invoke the ``openscad`` binary and capture (rc, stdout, stderr).

    We use ``asyncio.create_subprocess_exec`` so a long render doesn't
    block the event loop. The chat endpoint is async and may have
    other concurrent requests (vitals polling, voice STT, etc.) we
    can't afford to stall.
    """
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError as exc:
        # Best-effort kill — we don't care about its exit, we just want
        # to free the process slot before raising.
        try:
            proc.kill()
            await proc.wait()
        except ProcessLookupError:
            pass
        raise CadError(
            f"OpenSCAD render exceeded {int(timeout)} s — script may be "
            "too complex (try simpler primitives or fewer Boolean ops)."
        ) from exc
    return proc.returncode or 0, stdout, stderr


async def render_openscad(script: str, name: str | None = None) -> CadResult:
    """Render ``script`` to STL + PNG preview using local OpenSCAD.

    Raises ``CadError`` on any failure (binary missing, syntax error,
    timeout, output not produced). The caller is expected to catch
    that and surface a user-readable apology in chat.
    """

    encoded_len = len(script.encode("utf-8"))
    if encoded_len > _MAX_SCRIPT_BYTES:
        raise CadError(
            f"Script too large ({encoded_len} bytes; max "
            f"{_MAX_SCRIPT_BYTES})."
        )

    binary = _find_openscad()
    if binary is None:
        raise CadError(
            "OpenSCAD isn't installed in the alfred-core image. "
            "Rebuild with the latest Dockerfile."
        )

    safe_name = "".join(
        c for c in (name or "model") if c.isalnum() or c in "._- "
    ).strip().replace(" ", "_") or "model"

    # Use a tempdir so partial output / .scad source / OpenSCAD's
    # internal temp files all clean up on success or failure.
    with tempfile.TemporaryDirectory(prefix="alfred-cad-") as tmpdir:
        scad_path = Path(tmpdir) / f"{safe_name}.scad"
        stl_path = Path(tmpdir) / f"{safe_name}.stl"
        png_path = Path(tmpdir) / f"{safe_name}.png"
        scad_path.write_text(script, encoding="utf-8")

        # 1) STL pass. ``--hardwarnings`` makes OpenSCAD treat warnings
        # (e.g. non-manifold geometry) as failures so we surface them
        # instead of producing a corrupt STL the slicer would later
        # reject. Background ``--export-format`` lets us be explicit
        # and avoid any guess-from-extension surprises across versions.
        rc, _, stderr = await _run_openscad(
            [
                binary,
                "--hardwarnings",
                "--export-format=binstl",
                "-o",
                str(stl_path),
                str(scad_path),
            ]
        )
        if rc != 0 or not stl_path.exists() or stl_path.stat().st_size == 0:
            err = stderr.decode("utf-8", errors="replace").strip().splitlines()
            # Trim to the last few lines — OpenSCAD prints a load of
            # font-cache and parse-time chatter we don't want in the
            # chat bubble. The actual error is invariably at the end.
            tail = "; ".join(line for line in err[-4:] if line.strip())
            raise CadError(tail or "OpenSCAD STL render failed.")

        # 2) PNG pass. ``--imgsize`` forces our chat-friendly preview
        # resolution; ``--colorscheme=Tomorrow`` gives a softer look
        # than the default and renders well against the dark HUD
        # background.
        #
        # OpenSCAD's PNG pipeline goes through Qt/OpenGL even in the
        # ``-nogui`` build, so we need an X display. ``xvfb-run``
        # spins up an ephemeral framebuffer if it's available; on
        # bare-metal dev installs that don't have it, we fall back
        # to a direct invocation (which works on macOS / Windows
        # since they have a real display server). PNG failures are
        # absorbed gracefully — the STL is the contract; the preview
        # is just a chat-bubble nicety.
        xvfb = shutil.which("xvfb-run")
        if xvfb is not None:
            png_args = [
                xvfb,
                "-a",
                "--server-args=-screen 0 1024x768x24",
                binary,
            ]
        else:
            png_args = [binary]
        png_args.extend(
            [
                "--export-format=png",
                f"--imgsize={_PREVIEW_SIZE[0]},{_PREVIEW_SIZE[1]}",
                "--colorscheme=Tomorrow",
                "-o",
                str(png_path),
                str(scad_path),
            ]
        )
        # PNG renders are quicker than mesh export; halve timeout.
        rc, _, _ = await _run_openscad(png_args, timeout=_TIMEOUT_S / 2)
        preview = png_path.read_bytes() if png_path.exists() else b""

        return CadResult(
            script=script,
            stl_data=stl_path.read_bytes(),
            preview_data=preview,
            name=safe_name,
        )
