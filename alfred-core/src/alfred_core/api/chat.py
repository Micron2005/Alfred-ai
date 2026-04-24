"""Chat endpoint: the main loop.

Flow for each user message:
1. Parse wake/mode phrases (activate / deactivate Nightfall Protocol).
2. Build a ContextBundle (current time, weather, known facts about the user).
3. Build the current persona's system prompt with that context baked in.
4. Load conversation history from Postgres.
5. Call the router to pick a backend (local vs Claude for coding).
6. Extract any ``[REMEMBER: ...]`` markers from the reply, persist them as
   facts, and strip them from the visible reply.
7. Persist the user + assistant messages.
8. Return the assistant's reply plus the current mode.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.config import Settings, get_settings
from alfred_core.db.models import Conversation, Message
from alfred_core.db.session import get_session
from alfred_core.llm.base import ChatMessage
from alfred_core.memory import extract_and_strip, recent_facts, save_facts
from alfred_core.persona import ContextBundle, Mode, build_persona
from alfred_core.router import Router
from alfred_core.state import mode_state
from alfred_core.wake import analyze
from alfred_core.weather import WeatherService

router = APIRouter(prefix="/chat", tags=["chat"])

_settings = get_settings()
_llm_router = Router.from_settings(_settings)
_weather = WeatherService(
    latitude=_settings.alfred_location_latitude,
    longitude=_settings.alfred_location_longitude,
    city_label=_settings.alfred_location_city,
)


class ChatRequest(BaseModel):
    message: str
    conversation_id: UUID | None = None


class ChatMessageOut(BaseModel):
    id: UUID
    role: str
    content: str
    backend: str | None = None
    model: str | None = None


class ChatReply(BaseModel):
    conversation_id: UUID
    mode: Mode
    mode_changed: bool
    assistant: ChatMessageOut


async def _load_or_create(session: AsyncSession, cid: UUID | None) -> Conversation:
    if cid is not None:
        existing = await session.get(Conversation, cid)
        if existing is None:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        return existing

    convo = Conversation(mode=mode_state.mode.value)
    session.add(convo)
    await session.flush()
    return convo


def _derive_title(user_text: str) -> str:
    """First sentence (or first ~60 chars) of the user's first message."""
    text = user_text.strip().replace("\n", " ")
    # Stop at the first sentence-ending punctuation if there is one.
    for stop in (". ", "? ", "! "):
        idx = text.find(stop)
        if 0 < idx < 80:
            text = text[: idx + 1]
            break
    if len(text) > 80:
        text = text[:77].rstrip() + "…"
    return text or "New conversation"


async def _history(session: AsyncSession, conversation_id: UUID) -> list[Message]:
    result = await session.execute(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
    )
    return list(result.scalars().all())


async def _build_context(settings: Settings, session: AsyncSession) -> ContextBundle:
    try:
        tz = ZoneInfo(settings.alfred_timezone)
    except ZoneInfoNotFoundError:
        tz = ZoneInfo("UTC")
    now_local = datetime.now(tz)

    weather_summary = ""
    snapshot = await _weather.get()
    if snapshot is not None:
        weather_summary = snapshot.summary()

    facts = await recent_facts(session)
    known_facts = tuple(f.content for f in facts)

    return ContextBundle(
        now_local=now_local,
        timezone_label=settings.alfred_timezone,
        weather_summary=weather_summary,
        known_facts=known_facts,
    )


@router.post("", response_model=ChatReply)
async def chat(req: ChatRequest, session: AsyncSession = Depends(get_session)) -> ChatReply:
    settings = get_settings()
    user_text = req.message.strip()
    if not user_text:
        raise HTTPException(status_code=400, detail="Message is empty.")

    wake = analyze(user_text)
    mode_changed = False
    if wake.mode_change is not None and wake.mode_change is not mode_state.mode:
        mode_state.set(wake.mode_change)
        mode_changed = True

    context = await _build_context(settings, session)
    persona = build_persona(mode_state.mode, settings, context)

    convo = await _load_or_create(session, req.conversation_id)

    history = await _history(session, convo.id)
    msgs: list[ChatMessage] = [ChatMessage(role="system", content=persona.system_prompt)]
    for m in history:
        if m.role == "user":
            msgs.append(ChatMessage(role="user", content=m.content))
        elif m.role == "assistant":
            msgs.append(ChatMessage(role="assistant", content=m.content))
    msgs.append(ChatMessage(role="user", content=user_text))

    session.add(
        Message(conversation_id=convo.id, role="user", content=user_text)
    )
    if convo.title == "New conversation":
        convo.title = _derive_title(user_text)

    try:
        reply = await _llm_router.complete(msgs)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                f"LLM backend failed: {exc}. "
                "If this is your first run, make sure Ollama is running and the "
                "model in LOCAL_MODEL_CHAT has been pulled."
            ),
        ) from exc

    visible_reply, new_facts = extract_and_strip(reply.content)
    if new_facts:
        await save_facts(session, new_facts)

    assistant_msg = Message(
        conversation_id=convo.id,
        role="assistant",
        content=visible_reply,
        backend=reply.backend,
        model=reply.model,
    )
    session.add(assistant_msg)

    convo.mode = mode_state.mode.value
    await session.commit()
    await session.refresh(assistant_msg)

    return ChatReply(
        conversation_id=convo.id,
        mode=mode_state.mode,
        mode_changed=mode_changed,
        assistant=ChatMessageOut(
            id=assistant_msg.id,
            role=assistant_msg.role,
            content=assistant_msg.content,
            backend=assistant_msg.backend,
            model=assistant_msg.model,
        ),
    )
