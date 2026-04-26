"""Voice endpoints: speech-to-text + text-to-speech.

Frontend records audio via MediaRecorder (webm/opus, typically), POSTs
the blob to ``/voice/stt``, and gets back the transcript. To hear Alfred
reply, it POSTs the assistant text to ``/voice/tts`` and plays the
returned WAV in an ``<audio>`` element.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from alfred_core.voice import stt, tts

router = APIRouter(prefix="/voice", tags=["voice"])


class TranscriptOut(BaseModel):
    text: str


class TtsIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)


@router.post("/stt", response_model=TranscriptOut)
async def speech_to_text(audio: UploadFile = File(...)) -> TranscriptOut:
    if audio.content_type and not audio.content_type.startswith("audio/"):
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported audio type: {audio.content_type}",
        )
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio upload")
    # Whisper inference is synchronous + CPU-heavy. Run it on a worker thread
    # so it doesn't pin the event loop for everyone else (chat, TTS, health).
    try:
        text = await asyncio.to_thread(stt.transcribe, data)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc
    return TranscriptOut(text=text)


@router.post(
    "/tts",
    responses={
        200: {
            "content": {
                "audio/mpeg": {},
                "audio/wav": {},
            }
        }
    },
)
async def text_to_speech(payload: TtsIn) -> Response:
    try:
        audio, media_type = await tts.synthesize(payload.text)
    except tts.TtsUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(content=audio, media_type=media_type)
