"""Voice I/O — speech-to-text (Whisper) and text-to-speech (Piper).

Both backends are CPU-friendly:

- ``stt`` uses ``faster-whisper`` with the ``base.en`` model (~150MB).
- ``tts`` shells out to the Piper binary using the ``en_GB-alan-medium``
  voice — a British male voice that fits Alfred's persona.

Models live under ``/opt/whisper-models`` and ``/opt/piper`` respectively
and are baked into the alfred-core Docker image.
"""
