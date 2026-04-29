"""Decides which LLM backend handles a given turn.

Rules of thumb:
- If the user's most recent turn carries one or more images, prefer the
  **local** vision model (free, offline, private — see Phase 17.5).
  If local vision isn't configured, fall back to cloud (Anthropic).
  If neither is wired, raise ``VisionUnavailableError`` so the chat
  endpoint can surface a polite "I can't see images yet" message
  rather than silently dropping the attachment.
- If local chat is disabled (``LOCAL_MODEL_CHAT=""``) but cloud is
  available, every text turn goes to cloud. Useful on hosts that
  don't have enough RAM / VRAM to run a chat model locally.
- Else if the user's request looks like a hard coding task AND the
  cloud backend is enabled, send it to Claude.
- Otherwise stay local (chat model).

If neither local chat nor cloud is wired, ``LLMUnavailableError`` is
raised so the chat endpoint can surface a clear "no chat backend
configured" message rather than crashing on a None.

This is a deliberately small heuristic. As we add real tool-calling in later
phases, this module will grow into something smarter (e.g. a fast classifier
model or an LLM-based router). For now, simple is fine.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import httpx

from alfred_core.config import Settings
from alfred_core.llm.anthropic_backend import AnthropicBackend
from alfred_core.llm.base import ChatMessage, ChatResponse, LLMBackend
from alfred_core.llm.local import OllamaBackend

_log = logging.getLogger(__name__)

_CODE_SIGNALS = re.compile(
    r"\b("
    r"code|coding|function|method|class|bug|debug|refactor|typescript|python|"
    r"javascript|react|next\.?js|fastapi|sql|regex|algorithm|stack\s?trace|"
    r"exception|traceback|unit\s+test|implement|compile|runtime\s+error"
    r")\b|```",
    re.IGNORECASE,
)


class VisionUnavailableError(RuntimeError):
    """Raised when an image-bearing turn arrives but no vision backend is wired."""


class LLMUnavailableError(RuntimeError):
    """Raised when no chat backend (local or cloud) is configured."""


@dataclass
class Router:
    local: LLMBackend | None
    cloud: LLMBackend | None
    local_vision: LLMBackend | None
    use_cloud_for_coding: bool

    @classmethod
    def from_settings(cls, settings: Settings) -> Router:
        # Local chat is opt-in — disabling it (``LOCAL_MODEL_CHAT=""``)
        # is the right move on hosts that lack the RAM / VRAM to run a
        # chat model locally. The router then routes every text turn
        # through cloud.
        local: LLMBackend | None = None
        if settings.has_local_chat:
            local = OllamaBackend(
                host=settings.ollama_host,
                default_model=settings.local_model_chat,
            )
        cloud: LLMBackend | None = None
        if settings.has_cloud:
            cloud = AnthropicBackend(
                api_key=settings.anthropic_api_key,
                default_model=settings.anthropic_model,
            )
        # Local vision is its own Ollama-backed instance pointed at the
        # vision model. Same code path as the chat backend; only the
        # default model differs. We don't ping Ollama to verify the
        # model is pulled — if it isn't, the request 404s at chat time
        # and surfaces as a normal vision error.
        local_vision: LLMBackend | None = None
        if settings.has_local_vision:
            local_vision = OllamaBackend(
                host=settings.ollama_host,
                default_model=settings.local_model_vision,
            )
        return cls(
            local=local,
            cloud=cloud,
            local_vision=local_vision,
            use_cloud_for_coding=settings.use_cloud_for_coding,
        )

    def pick(self, last_user_message: str, *, has_images: bool = False) -> LLMBackend:
        if has_images:
            # Prefer the local vision model — it's free, runs on the
            # user's GPU, and doesn't leak the image to a third party.
            # Fall back to cloud (Anthropic) only if local isn't
            # configured.
            if self.local_vision is not None:
                return self.local_vision
            if self.cloud is not None:
                return self.cloud
            raise VisionUnavailableError(
                "I can't see images yet, sir — no vision backend is "
                "configured. Either pull a local vision model "
                "(`ollama pull llama3.2-vision:11b`) or set "
                "ANTHROPIC_API_KEY in .env, then restart the containers."
            )
        if (
            self.cloud is not None
            and self.use_cloud_for_coding
            and _CODE_SIGNALS.search(last_user_message)
        ):
            return self.cloud
        if self.local is not None:
            return self.local
        # No local — fall through to cloud. This is the
        # ``LOCAL_MODEL_CHAT=""`` path: the user has explicitly
        # disabled local chat and Anthropic now carries every text
        # turn.
        if self.cloud is not None:
            return self.cloud
        raise LLMUnavailableError(
            "No chat backend is configured, sir. Either set "
            "LOCAL_MODEL_CHAT in .env to a model you've pulled, or "
            "set ANTHROPIC_API_KEY for cloud chat, then restart the "
            "containers."
        )

    async def complete(self, messages: list[ChatMessage]) -> ChatResponse:
        last_user_msg = next(
            (m for m in reversed(messages) if m.role == "user"),
            None,
        )
        last_user_text = last_user_msg.content if last_user_msg else ""
        has_images = bool(last_user_msg and last_user_msg.images)
        backend = self.pick(last_user_text, has_images=has_images)
        try:
            return await backend.complete(messages)
        except (httpx.TimeoutException, httpx.HTTPError, httpx.HTTPStatusError) as exc:
            # Local Ollama fell over — most commonly a ReadTimeout when
            # the model gets stuck looping on a tricky prompt. If the
            # cloud (Anthropic) backend is configured AND we weren't
            # already on it, transparently fall through. The user's
            # turn still lands; he just gets a Claude reply instead of
            # an Ollama one. Without this, the chat handler 502s and
            # the user thinks Alfred is broken when in reality the
            # local model just needed a poke.
            is_local = backend is self.local or backend is self.local_vision
            if is_local and self.cloud is not None:
                _log.warning(
                    "Local LLM failed (%s: %s) — falling back to cloud.",
                    type(exc).__name__,
                    exc,
                )
                return await self.cloud.complete(messages)
            raise
