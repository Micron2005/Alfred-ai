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
    # Default chat model — Dolphin-flavoured Llama 3.1 8B. The Dolphin
    # fine-tune is uncensored, which matches the user's stated
    # preference: "no filter on what he can say or help with". The
    # base Meta Llama 3.1 instruct refuses casual profanity, jokes
    # with friends, and a long list of legal-but-edgy requests; the
    # Dolphin tune does not. ~4.7 GB on disk; same hardware needs
    # as the previous default. Pull once with:
    #   ollama pull dolphin-llama3:8b-v2.9-q4_K_M
    # Set this to ``""`` to disable local chat entirely (every text
    # turn then routes to cloud Anthropic — useful on RAM-poor hosts).
    local_model_chat: str = Field(default="dolphin-llama3:8b-v2.9-q4_K_M")
    local_model_fast: str = Field(default="phi3.5:3.8b-mini-instruct-q4_K_M")
    # Vision-capable Ollama model. Used when the user attaches an image
    # to a turn. Default is Meta's Llama 3.2-Vision 11B (~6.5 GB on
    # disk, fits in 8 GB VRAM with room to spare). Pull it once with
    # ``ollama pull llama3.2-vision:11b`` before first use; if the
    # model isn't installed Ollama returns a 404 and the chat handler
    # surfaces it as a vision error.
    #
    # Set to an empty string to disable local vision entirely — Alfred
    # will then fall back to cloud vision (Anthropic) if available, or
    # report ``VisionUnavailableError`` if neither is wired.
    local_model_vision: str = Field(default="llama3.2-vision:11b")

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

    # ─── Auth (single-user password gate) ───────────────────────────────
    # bcrypt hash of the master password. When unset, Alfred runs with
    # no auth (legacy behaviour, fine for a Tailscale-only deployment).
    # When set, every /api/* endpoint except /api/health and /api/auth/*
    # requires a valid JWT cookie. Generate the hash once on the host:
    #     python -c "import bcrypt; print(bcrypt.hashpw(b'YOUR_PASSWORD',
    #                bcrypt.gensalt()).decode())"
    # then drop the result in .env as ALFRED_PASSWORD_HASH=$2b$...
    alfred_password_hash: str = Field(default="")
    # 64+ chars of random hex used to sign JWTs. Generate with:
    #   python -c "import secrets; print(secrets.token_hex(32))"
    # Default is a placeholder; you MUST change it before exposing
    # Alfred outside localhost. The auth module refuses to start with
    # the placeholder if alfred_password_hash is also set.
    alfred_jwt_secret: str = Field(default="CHANGE-ME-INSECURE-PLACEHOLDER")
    # Access token life. 60 min is comfortable for a single-user app
    # where you don't want to keep re-logging in; bump down if you're
    # paranoid.
    alfred_jwt_access_ttl_minutes: int = Field(default=60)
    # Refresh-token life — the cookie that quietly mints new access
    # tokens without you re-entering a password. 30 days = "log in
    # once a month".
    alfred_jwt_refresh_ttl_days: int = Field(default=30)
    # Brute-force lockout. After this many consecutive failed
    # attempts from one client IP the login endpoint stops responding
    # for ``alfred_login_lockout_minutes`` minutes.
    alfred_login_max_failures: int = Field(default=5)
    alfred_login_lockout_minutes: int = Field(default=15)

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

    # ─── 3D printer (Klipper / Moonraker — Creality K1, K1 Max, etc.) ───
    # Base URL of the printer's Moonraker HTTP API. K1 / K1 Max ship
    # with this exposed on port 7125 of the printer's LAN IP. Leave
    # blank to disable printer integration entirely (the frontend
    # widget then folds into a "configure printer" hint instead).
    # Example: ``http://192.168.1.42:7125``
    alfred_printer_url: str = Field(default="")
    # Optional API key, if the user has put Moonraker behind a
    # reverse-proxy with a token. The K1 / K1 Max stock firmware
    # doesn't enforce one; leave empty there.
    alfred_printer_api_key: str = Field(default="")

    # ─── Onshape (Phase 18b — cloud CAD, optional) ─────────────────────
    # HMAC-signed API keys from https://dev-portal.onshape.com/keys.
    # Leave both blank to disable the Onshape backend entirely — Alfred
    # then only offers the local OpenSCAD path. Keys are a pair (access
    # + secret); the secret is shown ONCE at creation time in Onshape's
    # portal, so if you've misplaced it you need to rotate the pair.
    alfred_onshape_access_key: str = Field(default="")
    alfred_onshape_secret_key: str = Field(default="")
    # Base URL of Onshape's REST API. There's only one public endpoint
    # today, but enterprise customers sometimes sit behind a different
    # host, so this is configurable. Trailing slash is stripped at read
    # time in ``onshape.py``.
    alfred_onshape_base_url: str = Field(default="https://cad.onshape.com")

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
    def has_auth(self) -> bool:
        """Whether the password gate is enabled.

        Auth is opt-in by ``ALFRED_PASSWORD_HASH`` being set. Backwards-
        compatible with existing deployments that just relied on the
        Tailscale-only network gate. We refuse to enable auth without
        also rotating the JWT secret away from the placeholder — that
        would be a footgun on the first deploy.
        """
        if not self.alfred_password_hash.strip():
            return False
        if self.alfred_jwt_secret == "CHANGE-ME-INSECURE-PLACEHOLDER":
            raise RuntimeError(
                "ALFRED_PASSWORD_HASH is set but ALFRED_JWT_SECRET is still "
                "the placeholder. Generate a real secret with "
                "`python -c 'import secrets; print(secrets.token_hex(32))'` "
                "and set it in .env before starting Alfred."
            )
        return True

    @property
    def has_local_chat(self) -> bool:
        """Whether a local Ollama chat model is configured.

        Setting ``LOCAL_MODEL_CHAT=""`` in ``.env`` disables the local
        path entirely. The router then routes every text turn through
        cloud (Anthropic). Useful when the host doesn't have enough
        RAM / VRAM to run a chat model — for instance on WSL2 with a
        small memory cap, or on a machine without a usable GPU.

        As with ``has_local_vision``, we don't ping Ollama to verify
        the named model is pulled — if it isn't, the chat request
        404s at runtime and surfaces as a normal LLM error.
        """

        return bool(self.local_model_chat and self.local_model_chat.strip())

    @property
    def has_local_vision(self) -> bool:
        """Whether a local Ollama vision model is configured.

        Note this only checks that the *model name* is set — we don't
        contact Ollama at startup to verify the user has actually
        pulled it. If the model isn't available locally, the request
        will fail at chat time and surface as a normal vision error.
        """

        return bool(self.local_model_vision and self.local_model_vision.strip())

    @property
    def has_vision(self) -> bool:
        """Whether *some* vision backend is wired (local or cloud).

        The persona's vision tool prompt is gated on this rather than
        on the cloud backend specifically, since either path lets
        Alfred actually see what the user attaches.
        """

        return self.has_local_vision or self.has_cloud

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

    @property
    def has_cad(self) -> bool:
        """Whether the local OpenSCAD binary is available.

        Resolved lazily by shelling out via ``shutil.which`` — see
        ``alfred_core.tools.cad.has_openscad``. We do the import
        inline to avoid a startup-time dependency cycle (the tools
        module imports ``Settings`` itself).
        """
        from alfred_core.tools.cad import has_openscad

        return has_openscad()

    @property
    def has_onshape(self) -> bool:
        """Whether Onshape API keys are configured.

        Key pair has to be non-empty; we don't try to ping the Onshape
        API at startup because that would slow every boot and fail on
        offline dev machines. Auth errors surface on first real use.
        """
        return bool(
            self.alfred_onshape_access_key.strip()
            and self.alfred_onshape_secret_key.strip()
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
