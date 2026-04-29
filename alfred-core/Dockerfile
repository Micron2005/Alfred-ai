# Multi-arch base — Docker Buildx auto-selects amd64 on a regular PC
# and aarch64 on a Raspberry Pi 5. The pre-built ML models we
# download below are arch-specific, so we read TARGETARCH from the
# build context and pick the matching binary tarball / URL pair.
FROM --platform=$TARGETPLATFORM python:3.11-slim
ARG TARGETARCH

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
# Piper ships separate tarballs per arch. We pick the right one based
# on Docker's TARGETARCH so the same Dockerfile produces a working
# image on x86_64 desktops AND ARM64 SBCs (Raspberry Pi 5, Apple
# Silicon devs, Oracle Ampere, etc.).
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_VOICE=en_GB-alan-medium
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
        amd64)  PIPER_ARCH=linux_x86_64 ;; \
        arm64)  PIPER_ARCH=linux_aarch64 ;; \
        arm)    PIPER_ARCH=linux_armv7l ;; \
        *) echo "Unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt; \
    curl -fsSL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_${PIPER_ARCH}.tar.gz" \
        | tar -xz -C /opt; \
    mkdir -p /opt/piper/voices; \
    curl -fsSL -o "/opt/piper/voices/${PIPER_VOICE}.onnx" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/${PIPER_VOICE}.onnx?download=true"; \
    curl -fsSL -o "/opt/piper/voices/${PIPER_VOICE}.onnx.json" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/${PIPER_VOICE}.onnx.json?download=true"
ENV PATH="/opt/piper:${PATH}"

COPY pyproject.toml ./
COPY src ./src

RUN pip install --upgrade pip \
    && pip install -e .

# ─── Pre-warm the Whisper STT model ─────────────────────────────────────────
# Downloading at build-time costs ~150MB of image, but keeps the first
# voice request snappy and means the container works fully offline.
# Skip on tiny ARM builders where we'd rather download lazily on first
# use (set ALFRED_SKIP_MODEL_PREFETCH=1 as a build-arg).
ARG ALFRED_SKIP_MODEL_PREFETCH=0
RUN if [ "${ALFRED_SKIP_MODEL_PREFETCH}" = "0" ]; then \
        python -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8', download_root='/opt/whisper-models')"; \
    else \
        echo "Skipping Whisper pre-warm — model will download on first /voice/stt request."; \
    fi

# Healthcheck — gives Compose a real "healthy" status instead of just
# "running". curl is already installed above for the model download.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

EXPOSE 8000

CMD ["uvicorn", "alfred_core.main:app", "--host", "0.0.0.0", "--port", "8000"]
