"""Text-to-speech dispatcher.

Two backends are available:

* ``edge`` — Microsoft Edge "Read Aloud" neural voices via the
  ``edge-tts`` library. Free, no API key, but requires an outbound
  WebSocket to Microsoft. The default British male voice is
  ``en-GB-RyanNeural`` and sounds noticeably more natural than Piper.
  Audio is returned as MP3.

* ``piper`` — the Piper binary baked into the image. Fully offline,
  works without internet, but obviously synthetic. Audio is returned
  as 22050 Hz mono WAV.

The frontend plays whatever bytes we hand back via ``<audio src=blob>``,
so the browser sniffs the format from the bytes themselves; we just
send the right ``Content-Type`` header.

If ``alfred_tts_backend == "edge"`` and the network call fails (no
internet, MS service hiccup, DNS, etc.), we automatically fall back to
Piper so the user always gets *some* audio. If both fail, a
:class:`TtsUnavailableError` propagates and the API turns it into a 503.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)


# ─── Piper (offline) ─────────────────────────────────────────────────────────
PIPER_BIN = Path(os.environ.get("ALFRED_PIPER_BIN", "/opt/piper/piper"))
PIPER_VOICE = Path(
    os.environ.get(
        "ALFRED_PIPER_VOICE", "/opt/piper/voices/en_GB-alan-medium.onnx"
    )
)


class TtsUnavailableError(RuntimeError):
    """Raised when no TTS backend can produce audio."""


class PiperUnavailableError(TtsUnavailableError):
    """Raised when the Piper binary or voice model is missing.

    Kept as a distinct subclass for backwards compatibility with callers
    and tests that catch it specifically.
    """


@lru_cache(maxsize=1)
def _check_piper_install() -> None:
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


async def _synthesize_piper(text: str) -> tuple[bytes, str]:
    """Render ``text`` to a 22050 Hz mono WAV blob via the Piper binary."""
    _check_piper_install()

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
        return out_path.read_bytes(), "audio/wav"
    finally:
        out_path.unlink(missing_ok=True)


# ─── Edge TTS (online, neural) ───────────────────────────────────────────────


async def _synthesize_edge(
    text: str,
    *,
    voice: str,
    rate: str,
    pitch: str,
) -> tuple[bytes, str]:
    """Render ``text`` to MP3 using Microsoft Edge's neural voices."""
    # Imported lazily so unit tests that don't touch edge-tts don't pay the
    # aiohttp import cost, and so a missing wheel during a partial install
    # doesn't break import of this module entirely.
    import edge_tts

    communicator = edge_tts.Communicate(
        text,
        voice=voice,
        rate=rate,
        pitch=pitch,
    )
    chunks: list[bytes] = []
    async for chunk in communicator.stream():
        if chunk.get("type") == "audio":
            data = chunk.get("data")
            if isinstance(data, bytes):
                chunks.append(data)
    blob = b"".join(chunks)
    if not blob:
        raise RuntimeError("Edge TTS returned no audio data")
    return blob, "audio/mpeg"


# ─── Public dispatcher ──────────────────────────────────────────────────────


async def synthesize(text: str) -> tuple[bytes, str]:
    """Render ``text`` to audio. Returns ``(bytes, mime_type)``.

    Picks the backend based on settings. ``edge`` falls back to ``piper``
    automatically if the online call fails — the user always gets audio
    if any backend can produce it.
    """
    # Imported here (rather than at module top) so importing this module
    # never triggers Settings instantiation, which makes the unit tests
    # that monkey-patch ``synthesize`` itself trivial.
    from alfred_core.config import get_settings

    settings = get_settings()

    text = text.strip()
    if not text:
        return b"", "audio/wav"

    backend = (settings.alfred_tts_backend or "edge").strip().lower()

    if backend == "piper":
        return await _synthesize_piper(text)

    # Default + explicit `edge`: try Edge first, fall back to Piper if
    # anything goes wrong (network down, MS hiccup, voice id wrong, etc).
    try:
        return await _synthesize_edge(
            text,
            voice=settings.alfred_edge_tts_voice,
            rate=settings.alfred_edge_tts_rate,
            pitch=settings.alfred_edge_tts_pitch,
        )
    except Exception as edge_exc:
        logger.warning("Edge TTS failed (%s); falling back to Piper.", edge_exc)
        try:
            return await _synthesize_piper(text)
        except PiperUnavailableError:
            # Surface the Edge error as the primary cause, since that's the
            # configured default. Piper's "not installed" message is
            # secondary.
            raise TtsUnavailableError(
                f"Edge TTS failed and Piper is not installed: {edge_exc}"
            ) from edge_exc
