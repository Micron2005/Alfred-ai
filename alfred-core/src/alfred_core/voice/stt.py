"""Speech-to-text via faster-whisper."""

from __future__ import annotations

import io
import logging
import os
from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from faster_whisper import WhisperModel  # type: ignore[import-untyped]

_MODEL_NAME = os.environ.get("ALFRED_WHISPER_MODEL", "base.en")
_MODEL_DIR = os.environ.get("ALFRED_WHISPER_DIR", "/opt/whisper-models")

_log = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _model() -> WhisperModel:
    """Load (and cache) the Whisper model. Imported lazily so that test
    environments without faster-whisper installed don't blow up at import
    time, and so the heavy native libs only load on first transcription."""
    from faster_whisper import WhisperModel

    download_root = _MODEL_DIR if os.path.isdir(_MODEL_DIR) else None
    _log.info("Loading Whisper model %s (download_root=%s)", _MODEL_NAME, download_root)
    return WhisperModel(
        _MODEL_NAME,
        device="cpu",
        compute_type="int8",
        download_root=download_root,
    )


def transcribe(audio_bytes: bytes) -> str:
    """Transcribe an audio blob (any ffmpeg-readable format) to text."""
    if not audio_bytes:
        return ""
    buf = io.BytesIO(audio_bytes)
    segments, _info = _model().transcribe(buf, beam_size=1, vad_filter=True)
    return " ".join(segment.text.strip() for segment in segments).strip()
