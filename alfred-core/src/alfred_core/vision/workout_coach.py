"""LLM-driven workout / form coach.

Takes the current pose snapshot from the browser (joint angles
+ heuristic cues + form score) along with the user's free-form
goal, and produces a coaching reply plus an optional structured
workout plan.

Strategy: prompt the existing LLM router (same one chat uses) so
the user gets the same persona, the same model fallback chain,
and the same per-conversation memory access. We don't run any
local computer-vision ML on the backend — by the time we get the
data here it's already structured.

The optional structured plan is parsed out of a JSON block the
model is instructed to emit. If the model doesn't oblige (older
local models love to chat without structure), we fall back to
returning the prose reply alone.
"""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, Field

from alfred_core.config import Settings
from alfred_core.llm.base import ChatMessage
from alfred_core.router import LLMUnavailableError, Router


class PoseSnapshot(BaseModel):
    """Live pose state the client is sending up for context."""

    exercise: str
    angles: dict[str, float] = Field(default_factory=dict)
    formScore: float  # noqa: N815 — wire-compat with frontend (poseAnalyzer.ts)
    cues: list[dict[str, str]] = Field(default_factory=list)


class CoachExercise(BaseModel):
    name: str
    sets: int | None = None
    reps: str | None = None
    duration_seconds: int | None = None
    notes: str | None = None


class CoachPlan(BaseModel):
    title: str
    duration_minutes: int = 0
    exercises: list[CoachExercise] = Field(default_factory=list)


class CoachResponse(BaseModel):
    reply: str
    plan: CoachPlan | None = None


_SYSTEM_PROMPT = """You are Alfred, a dry, witty British butler with the hidden \
expertise of a strength-and-conditioning coach who has trained both \
mixed martial artists and tactical operators. The user is your \
charge, sir.

When the user asks for help with form or a workout, do this:
1. Read the live pose data they sent (angles, cues, form score) and \
weave any relevant observations into your reply naturally. Do not \
parrot the cue list verbatim — synthesise it into 1-3 specific, \
actionable corrections in your own voice. Keep it concise (3-6 \
sentences for form feedback, longer only if a full workout was \
requested).
2. If they want a workout plan, append (after your prose) a fenced \
JSON block with the structured plan. Use this exact shape:

```json
{
  "title": "...",
  "duration_minutes": 12,
  "exercises": [
    {"name": "Burpees", "sets": 3, "reps": "10"},
    {"name": "Plank", "duration_seconds": 60, "notes": "Tight glutes."}
  ]
}
```

3. If no plan is needed (just form feedback), omit the JSON block \
entirely.

Stay in character — gentle sarcasm fine, but useful coaching first.
"""


def _format_user_prompt(
    goal: str,
    pose: PoseSnapshot | None,
    history: list[str],
) -> str:
    parts: list[str] = []
    parts.append(f"User goal: {goal.strip()}")
    if pose is not None:
        cue_lines = "\n".join(
            f"  - [{c.get('severity', '?')}] {c.get('text', '')}" for c in pose.cues
        )
        angles_summary = ", ".join(
            f"{k} {v:.0f}°" for k, v in pose.angles.items() if isinstance(v, int | float)
        )
        parts.append(
            "Live pose snapshot:\n"
            f"  exercise: {pose.exercise}\n"
            f"  form score: {pose.formScore:.0f}/100\n"
            f"  joint angles: {angles_summary or 'unavailable'}\n"
            f"  heuristic cues:\n{cue_lines or '  (none)'}"
        )
    else:
        parts.append("Live pose snapshot: (camera/pose tracker is off — provide general advice.)")
    if history:
        parts.append(
            "Recent context (last few turns in this session):\n"
            + "\n".join(f"  - {line}" for line in history[-5:])
        )
    return "\n\n".join(parts)


_JSON_BLOCK_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


def _extract_plan(reply: str) -> tuple[str, CoachPlan | None]:
    """Pull a fenced ```json``` block out of the reply if present."""
    match = _JSON_BLOCK_RE.search(reply)
    if not match:
        return reply.strip(), None
    raw = match.group(1)
    try:
        data: Any = json.loads(raw)
        plan = CoachPlan.model_validate(data)
    except (json.JSONDecodeError, ValueError):
        # Leave the block in the reply so the user can see what the
        # model attempted, even if we couldn't parse it.
        return reply.strip(), None
    cleaned = _JSON_BLOCK_RE.sub("", reply).strip()
    return cleaned, plan


async def run_workout_coach(
    *,
    goal: str,
    pose: PoseSnapshot | None,
    history: list[str],
    llm_router: Router,
    settings: Settings,
) -> CoachResponse:
    """Drive the LLM with the current pose + goal and return a structured reply."""
    user_prompt = _format_user_prompt(goal, pose, history)
    msgs: list[ChatMessage] = [
        ChatMessage(role="system", content=_SYSTEM_PROMPT),
        ChatMessage(role="user", content=user_prompt),
    ]
    try:
        completion = await llm_router.complete(msgs)
    except LLMUnavailableError as exc:
        # Surface the exact reason so the user can wire something up
        # without digging through server logs.
        raise RuntimeError(str(exc)) from exc
    reply, plan = _extract_plan(completion.content)
    return CoachResponse(reply=reply, plan=plan)
