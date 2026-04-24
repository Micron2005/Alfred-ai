"""SQLAlchemy models for Alfred's memory, conversations, and feedback.

pgvector support is wired up but not yet used — it arrives properly in
Phase 5 when we add long-term memory.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


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
