"""Text-to-speech via the Piper binary.

Piper produces 22050 Hz mono WAV audio. We invoke it as a subprocess,
piping the user's text on stdin and reading the resulting WAV from a
short-lived temp file. This keeps Alfred's voice synthesis hermetic —
no Python C-extension shenanigans — and works the same in Docker as it
does on a developer's laptop (provided the binary is on PATH).
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from functools import lru_cache
from pathlib import Path

PIPER_BIN = Path(os.environ.get("ALFRED_PIPER_BIN", "/opt/piper/piper"))
PIPER_VOICE = Path(
    os.environ.get(
        "ALFRED_PIPER_VOICE", "/opt/piper/voices/en_GB-alan-medium.onnx"
    )
)


class PiperUnavailableError(RuntimeError):
    """Raised when the Piper binary or voice model is missing."""


@lru_cache(maxsize=1)
def _check_install() -> None:
    if not PIPER_BIN.exists():
        raise PiperUnavailableError(
            f"Piper binary not found at {PIPER_BIN}. "
            "Rebuild the alfred-core image to fetch it."
        )
    if not PIPER_VOICE.exists():
        raise PiperUnavailableError(
            f"Piper voice model not found at {PIPER_VOICE}. "
            "Rebuild the alfred-core image to fetch it."
        )


async def synthesize(text: str) -> bytes:
    """Render ``text`` to a 22050 Hz mono WAV blob."""
    _check_install()

    text = text.strip()
    if not text:
        return b""

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = Path(tmp.name)

    try:
        proc = await asyncio.create_subprocess_exec(
            str(PIPER_BIN),
            "--model",
            str(PIPER_VOICE),
            "--output_file",
            str(out_path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate(input=text.encode("utf-8"))
        if proc.returncode != 0:
            raise RuntimeError(
                f"Piper exited with {proc.returncode}: {stderr.decode(errors='replace')}"
            )
        return out_path.read_bytes()
    finally:
        out_path.unlink(missing_ok=True)
