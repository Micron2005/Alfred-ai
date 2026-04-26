"""Runtime configuration loaded from environment variables."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All Alfred runtime configuration.

    Values come from the environment (or a `.env` file in dev). See
    `.env.example` at the repo root for the canonical list of variables.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ─── Identity ────────────────────────────────────────────────────────
    alfred_user_full_name: str = Field(default="Mukarram Mohammad Alam")
    alfred_user_short_name: str = Field(default="Mukarram")
    alfred_user_address: str = Field(default="sir")
    alfred_user_address_nightfall: str = Field(default="Batman")
    alfred_default_mode: str = Field(default="standard")

    # ─── Local LLM (Ollama) ─────────────────────────────────────────────
    ollama_host: str = Field(default="http://host.docker.internal:11434")
    local_model_chat: str = Field(default="llama3.1:8b-instruct-q4_K_M")
    local_model_fast: str = Field(default="phi3.5:3.8b-mini-instruct-q4_K_M")

    # ─── Cloud LLM (optional) ───────────────────────────────────────────
    anthropic_api_key: str = Field(default="")
    anthropic_model: str = Field(default="claude-sonnet-4-5-20250929")
    use_cloud_for_coding: bool = Field(default=True)

    # ─── Location / time / weather ──────────────────────────────────────
    alfred_location_city: str = Field(default="Fredericksburg, VA")
    alfred_location_latitude: float = Field(default=38.3032)
    alfred_location_longitude: float = Field(default=-77.4605)
    alfred_timezone: str = Field(default="America/New_York")

    # ─── Database ───────────────────────────────────────────────────────
    database_url: str = Field(
        default="postgresql+psycopg://alfred:wayne-manor@localhost:5432/alfred"
    )

    # ─── Gmail (SMTP, app-password auth) ────────────────────────────────
    alfred_gmail_address: str = Field(default="")
    alfred_gmail_app_password: str = Field(default="")
    alfred_gmail_display_name: str = Field(default="Alfred (for Mukarram)")

    # ─── Web search (Tavily) ────────────────────────────────────────────
    # Free tier at https://tavily.com gives 1,000 searches per month —
    # plenty for a single-user assistant. If unset, web search is
    # silently disabled and Alfred will tell the user it isn't wired up
    # rather than crashing.
    alfred_tavily_api_key: str = Field(default="")

    # ─── Voice (TTS) ────────────────────────────────────────────────────
    # `edge` uses Microsoft's Edge Read-Aloud neural voices (free, online,
    # noticeably more natural). `piper` uses the offline Piper binary baked
    # into the image. Edge falls back to Piper automatically if the network
    # call fails, so the offline fallback is always there.
    alfred_tts_backend: str = Field(default="edge")
    alfred_edge_tts_voice: str = Field(default="en-GB-RyanNeural")
    alfred_edge_tts_rate: str = Field(default="+0%")
    alfred_edge_tts_pitch: str = Field(default="+0Hz")

    @property
    def has_cloud(self) -> bool:
        """Whether a real Anthropic key has been configured."""
        return bool(self.anthropic_api_key and self.anthropic_api_key.strip())

    @property
    def has_gmail(self) -> bool:
        """Whether outgoing Gmail credentials are configured."""
        return bool(
            self.alfred_gmail_address.strip() and self.alfred_gmail_app_password.strip()
        )

    @property
    def has_tavily(self) -> bool:
        """Whether a Tavily API key is configured for web search."""
        return bool(self.alfred_tavily_api_key and self.alfred_tavily_api_key.strip())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
