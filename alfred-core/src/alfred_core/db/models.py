"""SQLAlchemy models for Alfred's memory, conversations, and feedback.

The ``MemoryNote`` model carries the long-term-memory archive added in
Phase 12b — structured summaries of past conversations, with a pgvector
embedding column so retrieval can be semantic rather than keyword-only.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# Dimensionality for the memory embedding. Matches Ollama's default
# ``nomic-embed-text`` model (768 dims). If you wire a different
# embedding model, change this and run a fresh DB (the column type is
# baked into the schema).
MEMORY_EMBEDDING_DIM = 768


def _utcnow() -> datetime:
    """Aware UTC ``now``. ``datetime.utcnow`` is deprecated in 3.12 and
    produces a naive value, which is the root cause of the wrong-clock bug
    in the conversation sidebar — values were treated as local time by the
    browser. We normalise to aware UTC at write time."""
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    title: Mapped[str] = mapped_column(String(200), default="New conversation")
    mode: Mapped[str] = mapped_column(String(32), default="standard")
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)

    messages: Mapped[list[Message]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="Message.created_at",
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    conversation_id: Mapped[UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))  # system | user | assistant
    content: Mapped[str] = mapped_column(Text)
    backend: Mapped[str | None] = mapped_column(String(32), nullable=True)
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    metadata_json: Mapped[dict[str, object] | None] = mapped_column(
        JSONB, nullable=True, default=None
    )
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")


class Fact(Base):
    """A single fact Alfred has learned about his user.

    Populated both automatically (via ``[REMEMBER: ...]`` markers Alfred
    emits in his own replies) and explicitly (via the ``/facts`` endpoints).
    Recent facts are injected into every system prompt so Alfred always has
    them in mind.
    """

    __tablename__ = "facts"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    content: Mapped[str] = mapped_column(Text, unique=True)
    source: Mapped[str] = mapped_column(String(32), default="auto")
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)


class Feedback(Base):
    """Thumbs-up / thumbs-down feedback on individual assistant messages.

    Populated by the web UI. Consumed later by the periodic LoRA fine-tuning
    pipeline (Phase 5) to shape Alfred's personality toward the user.
    """

    __tablename__ = "feedback"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    message_id: Mapped[UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), index=True
    )
    rating: Mapped[int] = mapped_column()  # +1 up, -1 down
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)


class SpotifyAccount(Base):
    """Linked Spotify account for the single-user Alfred install.

    We store the access + refresh tokens server-side so the chat tool
    can talk to Spotify directly (start playback, query now-playing,
    pull audio analysis) without dragging the browser into the loop
    for every call. The refresh token is long-lived and the access
    token is renewed on demand when it expires.

    There is intentionally only ever one row in this table: the
    ``account_key`` column is fixed at ``"default"`` for now since
    Alfred is single-user. Multi-user support would key it on a real
    user identifier instead.
    """

    __tablename__ = "spotify_accounts"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    account_key: Mapped[str] = mapped_column(String(64), unique=True, default="default")
    # Spotify user identifiers (display name + URI) for the linked
    # account, populated on connect so the UI can show "Connected as
    # X" without an extra API hop.
    spotify_user_id: Mapped[str] = mapped_column(String(128), default="")
    display_name: Mapped[str] = mapped_column(String(200), default="")
    # OAuth tokens. Access tokens are short-lived (1h); we store the
    # refresh token and renew on demand.
    access_token: Mapped[str] = mapped_column(Text)
    refresh_token: Mapped[str] = mapped_column(Text)
    # Granted scope string (space-delimited list as Spotify returns it).
    # Stored so we can detect when the user needs to re-link after we
    # add features that require new scopes.
    scope: Mapped[str] = mapped_column(Text, default="")
    # Absolute expiry timestamp for the access token. Refresh proactively
    # ~30 s before this to avoid mid-call 401s.
    expires_at: Mapped[datetime] = mapped_column(default=_utcnow)
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=_utcnow, onupdate=_utcnow)


class MemoryNote(Base):
    """A structured long-term memory of a past conversation.

    Generated by ``memory_archive.summarize_conversation`` (Phase 12b).
    The note captures the topic, key facts, decisions, and follow-ups
    from a conversation in a form Alfred can semantically retrieve when
    a future chat brings it up. Mirrored to a Markdown file under
    ``ALFRED_MEMORY_DIR`` so the user can browse / grep / edit them
    outside Alfred.

    The ``embedding`` column is a 768-dim pgvector populated from the
    note's title + summary. Retrieval uses cosine distance. If the
    embedding service is unreachable at write time the column is left
    NULL and that note simply won't surface via vector search until it
    is re-embedded — keyword search still finds it by title/body.
    """

    __tablename__ = "memory_notes"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    # Conversation this note was distilled from. Nullable because notes
    # can also be created manually or rolled up from a *segment* of a
    # conversation (token-pressure case). ``ondelete="SET NULL"`` so
    # purging old conversations doesn't drop the long-term memory of
    # them.
    source_conversation_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(200), default="Untitled memory")
    # Short paragraph summarising what the conversation was about.
    summary: Mapped[str] = mapped_column(Text, default="")
    # Structured bullet payload as JSON: {"key_facts": [...],
    # "decisions": [...], "follow_ups": [...]}. Free-form so future
    # extraction passes can add fields without a migration.
    structured: Mapped[dict[str, object] | None] = mapped_column(
        JSONB, nullable=True, default=None
    )
    # Origin marker — ``conversation_summary``, ``rolling_context``
    # (token-pressure rollup), or ``manual`` (user-edited). Used by
    # the UI to label notes.
    source: Mapped[str] = mapped_column(String(32), default="conversation_summary")
    # Filename within ``ALFRED_MEMORY_DIR`` of the markdown mirror.
    # Empty when the file mirror is disabled or hasn't been written
    # yet.
    markdown_filename: Mapped[str] = mapped_column(String(200), default="")
    embedding: Mapped[list[float] | None] = mapped_column(
        Vector(MEMORY_EMBEDDING_DIM), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=_utcnow, onupdate=_utcnow)


# Identity vector dimensionality for face enrollments. Matches the
# 96-D normalized pairwise-distance signature emitted by
# ``alfred-web/src/lib/useFaceTracking.ts``. If you swap that
# pipeline for a learned embedding (FaceNet 128-D, ArcFace 512-D),
# update both this constant and the schema migration.
FACE_IDENTITY_DIM = 96


class FaceEnrollment(Base):
    """A known face — name + identity vector — for the recognition
    panel.

    The identity vector comes from MediaPipe FaceLandmarker landmark
    geometry on the client (cheap, no extra deps). For production
    accuracy, swap the client-side vector for a learned face
    embedding (see ``alfred_core.vision.face_recognition``).
    """

    __tablename__ = "face_enrollments"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(120), index=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    identity_vector: Mapped[list[float]] = mapped_column(
        Vector(FACE_IDENTITY_DIM)
    )
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=_utcnow, onupdate=_utcnow)
