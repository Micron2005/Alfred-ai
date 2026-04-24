"""Decides which LLM backend handles a given turn.

Rules of thumb:
- If the user's request looks like a hard coding task AND the cloud backend
  is enabled, send it to Claude.
- Otherwise stay local.

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


@dataclass
class Router:
    local: LLMBackend
    cloud: LLMBackend | None
    use_cloud_for_coding: bool

    @classmethod
    def from_settings(cls, settings: Settings) -> Router:
        local = OllamaBackend(host=settings.ollama_host, default_model=settings.local_model_chat)
        cloud: LLMBackend | None = None
        if settings.has_cloud:
            cloud = AnthropicBackend(
                api_key=settings.anthropic_api_key,
                default_model=settings.anthropic_model,
            )
        return cls(
            local=local,
            cloud=cloud,
            use_cloud_for_coding=settings.use_cloud_for_coding,
        )

    def pick(self, last_user_message: str) -> LLMBackend:
        if (
            self.cloud is not None
            and self.use_cloud_for_coding
            and _CODE_SIGNALS.search(last_user_message)
        ):
            return self.cloud
        return self.local

    async def complete(self, messages: list[ChatMessage]) -> ChatResponse:
        last_user = next(
            (m.content for m in reversed(messages) if m.role == "user"),
            "",
        )
        backend = self.pick(last_user)
        return await backend.complete(messages)
