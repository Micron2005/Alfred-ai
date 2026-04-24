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

    # ─── Database ───────────────────────────────────────────────────────
    database_url: str = Field(
        default="postgresql+psycopg://alfred:wayne-manor@localhost:5432/alfred"
    )

    @property
    def has_cloud(self) -> bool:
        """Whether a real Anthropic key has been configured."""
        return bool(self.anthropic_api_key and self.anthropic_api_key.strip())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
