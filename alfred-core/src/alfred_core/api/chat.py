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
import base64
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
from alfred_core.router import LLMUnavailableError, Router, VisionUnavailableError
from alfred_core.tools.email import EmailError, send_email
from alfred_core.tools.email_marker import EmailDraft, extract_drafts, replace_marker
from alfred_core.tools.history_scrub import scrub_assistant_content
from alfred_core.tools.image_gen import (
    GeneratedImage,
    ImageGenError,
    generate_image,
)
from alfred_core.tools.image_marker import (
    extract_requests as extract_image_requests,
)
from alfred_core.tools.image_marker import (
    replace_marker as replace_image_marker,
)
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
from alfred_core.tools.sketch_marker import (
    MAX_BRUSH,
    MIN_BRUSH,
    VALID_TOOLS,
    SketchAction,
    SketchInvocation,
)
from alfred_core.tools.sketch_marker import (
    confirmation_for as sketch_confirmation_for,
)
from alfred_core.tools.sketch_marker import (
    extract_invocations as extract_sketch_invocations,
)
from alfred_core.tools.sketch_marker import (
    replace_marker as replace_sketch_marker,
)
from alfred_core.tools.sketch_marker import (
    strip_markers as strip_sketch_markers,
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


class SketchLayerSignal(BaseModel):
    """One layer of the design pad, as reported by the client."""

    name: str
    visible: bool = True
    active: bool = False


class SketchSignal(BaseModel):
    """Live design-pad state snapshot taken at send-time.

    Sent only while the user has the design pad open; otherwise the
    field is omitted entirely so Alfred doesn't speak as if he can
    see a sketch when there isn't one.
    """

    open: bool = False
    tool: str = "pen"
    color: str = "#6cd6ff"
    brush_size: float = 6
    # Top-first, matching the UI's layers panel.
    layers: list[SketchLayerSignal] = []
    # Flattened PNG of the visible layers, used when the model emits
    # ``[SKETCH_ANALYZE]``. Optional — an empty pad sends one anyway
    # (Alfred will simply observe that it's blank).
    snapshot: ImagePayload | None = None


class SketchCommandOut(BaseModel):
    """One design-pad command for the frontend to execute.

    ``action`` is a ``SketchAction`` value ("open", "tool",
    "layer_add", …); ``value`` is its argument where applicable
    (tool name, colour, layer name, brush size as a string).
    """

    action: str
    value: str = ""


class ChatRequest(BaseModel):
    message: str
    conversation_id: UUID | None = None
    images: list[ImagePayload] = []
    presence: PresenceSignal | None = None
    sketch: SketchSignal | None = None


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
    # Design-pad commands parsed from the assistant's reply, in marker
    # order. The frontend applies them to the canvas after rendering
    # the message. Empty for ordinary turns.
    sketch_commands: list[SketchCommandOut] = []


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
    # Whether a ``[SKETCH_ANALYZE]`` marker was honoured this round
    # (the model was re-prompted with the pad snapshot). The chat
    # handler uses this to decide how to replace any stray analyze
    # marker left in the final reply.
    sketch_analyzed: bool
    # Non-analyze sketch invocations harvested from INTERMEDIATE
    # replies (e.g. the model emitted [SKETCH_TOOL: pen] alongside
    # [SKETCH_ANALYZE] in the same turn). Stripping them from the
    # history would otherwise silently drop the command.
    collected_sketch_invocations: list[SketchInvocation]


async def _run_search_loop(
    msgs: list[ChatMessage],
    settings: Settings,
    sketch_snapshot: ChatImage | None = None,
) -> _SearchLoopOutcome:
    """Drive the LLM ↔ tool loop until we have a final reply.

    Handles two re-prompt tools: ``[SEARCH:]`` (web results fed back
    as a synthetic user turn) and ``[SKETCH_ANALYZE]`` (the design-pad
    snapshot fed back as an image-bearing user turn, which the router
    sends to the vision backend). Returns the final visible reply
    (with ``[SEARCH:]`` markers stripped), the backend/model that
    produced it, the deduplicated list of results we consulted along
    the way (for the UI's "sources" footer), and any ``[REMEMBER:]``
    facts harvested from intermediate replies.
    """
    collected_sources: list[SearchResult] = []
    collected_facts: list[str] = []
    collected_sketch_invocations: list[SketchInvocation] = []
    seen_urls: set[str] = set()
    iteration = 0
    sketch_analyzed = False
    final_text = ""
    final_backend: str | None = None
    final_model: str | None = None

    while True:
        reply = await _llm_router.complete(msgs)
        final_text = reply.content
        final_backend = reply.backend
        final_model = reply.model

        invocations = extract_invocations(reply.content)
        sketch_invocations = extract_sketch_invocations(reply.content)
        wants_sketch_analysis = (
            sketch_snapshot is not None
            and not sketch_analyzed
            and any(
                inv.action is SketchAction.ANALYZE
                for inv in sketch_invocations
            )
        )
        if (
            not invocations and not wants_sketch_analysis
        ) or iteration >= _MAX_SEARCH_ITERATIONS:
            break

        # Strip [REMEMBER:], [SEARCH:], and [SKETCH_…] markers before
        # feeding the intermediate reply back into the conversation.
        # The remember-extraction protects facts that would otherwise
        # be lost (the chat handler only strips the *final* reply);
        # the marker strips keep the model from re-running the same
        # tool when it sees its own past output. Non-analyze sketch
        # commands are collected so they still reach the frontend
        # even though their markers vanish from the final reply.
        intermediate_clean, intermediate_facts = extract_and_strip(reply.content)
        collected_facts.extend(intermediate_facts)
        intermediate_clean = strip_markers(intermediate_clean)
        intermediate_clean = strip_sketch_markers(intermediate_clean)
        collected_sketch_invocations.extend(
            inv
            for inv in sketch_invocations
            if inv.action is not SketchAction.ANALYZE
        )

        if wants_sketch_analysis:
            # Re-prompt with the pad snapshot. The image on the
            # synthetic user turn routes the follow-up completion to
            # the vision backend automatically.
            sketch_analyzed = True
            msgs.append(
                ChatMessage(
                    role="assistant",
                    content=intermediate_clean
                    or "Let me have a look at the pad.",
                )
            )
            assert sketch_snapshot is not None
            msgs.append(
                ChatMessage(
                    role="user",
                    content=(
                        "[DESIGN PAD SNAPSHOT] This is the current state "
                        "of the design pad on my screen. Look at it and "
                        "answer my last request about the sketch — "
                        "describe and critique what is actually drawn, "
                        "not what you imagine."
                    ),
                    images=[sketch_snapshot],
                )
            )
            iteration += 1
            continue

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
        sketch_analyzed=sketch_analyzed,
        collected_sketch_invocations=collected_sketch_invocations,
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


def _sketch_summary(sketch: SketchSignal | None) -> str:
    """One-line description of the open design pad for the persona.

    Empty string when the pad is closed (or no signal was sent) —
    the persona then says nothing about it and Alfred treats the pad
    as closed.
    """
    if sketch is None or not sketch.open:
        return ""
    layer_bits: list[str] = []
    for layer in sketch.layers:
        flags = []
        if layer.active:
            flags.append("active")
        flags.append("visible" if layer.visible else "hidden")
        layer_bits.append(f"\u201c{layer.name}\u201d ({', '.join(flags)})")
    layers_part = "; ".join(layer_bits) if layer_bits else "none yet"
    return (
        f"Active tool: {sketch.tool}, colour {sketch.color}, "
        f"brush size {sketch.brush_size:g}. "
        f"Layers (top first): {layers_part}."
    )


def _process_sketch_markers(
    reply: str,
    *,
    analyzed: bool,
    carried_invocations: list[SketchInvocation],
) -> tuple[str, list[SketchCommandOut]]:
    """Turn ``[SKETCH_…]`` markers into frontend commands + confirmations.

    Each actionable marker in the final reply is swapped for a short
    ``_( ... )_`` confirmation and added to the command list the
    frontend executes. Invalid arguments (unknown tool, unparsable
    brush size) become polite refusals with no command. ``ANALYZE``
    markers are special: if the loop already honoured one, any stray
    copy is silently removed (the analysis IS the reply); if it
    couldn't be honoured (pad closed / no snapshot), it becomes an
    explanatory line instead.

    ``carried_invocations`` are non-analyze commands harvested from
    intermediate loop replies — they produce commands but no inline
    confirmation (their markers are no longer in the visible text).
    """
    commands: list[SketchCommandOut] = []

    def _to_command(inv: SketchInvocation) -> tuple[SketchCommandOut | None, str]:
        """Validate one invocation → (command | None, replacement text)."""
        if inv.action is SketchAction.TOOL:
            tool = inv.value.strip().lower()
            if tool not in VALID_TOOLS:
                return None, (
                    f"_(No tool called {inv.value!r} — I have pencil, "
                    f"pen, marker, and eraser.)_"
                )
            normalised = SketchInvocation(
                action=inv.action, value=tool, raw_match=inv.raw_match
            )
            return (
                SketchCommandOut(action=inv.action.value, value=tool),
                sketch_confirmation_for(normalised),
            )
        if inv.action is SketchAction.BRUSH:
            try:
                size = float(inv.value)
            except ValueError:
                return None, (
                    f"_(I couldn't make sense of brush size "
                    f"{inv.value!r}.)_"
                )
            clamped = max(MIN_BRUSH, min(MAX_BRUSH, size))
            value = f"{clamped:g}"
            normalised = SketchInvocation(
                action=inv.action, value=value, raw_match=inv.raw_match
            )
            return (
                SketchCommandOut(action=inv.action.value, value=value),
                sketch_confirmation_for(normalised),
            )
        return (
            SketchCommandOut(action=inv.action.value, value=inv.value),
            sketch_confirmation_for(inv),
        )

    for inv in extract_sketch_invocations(reply):
        if inv.action is SketchAction.ANALYZE:
            replacement = (
                ""
                if analyzed
                else (
                    "_(I can't see the design pad right now — open it "
                    "and put something on it first.)_"
                )
            )
            reply = replace_sketch_marker(reply, inv, replacement)
            continue
        command, replacement = _to_command(inv)
        if command is not None:
            commands.append(command)
        reply = replace_sketch_marker(reply, inv, replacement)

    # Commands rescued from intermediate replies run FIRST — they were
    # emitted before the final reply's markers chronologically.
    carried_commands: list[SketchCommandOut] = []
    for inv in carried_invocations:
        if inv.action is SketchAction.ANALYZE:
            continue
        command, _replacement = _to_command(inv)
        if command is not None:
            carried_commands.append(command)

    return reply.strip(), carried_commands + commands


async def _build_context(
    settings: Settings,
    session: AsyncSession,
    presence: PresenceSignal | None = None,
    sketch: SketchSignal | None = None,
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
        sketch_summary=_sketch_summary(sketch),
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


# Hard cap on how many ``[GENERATE_IMAGE]`` markers we'll honour per
# turn. Each one is a 5-30 s round-trip to the free Pollinations
# service, and a runaway prompt loop emitting a dozen markers would
# block the chat for minutes. Two is plenty for the genuine
# "compare these two ideas" / "and another variation" flow; any
# extras get a polite refusal in their place.
_MAX_IMAGES_PER_TURN = 2


async def _process_image_requests(
    reply: str,
) -> tuple[str, list[GeneratedImage]]:
    """Generate each ``[GENERATE_IMAGE]`` request and inline a confirmation.

    Returns the modified visible reply plus the list of successfully
    generated images, in marker order. The chat handler attaches the
    images to the assistant message's ``metadata_json`` so they
    survive page reload, and includes them in the ``ChatReply`` so
    the UI can render them on the new turn without an extra fetch.

    Failures are folded into the reply (Alfred apologises in-line
    rather than the chat 500ing) and the corresponding image is
    omitted from the returned list.
    """

    requests = extract_image_requests(reply)
    if not requests:
        return reply, []

    generated: list[GeneratedImage] = []
    honoured = 0
    for req in requests:
        if honoured >= _MAX_IMAGES_PER_TURN:
            reply = replace_image_marker(
                reply,
                req,
                (
                    "_(I drew the first couple, sir, but skipped the "
                    "rest — let's not flood the page.)_"
                ),
            )
            continue
        try:
            image = await generate_image(req.prompt)
        except ImageGenError as exc:
            reply = replace_image_marker(
                reply,
                req,
                f"_(I couldn't draw that — {exc})_",
            )
            continue
        generated.append(image)
        # Visible confirmation; the bytes themselves render above the
        # text bubble via the message-images pipeline. Keep the line
        # short — the image speaks for itself.
        reply = replace_image_marker(
            reply,
            req,
            "_(Generated.)_",
        )
        honoured += 1

    return reply, generated


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

    # Design-pad snapshot — validated through the same pipeline as user
    # attachments, but a bad snapshot is treated as absent rather than
    # failing the whole turn (the user's message still deserves a
    # reply even if the canvas export glitched).
    sketch_snapshot: ChatImage | None = None
    if req.sketch is not None and req.sketch.snapshot is not None:
        try:
            sketch_snapshot = validate_images([req.sketch.snapshot])[0]
        except ImageValidationError:
            sketch_snapshot = None

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

    context = await _build_context(settings, session, req.presence, req.sketch)
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
            content = m.content
            # Strip user-facing tool-status placeholders ( ``_( ... )_``
            # confirmations from image-gen, email, Spotify, etc.) from
            # past assistant replies so the model doesn't learn to type
            # them as prose on a future turn. See
            # ``alfred_core.tools.history_scrub`` for the rationale —
            # this prevents Alfred from claiming "_(Generated.)_" without
            # actually emitting the [GENERATE_IMAGE] marker.
            if m.role == "assistant":
                content = scrub_assistant_content(content)
            # Anthropic (and most providers) reject empty user/assistant
            # messages outright. The most common case is a past user turn
            # that was image-only (no caption): the stored content is the
            # empty string. We don't re-attach the image — re-shipping
            # every past image every turn would balloon size and bills,
            # and the assistant's earlier reply has already absorbed
            # whatever it needed from it. So substitute a placeholder
            # that preserves alternating-role structure without losing
            # the fact that an image was there. The same defensive
            # fallback handles assistant turns whose entire content
            # was a single tool-status placeholder (now scrubbed away).
            if not content.strip():
                content = (
                    "[image attached]" if m.role == "user" else "[no reply]"
                )
            msgs.append(ChatMessage(role=m.role, content=content))
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
        outcome = await _run_search_loop(
            msgs, settings, sketch_snapshot=sketch_snapshot
        )
    except VisionUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LLMUnavailableError as exc:
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
    visible_reply, generated_images = await _process_image_requests(
        visible_reply
    )
    visible_reply, sketch_commands = _process_sketch_markers(
        visible_reply,
        analyzed=outcome.sketch_analyzed,
        carried_invocations=outcome.collected_sketch_invocations,
    )

    # Persist sources + generated images in the assistant message
    # metadata so they survive a page reload — the chat history
    # endpoint lifts them back out via ``_extract_images`` /
    # ``_extract_sources``.
    assistant_metadata: dict[str, object] | None = None
    metadata_payload: dict[str, object] = {}
    if outcome.sources:
        metadata_payload["sources"] = [
            {"title": r.title, "url": r.url, "snippet": r.snippet}
            for r in outcome.sources
        ]
    encoded_images: list[dict[str, str]] = []
    if generated_images:
        for img in generated_images:
            encoded_images.append(
                {
                    "data": base64.b64encode(img.data).decode("ascii"),
                    "mime_type": img.mime_type,
                }
            )
        metadata_payload["images"] = encoded_images
    if metadata_payload:
        assistant_metadata = metadata_payload

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
        sketch_commands=sketch_commands,
        assistant=ChatMessageOut(
            id=assistant_msg.id,
            role=assistant_msg.role,
            content=assistant_msg.content,
            backend=assistant_msg.backend,
            model=assistant_msg.model,
            images=[
                ImageOut(data=entry["data"], mime_type=entry["mime_type"])
                for entry in encoded_images
            ],
            sources=[
                SourceOut(title=r.title, url=r.url, snippet=r.snippet)
                for r in outcome.sources
            ],
        ),
    )
