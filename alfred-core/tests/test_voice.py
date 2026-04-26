"""Voice endpoints + STT / TTS wrappers."""

from __future__ import annotations

import io
from typing import Any
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alfred_core.api import voice as voice_api
from alfred_core.voice import stt, tts


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(voice_api.router)
    return TestClient(app)


def test_stt_rejects_empty_upload(client: TestClient) -> None:
    resp = client.post(
        "/voice/stt",
        files={"audio": ("clip.webm", b"", "audio/webm")},
    )
    assert resp.status_code == 400


def test_stt_rejects_non_audio_content_type(client: TestClient) -> None:
    resp = client.post(
        "/voice/stt",
        files={"audio": ("clip.txt", b"hello", "text/plain")},
    )
    assert resp.status_code == 415


def test_stt_returns_transcript(client: TestClient) -> None:
    with patch.object(stt, "transcribe", return_value="hello alfred"):
        resp = client.post(
            "/voice/stt",
            files={"audio": ("clip.webm", b"\x00\x01\x02", "audio/webm")},
        )
    assert resp.status_code == 200
    assert resp.json() == {"text": "hello alfred"}


def test_tts_rejects_empty_text(client: TestClient) -> None:
    resp = client.post("/voice/tts", json={"text": ""})
    assert resp.status_code == 422  # pydantic min_length=1


def test_tts_returns_audio_bytes_and_media_type(client: TestClient) -> None:
    """The endpoint returns the bytes + media type produced by the dispatcher."""
    fake_mp3 = b"\xff\xf3fake-mp3-frame"

    async def _fake_synth(text: str) -> tuple[bytes, str]:
        assert text.strip() == "at your service, sir"
        return fake_mp3, "audio/mpeg"

    with patch.object(tts, "synthesize", side_effect=_fake_synth):
        resp = client.post("/voice/tts", json={"text": "at your service, sir"})

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("audio/mpeg")
    assert resp.content == fake_mp3


def test_tts_returns_wav_when_piper_backend(client: TestClient) -> None:
    """If the dispatcher picks Piper, the response advertises audio/wav."""
    fake_wav = b"RIFF\x00\x00\x00\x00WAVEfake-pcm-data"

    async def _fake_synth(text: str) -> tuple[bytes, str]:
        return fake_wav, "audio/wav"

    with patch.object(tts, "synthesize", side_effect=_fake_synth):
        resp = client.post("/voice/tts", json={"text": "hello"})

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("audio/wav")
    assert resp.content == fake_wav


def test_tts_503_when_no_backend_available(client: TestClient) -> None:
    async def _missing(text: str) -> tuple[bytes, str]:
        raise tts.TtsUnavailableError("no TTS backend available")

    with patch.object(tts, "synthesize", side_effect=_missing):
        resp = client.post("/voice/tts", json={"text": "hello"})
    assert resp.status_code == 503


def test_tts_503_when_piper_missing(client: TestClient) -> None:
    """PiperUnavailableError is a TtsUnavailableError subclass and still 503s."""

    async def _missing(text: str) -> tuple[bytes, str]:
        raise tts.PiperUnavailableError("piper not installed")

    with patch.object(tts, "synthesize", side_effect=_missing):
        resp = client.post("/voice/tts", json={"text": "hello"})
    assert resp.status_code == 503


def test_stt_transcribe_uses_buffer() -> None:
    """The wrapper hands a BytesIO to faster-whisper rather than spilling
    to disk, and concatenates segment text in order."""
    captured: dict[str, Any] = {}

    class _Seg:
        def __init__(self, text: str) -> None:
            self.text = text

    class _FakeModel:
        def transcribe(self, source: Any, **kwargs: Any) -> tuple[Any, Any]:
            captured["source"] = source
            captured["kwargs"] = kwargs
            return iter([_Seg("hello "), _Seg("alfred ")]), None

    with patch.object(stt, "_model", return_value=_FakeModel()):
        text = stt.transcribe(b"raw-audio")

    assert text == "hello alfred"
    assert isinstance(captured["source"], io.BytesIO)
    assert captured["kwargs"].get("vad_filter") is True


def test_stt_empty_bytes_short_circuits() -> None:
    assert stt.transcribe(b"") == ""


# ─── TTS dispatcher ─────────────────────────────────────────────────────────


class _FakeSettings:
    """Minimal stand-in for alfred_core.config.Settings in dispatcher tests."""

    def __init__(
        self,
        *,
        backend: str = "edge",
        voice: str = "en-GB-RyanNeural",
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> None:
        self.alfred_tts_backend = backend
        self.alfred_edge_tts_voice = voice
        self.alfred_edge_tts_rate = rate
        self.alfred_edge_tts_pitch = pitch


@pytest.mark.asyncio
async def test_synthesize_empty_text_short_circuits() -> None:
    audio, mime = await tts.synthesize("   ")
    assert audio == b""
    assert mime.startswith("audio/")


@pytest.mark.asyncio
async def test_synthesize_uses_edge_when_configured() -> None:
    captured: dict[str, Any] = {}

    async def _fake_edge(text: str, *, voice: str, rate: str, pitch: str) -> tuple[bytes, str]:
        captured["voice"] = voice
        captured["rate"] = rate
        captured["pitch"] = pitch
        return b"\xff\xf3edge-output", "audio/mpeg"

    with (
        patch(
            "alfred_core.config.get_settings",
            return_value=_FakeSettings(backend="edge", voice="en-GB-RyanNeural"),
        ),
        patch.object(tts, "_synthesize_edge", side_effect=_fake_edge),
    ):
        audio, mime = await tts.synthesize("good evening sir")

    assert audio == b"\xff\xf3edge-output"
    assert mime == "audio/mpeg"
    assert captured["voice"] == "en-GB-RyanNeural"


@pytest.mark.asyncio
async def test_synthesize_uses_piper_when_configured() -> None:
    async def _fake_piper(text: str) -> tuple[bytes, str]:
        return b"RIFF\x00\x00\x00\x00WAVE-piper", "audio/wav"

    edge_called = False

    async def _edge_should_not_run(*args: Any, **kwargs: Any) -> tuple[bytes, str]:
        nonlocal edge_called
        edge_called = True
        raise AssertionError("Edge backend should not be invoked when backend=piper")

    with (
        patch(
            "alfred_core.config.get_settings",
            return_value=_FakeSettings(backend="piper"),
        ),
        patch.object(tts, "_synthesize_piper", side_effect=_fake_piper),
        patch.object(tts, "_synthesize_edge", side_effect=_edge_should_not_run),
    ):
        audio, mime = await tts.synthesize("hello")

    assert audio.startswith(b"RIFF")
    assert mime == "audio/wav"
    assert edge_called is False


@pytest.mark.asyncio
async def test_synthesize_falls_back_to_piper_when_edge_fails() -> None:
    """If Edge raises (network down, etc.), Piper should still produce audio."""

    async def _broken_edge(*args: Any, **kwargs: Any) -> tuple[bytes, str]:
        raise RuntimeError("network unreachable")

    async def _fake_piper(text: str) -> tuple[bytes, str]:
        return b"RIFF-fallback", "audio/wav"

    with (
        patch(
            "alfred_core.config.get_settings",
            return_value=_FakeSettings(backend="edge"),
        ),
        patch.object(tts, "_synthesize_edge", side_effect=_broken_edge),
        patch.object(tts, "_synthesize_piper", side_effect=_fake_piper),
    ):
        audio, mime = await tts.synthesize("hello")

    assert audio == b"RIFF-fallback"
    assert mime == "audio/wav"


@pytest.mark.asyncio
async def test_synthesize_raises_when_both_backends_fail() -> None:
    async def _broken_edge(*args: Any, **kwargs: Any) -> tuple[bytes, str]:
        raise RuntimeError("network unreachable")

    async def _missing_piper(text: str) -> tuple[bytes, str]:
        raise tts.PiperUnavailableError("piper binary not found")

    with (
        patch(
            "alfred_core.config.get_settings",
            return_value=_FakeSettings(backend="edge"),
        ),
        patch.object(tts, "_synthesize_edge", side_effect=_broken_edge),
        patch.object(tts, "_synthesize_piper", side_effect=_missing_piper),
        pytest.raises(tts.TtsUnavailableError),
    ):
        await tts.synthesize("hello")
