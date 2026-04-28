"""Decides which LLM backend handles a given turn.

Rules of thumb:
- If the user's most recent turn carries one or more images, prefer the
  **local** vision model (free, offline, private — see Phase 17.5).
  If local vision isn't configured, fall back to cloud (Anthropic).
  If neither is wired, raise ``VisionUnavailableError`` so the chat
  endpoint can surface a polite "I can't see images yet" message
  rather than silently dropping the attachment.
- If the user's request looks like a hard coding task AND the cloud backend
  is enabled, send it to Claude.
- Otherwise stay local (chat model).

This is a deliberately small heuristic. As we add real tool-calling in later
phases, this module will grow into something smarter (e.g. a fast classifier
model or an LLM-based router). For now, simple is fine.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from alfred_core.config import Settings
from alfred_core.llm.anthropic_backend import AnthropicBackend
from alfred_core.llm.base import ChatMessage, ChatResponse, LLMBackend
from alfred_core.llm.local import OllamaBackend

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


@dataclass
class Router:
    local: LLMBackend
    cloud: LLMBackend | None
    local_vision: LLMBackend | None
    use_cloud_for_coding: bool

    @classmethod
    def from_settings(cls, settings: Settings) -> Router:
        local = OllamaBackend(
            host=settings.ollama_host, default_model=settings.local_model_chat
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
        return self.local

    async def complete(self, messages: list[ChatMessage]) -> ChatResponse:
        last_user_msg = next(
            (m for m in reversed(messages) if m.role == "user"),
            None,
        )
        last_user_text = last_user_msg.content if last_user_msg else ""
        has_images = bool(last_user_msg and last_user_msg.images)
        backend = self.pick(last_user_text, has_images=has_images)
        return await backend.complete(messages)
