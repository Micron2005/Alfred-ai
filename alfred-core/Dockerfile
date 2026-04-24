FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# ffmpeg is needed by faster-whisper to decode arbitrary audio (webm/opus,
# m4a, etc.) into PCM. Everything else is build hygiene.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ─── Piper TTS (British male voice) ─────────────────────────────────────────
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_VOICE=en_GB-alan-medium
RUN mkdir -p /opt \
 && curl -fsSL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
      | tar -xz -C /opt \
 && mkdir -p /opt/piper/voices \
 && curl -fsSL -o "/opt/piper/voices/${PIPER_VOICE}.onnx" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/${PIPER_VOICE}.onnx?download=true" \
 && curl -fsSL -o "/opt/piper/voices/${PIPER_VOICE}.onnx.json" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/${PIPER_VOICE}.onnx.json?download=true"
ENV PATH="/opt/piper:${PATH}"

COPY pyproject.toml ./
COPY src ./src

RUN pip install --upgrade pip \
    && pip install -e .

# ─── Pre-warm the Whisper STT model ─────────────────────────────────────────
# Downloading at build-time costs ~150MB of image, but keeps the first
# voice request snappy and means the container works fully offline.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8', download_root='/opt/whisper-models')"

EXPOSE 8000

CMD ["uvicorn", "alfred_core.main:app", "--host", "0.0.0.0", "--port", "8000"]
