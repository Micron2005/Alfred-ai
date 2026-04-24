"""Chat endpoint: the main loop.

Flow for each user message:
1. Parse wake/mode phrases (activate / deactivate Nightfall Protocol).
2. Build the current persona's system prompt.
3. Load conversation history from Postgres.
4. Call the router to pick a backend (local vs Claude for coding).
5. Persist the user + assistant messages.
6. Return the assistant's reply plus the current mode.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.config import get_settings
from alfred_core.db.models import Conversation, Message
from alfred_core.db.session import get_session
from alfred_core.llm.base import ChatMessage
from alfred_core.persona import Mode, build_persona
from alfred_core.router import Router
from alfred_core.state import mode_state
from alfred_core.wake import analyze

router = APIRouter(prefix="/chat", tags=["chat"])

_llm_router = Router.from_settings(get_settings())


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


async def _history(session: AsyncSession, conversation_id: UUID) -> list[Message]:
    result = await session.execute(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
    )
    return list(result.scalars().all())


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

    persona = build_persona(mode_state.mode, settings)

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

    assistant_msg = Message(
        conversation_id=convo.id,
        role="assistant",
        content=reply.content,
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
