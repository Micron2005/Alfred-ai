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

    # ─── Spotify ────────────────────────────────────────────────────────
    # Create a free Spotify Developer app at developer.spotify.com/dashboard.
    # Add ``http://127.0.0.1:8000/api/spotify/callback`` to the app's
    # redirect URIs and tick both Web API and Web Playback SDK. Then drop
    # the Client ID + Client Secret into .env.
    #
    # IMPORTANT: Spotify began rejecting ``http://localhost`` in 2025.
    # Loopback URIs must use the literal IP ``127.0.0.1`` instead. The
    # default below reflects that.
    #
    # If unset, Spotify integration is silently disabled and Alfred
    # responds politely that music control isn't wired up rather than
    # crashing.
    alfred_spotify_client_id: str = Field(default="")
    alfred_spotify_client_secret: str = Field(default="")
    # The redirect URI must match exactly what is registered in the Spotify
    # app dashboard. Defaults to the local backend; override only if the
    # backend is exposed on a different host/port.
    alfred_spotify_redirect_uri: str = Field(
        default="http://127.0.0.1:8000/api/spotify/callback"
    )

    # ─── Long-term memory archive (Phase 12b) ───────────────────────────
    # Container-side directory where Alfred mirrors each memory note as
    # a Markdown file. Mounted from the host via docker-compose so the
    # user can browse / grep / edit the notes outside Alfred. Default
    # is ``/app/alfred-memory`` inside the container; the host mount
    # point is controlled by ``ALFRED_MEMORY_HOST_PATH`` in
    # ``docker-compose.yml`` and defaults to ``./alfred-memory`` next
    # to the repo on Linux dev boxes (Windows users typically point it
    # at ``C:\Users\<them>\Documents\Alfred Memory``).
    alfred_memory_dir: str = Field(default="/app/alfred-memory")
    # Embedding model name used against Ollama's ``/api/embed`` endpoint.
    # ``nomic-embed-text`` is 768-dim and ships with most stock Ollama
    # installs (``ollama pull nomic-embed-text``). If embeddings can't
    # be produced the note still saves; vector search just won't surface
    # it until it's re-embedded.
    alfred_memory_embedding_model: str = Field(default="nomic-embed-text")
    # When the active conversation grows beyond this many user/assistant
    # messages we roll the oldest 50% into a memory note and drop them
    # from the live history. The summary stays retrievable via vector
    # search, but the active context shrinks back so we never run out
    # of tokens.
    alfred_memory_token_pressure_messages: int = Field(default=80)
    # Top-K notes to inject into the system prompt at chat-start time.
    # Below ~3 ignores too much; above ~6 starts to crowd the prompt.
    alfred_memory_retrieval_top_k: int = Field(default=4)
    # Minimum cosine similarity (0..1) for a memory note to count as
    # "relevant" enough to inject into the prompt. 0.0 disables the
    # threshold (always inject the top-K). Vector search returns
    # similarity, not just rank, so we filter junk matches that would
    # otherwise dilute the context.
    alfred_memory_retrieval_min_similarity: float = Field(default=0.35)

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

    @property
    def has_spotify(self) -> bool:
        """Whether Spotify Developer app credentials are configured.

        Note: this only checks that the *app* is configured. The user
        must still link their Spotify *account* via the OAuth flow
        before the integration can actually do anything. See
        ``SpotifyClient.get_status``.
        """
        return bool(
            self.alfred_spotify_client_id.strip()
            and self.alfred_spotify_client_secret.strip()
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
