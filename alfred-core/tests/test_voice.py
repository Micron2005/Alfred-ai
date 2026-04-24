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


def test_tts_returns_wav_bytes(client: TestClient) -> None:
    fake_wav = b"RIFF\x00\x00\x00\x00WAVEfake-pcm-data"

    async def _fake_synth(text: str) -> bytes:
        assert text.strip() == "at your service, sir"
        return fake_wav

    with patch.object(tts, "synthesize", side_effect=_fake_synth):
        resp = client.post("/voice/tts", json={"text": "at your service, sir"})

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("audio/wav")
    assert resp.content == fake_wav


def test_tts_503_when_piper_missing(client: TestClient) -> None:
    async def _missing(text: str) -> bytes:
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
