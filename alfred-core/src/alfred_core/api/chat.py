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

import asyncio
from dataclasses import dataclass
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
from alfred_core.llm.base import ChatImage, ChatMessage
from alfred_core.memory import extract_and_strip, recent_facts, save_facts
from alfred_core.memory_archive import (
    MemoryHit,
    extract_remember_conversation,
    format_notes_for_prompt,
    rollup_if_pressured,
    search_relevant_notes,
    summarise_and_persist_conversation,
)
from alfred_core.persona import ContextBundle, Mode, build_persona
from alfred_core.router import Router, VisionUnavailableError
from alfred_core.tools.email import EmailError, send_email
from alfred_core.tools.email_marker import EmailDraft, extract_drafts, replace_marker
from alfred_core.tools.images import (
    ImagePayload,
    ImageValidationError,
    validate_images,
)
from alfred_core.tools.search_marker import (
    SearchInvocation,
    extract_invocations,
    strip_markers,
)
from alfred_core.tools.spotify import (
    SpotifyClient,
    SpotifyError,
    SpotifyNotLinkedError,
    SpotifyUnconfiguredError,
)
from alfred_core.tools.spotify_marker import (
    SpotifyAction,
    SpotifyInvocation,
)
from alfred_core.tools.spotify_marker import (
    extract_invocations as extract_spotify_invocations,
)
from alfred_core.tools.spotify_marker import (
    replace_marker as replace_spotify_marker,
)
from alfred_core.tools.web_search import (
    SearchResult,
    WebSearchError,
    WebSearchUnconfiguredError,
    format_for_prompt,
    web_search,
)
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


class PresenceSignal(BaseModel):
    """Live camera-presence snapshot taken at send-time.

    Sent only when the user has the camera toggle on; otherwise the
    field is omitted entirely so Alfred doesn't speak as if he can
    "see" when he can't.
    """

    faces_visible: int


class ChatRequest(BaseModel):
    message: str
    conversation_id: UUID | None = None
    images: list[ImagePayload] = []
    presence: PresenceSignal | None = None


class ImageOut(BaseModel):
    """Image as returned to the client.

    We keep the same shape as the inbound payload (base64 bytes + mime
    type) so the React side can render thumbnails directly from the
    field — no extra fetch round-trip and no static-file plumbing.
    """

    data: str
    mime_type: str


class SourceOut(BaseModel):
    """A single web result Alfred consulted while answering this turn.

    Surfaced in the UI as a small "sources" footer beneath the
    message so the user can verify what Alfred actually read.
    """

    title: str
    url: str
    # Snippet is intentionally short — the UI shows a compact line, not
    # the full body of each page.
    snippet: str


class ChatMessageOut(BaseModel):
    id: UUID
    role: str
    content: str
    backend: str | None = None
    model: str | None = None
    images: list[ImageOut] = []
    sources: list[SourceOut] = []


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

    # New conversations always start in Standard mode. Nightfall is
    # activated per-conversation via the wake phrase.
    convo = Conversation(mode=Mode.STANDARD.value)
    session.add(convo)
    await session.flush()
    return convo


def _derive_title(user_text: str) -> str:
    """First sentence (or first ~80 chars) of the user's first message."""
    text = user_text.strip().replace("\n", " ")
    # Find the EARLIEST sentence-ending punctuation across all types,
    # not whichever type we happen to check first.
    best_idx = len(text)
    for stop in (". ", "? ", "! "):
        # Start at index 1 so a sentence-ender at position 0 (which would
        # yield an empty or 1-char title) is skipped without hiding a
        # valid ender that appears later in the same text.
        idx = text.find(stop, 1)
        if 0 < idx < best_idx:
            best_idx = idx
    if best_idx < 80:
        text = text[: best_idx + 1]
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


def _build_memory_query(history: list[Message], user_text: str) -> str:
    """Build the text we use to vector-search the memory archive.

    The user's current message plus the last few user turns gives a
    much better retrieval signal than the bare incoming message alone
    — pronouns and partial phrasing land their referents in the recent
    context.
    """
    recent_user_turns: list[str] = []
    for m in reversed(history):
        if m.role != "user":
            continue
        body = (m.content or "").strip()
        if body:
            recent_user_turns.append(body)
        if len(recent_user_turns) >= 3:
            break
    parts: list[str] = list(reversed(recent_user_turns))
    if user_text.strip():
        parts.append(user_text.strip())
    return "\n".join(parts).strip()


async def _process_email_drafts(reply: str, settings: Settings) -> str:
    """Send each [SEND_EMAIL] block and inline a confirmation in its place.

    SMTP is blocking I/O. We hand each send to a worker thread so the
    event loop stays free for other requests. Sends are sequential
    rather than gathered — if the user dictated multiple emails in one
    turn they should fail loudly one at a time, not silently in
    parallel.
    """
    drafts = extract_drafts(reply)
    if not drafts:
        return reply
    for draft in drafts:
        confirmation = await asyncio.to_thread(_send_one, draft, settings)
        reply = replace_marker(reply, draft, confirmation)
    return reply


def _send_one(draft: EmailDraft, settings: Settings) -> str:
    try:
        result = send_email(
            to=draft.to,
            subject=draft.subject,
            body=draft.body,
            settings=settings,
        )
    except EmailError as exc:
        return f"_(I couldn't send that email — {exc})_"
    return f"_(Email sent to {result.to} — subject: \"{result.subject}\")_"


# Hard cap on tool-use iterations per turn. Two is generous: one
# initial reply with a [SEARCH:] marker, one re-prompt with results
# yielding the final answer. We stop after that even if the model
# keeps emitting markers — running away from a search loop is far
# worse than telling the user we couldn't find something.
_MAX_SEARCH_ITERATIONS = 2


@dataclass
class _SearchLoopOutcome:
    """Result of the LLM ↔ search loop for a single chat turn."""

    visible_reply: str
    backend: str | None
    model: str | None
    sources: list[SearchResult]
    # Facts harvested from ``[REMEMBER: ...]`` markers across **every**
    # turn the model produced this round, not just the last one. If
    # an intermediate tool-call reply contained a fact (e.g. the user
    # said "I'm switching to Swift, what's the latest version?" and
    # the model emitted both [REMEMBER: ...] and [SEARCH: ...]), it
    # would otherwise be silently dropped because the chat handler
    # only strips the final reply.
    collected_facts: list[str]


async def _run_search_loop(
    msgs: list[ChatMessage],
    settings: Settings,
) -> _SearchLoopOutcome:
    """Drive the LLM ↔ search-tool loop until we have a final reply.

    Returns the final visible reply (with ``[SEARCH:]`` markers
    stripped), the backend/model that produced it, the deduplicated
    list of results we consulted along the way (for the UI's
    "sources" footer), and any ``[REMEMBER:]`` facts harvested from
    intermediate replies.
    """
    collected_sources: list[SearchResult] = []
    collected_facts: list[str] = []
    seen_urls: set[str] = set()
    iteration = 0
    final_text = ""
    final_backend: str | None = None
    final_model: str | None = None

    while True:
        reply = await _llm_router.complete(msgs)
        final_text = reply.content
        final_backend = reply.backend
        final_model = reply.model

        invocations = extract_invocations(reply.content)
        if not invocations or iteration >= _MAX_SEARCH_ITERATIONS:
            break

        # Cap to one search per iteration even if the model emitted
        # several markers in the same turn — otherwise a model that
        # fires off five queries in one shot can chew through the
        # monthly Tavily quota in a single message.
        invocation = invocations[0]
        try:
            results = await web_search(invocation.query, settings)
        except WebSearchUnconfiguredError as exc:
            results = _synthetic_unconfigured_results(invocation, exc)
        except WebSearchError as exc:
            results = _synthetic_error_results(invocation, exc)

        for r in results:
            # Deduplicate by URL across multiple searches in the same
            # turn so the UI doesn't show the same page twice.
            key = r.url or f"{r.title}:{r.snippet[:40]}"
            if key in seen_urls:
                continue
            seen_urls.add(key)
            collected_sources.append(r)

        # Strip both [REMEMBER:] and [SEARCH:] markers before feeding
        # the intermediate reply back into the conversation. The
        # remember-extraction protects facts that would otherwise be
        # lost (the chat handler only strips the *final* reply); the
        # search-marker strip keeps the model from re-running the
        # same query when it sees its own past output.
        intermediate_clean, intermediate_facts = extract_and_strip(reply.content)
        collected_facts.extend(intermediate_facts)
        intermediate_clean = strip_markers(intermediate_clean)

        # Append the model's (cleaned) tool-call turn so its own
        # conversation history makes sense to it on the follow-up,
        # then append the synthetic results as a user-role turn so
        # the model sees them as new input rather than its own
        # thinking.
        msgs.append(ChatMessage(role="assistant", content=intermediate_clean))
        msgs.append(
            ChatMessage(
                role="user",
                content=format_for_prompt(invocation.query, results),
            )
        )
        iteration += 1

    return _SearchLoopOutcome(
        visible_reply=strip_markers(final_text),
        backend=final_backend,
        model=final_model,
        sources=collected_sources,
        collected_facts=collected_facts,
    )


def _synthetic_unconfigured_results(
    invocation: SearchInvocation,
    exc: WebSearchUnconfiguredError,
) -> list[SearchResult]:
    """Build a single 'tool unavailable' result the model can read.

    We turn the misconfiguration into a tool result rather than
    throwing, so Alfred can compose a graceful 'I'd love to look that
    up but search isn't wired up yet' reply instead of the chat 503ing.
    """
    return [
        SearchResult(
            title="Search unavailable",
            url="",
            snippet=str(exc),
        )
    ]


def _synthetic_error_results(
    invocation: SearchInvocation,
    exc: WebSearchError,
) -> list[SearchResult]:
    """Same idea for transient errors (network, 5xx, etc.)."""
    return [
        SearchResult(
            title="Search failed",
            url="",
            snippet=(
                f"The search service couldn't be reached for "
                f"{invocation.query!r}: {exc}. Tell him plainly that "
                f"you tried but couldn't reach the web; offer to retry."
            ),
        )
    ]


async def _build_context(
    settings: Settings,
    session: AsyncSession,
    presence: PresenceSignal | None = None,
) -> ContextBundle:
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

    spotify_linked = False
    if settings.has_spotify:
        # Single round-trip to ``spotify_accounts`` per turn. Cheap
        # and guarantees the persona prompt stays accurate the
        # moment after the user disconnects.
        try:
            status_info = await SpotifyClient(session, settings).get_status()
            spotify_linked = status_info.linked
        except Exception:
            # An error here just means we omit the music tool from
            # the prompt — we don't want a flaky DB query to 500 the
            # whole chat turn.
            spotify_linked = False

    return ContextBundle(
        now_local=now_local,
        timezone_label=settings.alfred_timezone,
        weather_summary=weather_summary,
        known_facts=known_facts,
        faces_visible=presence.faces_visible if presence is not None else None,
        spotify_linked=spotify_linked,
    )


async def _process_spotify_invocations(
    reply: str,
    session: AsyncSession,
    settings: Settings,
) -> str:
    """Execute each ``[SPOTIFY_…]`` marker and inline a confirmation.

    Mirrors the email-draft pipeline: actions run sequentially (so a
    flaky one fails loudly rather than racing with a successful
    sibling), and each marker is swapped for a short human-readable
    line. Errors are folded into the visible reply so Alfred can
    apologise rather than 500ing.
    """
    invocations = extract_spotify_invocations(reply)
    if not invocations:
        return reply
    if not settings.has_spotify:
        # The persona shouldn't have given the LLM the music tool
        # without server-side config, but be defensive in case the
        # model picked up the marker pattern from somewhere else.
        for inv in invocations:
            reply = replace_spotify_marker(
                reply,
                inv,
                "_(I can't control music yet — Spotify isn't configured on the server.)_",
            )
        return reply
    client = SpotifyClient(session, settings)
    for inv in invocations:
        confirmation = await _run_spotify_action(client, inv)
        reply = replace_spotify_marker(reply, inv, confirmation)
    return reply


async def _run_spotify_action(
    client: SpotifyClient, inv: SpotifyInvocation
) -> str:
    """Run a single Spotify action and return its inline confirmation."""
    try:
        if inv.action is SpotifyAction.PLAY:
            uri = await client.search_track(inv.query)
            if uri is None:
                return f"_(I couldn't find anything matching {inv.query!r} on Spotify.)_"
            await client.play(uris=[uri])
            return f"_(Now playing: {inv.query})_"
        if inv.action is SpotifyAction.RESUME:
            await client.play()
            return "_(Resumed playback.)_"
        if inv.action is SpotifyAction.PAUSE:
            await client.pause()
            return "_(Paused.)_"
        if inv.action is SpotifyAction.NEXT:
            await client.next_track()
            return "_(Skipped to the next track.)_"
        if inv.action is SpotifyAction.PREV:
            await client.previous_track()
            return "_(Skipped back.)_"
        if inv.action is SpotifyAction.NOW:
            track = await client.now_playing()
            if track is None:
                return "_(Spotify isn't playing anything right now.)_"
            state = "playing" if track.is_playing else "paused on"
            return (
                f"_(Currently {state}: {track.title} — {track.artists})_"
            )
    except SpotifyNotLinkedError as exc:
        return f"_(I couldn't reach Spotify — {exc})_"
    except SpotifyUnconfiguredError as exc:
        return f"_(I couldn't reach Spotify — {exc})_"
    except SpotifyError as exc:
        return f"_(Spotify wasn't happy about that: {exc})_"
    return "_(Unknown Spotify command.)_"


@router.post("", response_model=ChatReply)
async def chat(req: ChatRequest, session: AsyncSession = Depends(get_session)) -> ChatReply:
    settings = get_settings()
    user_text = req.message.strip()
    if not user_text and not req.images:
        # An empty message with no image is genuinely empty; an empty
        # message *with* images is fine ("describe this") and we let
        # the model handle it.
        raise HTTPException(status_code=400, detail="Message is empty.")

    try:
        validated_images: list[ChatImage] = validate_images(req.images)
    except ImageValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    convo = await _load_or_create(session, req.conversation_id)

    # Per-conversation mode: use whatever mode this conversation was
    # last in. Each conversation owns its own mode, so switching between
    # conversations in the sidebar does not leak state between them.
    try:
        current_mode = Mode(convo.mode)
    except ValueError:
        current_mode = Mode.STANDARD

    wake = analyze(user_text)
    mode_changed = False
    if wake.mode_change is not None and wake.mode_change is not current_mode:
        current_mode = wake.mode_change
        mode_changed = True

    context = await _build_context(settings, session, req.presence)
    persona = build_persona(current_mode, settings, context)

    history = await _history(session, convo.id)

    # Token-pressure: if the conversation has grown past the configured
    # threshold, summarise the oldest half into a long-term memory note
    # and trim the active window. The note stays retrievable below.
    history = await rollup_if_pressured(
        session=session,
        settings=settings,
        llm_router=_llm_router,
        conversation_id=convo.id,
        history=history,
    )

    # Long-term memory retrieval — semantic search over past memory notes
    # for anything relevant to the current user message + recent context.
    # The hits are appended to the system prompt so Alfred can recall
    # past conversations without us shipping the full transcripts every
    # turn.
    memory_query = _build_memory_query(history, user_text)
    memory_hits: list[MemoryHit] = await search_relevant_notes(
        session, settings=settings, query_text=memory_query
    )
    system_prompt = persona.system_prompt + format_notes_for_prompt(memory_hits)

    msgs: list[ChatMessage] = [ChatMessage(role="system", content=system_prompt)]
    for m in history:
        if m.role in ("user", "assistant"):
            msgs.append(ChatMessage(role=m.role, content=m.content))
    # Only attach images to the *current* user turn — re-shipping every
    # past image on every subsequent turn would balloon request size and
    # bills. The assistant's text reply has already absorbed whatever it
    # needed from earlier images.
    msgs.append(
        ChatMessage(role="user", content=user_text, images=validated_images)
    )

    is_first_message = len(history) == 0
    user_message_metadata: dict[str, object] | None = None
    if validated_images:
        user_message_metadata = {
            "images": [
                {"data": img.data, "mime_type": img.mime_type}
                for img in validated_images
            ]
        }
    session.add(
        Message(
            conversation_id=convo.id,
            role="user",
            content=user_text,
            metadata_json=user_message_metadata,
        )
    )
    if is_first_message:
        convo.title = _derive_title(user_text) if user_text else "New conversation"

    try:
        outcome = await _run_search_loop(msgs, settings)
    except VisionUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                f"LLM backend failed: {exc}. "
                "If this is your first run, make sure Ollama is running and the "
                "model in LOCAL_MODEL_CHAT has been pulled."
            ),
        ) from exc

    visible_reply, final_facts = extract_and_strip(outcome.visible_reply)
    # Merge facts from intermediate search-loop turns (collected during
    # the loop) with facts from the final reply. Without this, any
    # [REMEMBER: ...] the model emitted alongside a [SEARCH: ...] in
    # the same turn would be silently dropped.
    new_facts = outcome.collected_facts + final_facts
    if new_facts:
        await save_facts(session, new_facts)

    # ``[REMEMBER_CONVERSATION]`` marker — explicit user-or-Alfred
    # request to commit the active conversation to long-term memory.
    # Strip the marker out of the visible reply, and surface a short
    # confirmation in its place so the user knows it was archived.
    visible_reply, conversation_titles = extract_remember_conversation(
        visible_reply
    )
    if conversation_titles:
        suggested_title = next(
            (t for t in conversation_titles if t), None
        )
        archived = await summarise_and_persist_conversation(
            session=session,
            settings=settings,
            llm_router=_llm_router,
            conversation_id=convo.id,
            suggested_title=suggested_title,
        )
        if archived is not None:
            confirmation = (
                f"\n\n_(Archived this conversation to memory: "
                f"{archived.title}.)_"
            )
            visible_reply = (visible_reply + confirmation).strip()

    visible_reply = await _process_email_drafts(visible_reply, settings)
    visible_reply = await _process_spotify_invocations(
        visible_reply, session, settings
    )

    # Persist any sources Alfred consulted in the message metadata so
    # they survive a page reload — the chat history endpoint lifts
    # them back out into the same `sources` field on each turn.
    assistant_metadata: dict[str, object] | None = None
    if outcome.sources:
        assistant_metadata = {
            "sources": [
                {"title": r.title, "url": r.url, "snippet": r.snippet}
                for r in outcome.sources
            ]
        }

    assistant_msg = Message(
        conversation_id=convo.id,
        role="assistant",
        content=visible_reply,
        backend=outcome.backend,
        model=outcome.model,
        metadata_json=assistant_metadata,
    )
    session.add(assistant_msg)

    convo.mode = current_mode.value
    await session.commit()
    await session.refresh(assistant_msg)

    return ChatReply(
        conversation_id=convo.id,
        mode=current_mode,
        mode_changed=mode_changed,
        assistant=ChatMessageOut(
            id=assistant_msg.id,
            role=assistant_msg.role,
            content=assistant_msg.content,
            backend=assistant_msg.backend,
            model=assistant_msg.model,
            sources=[
                SourceOut(title=r.title, url=r.url, snippet=r.snippet)
                for r in outcome.sources
            ],
        ),
    )
