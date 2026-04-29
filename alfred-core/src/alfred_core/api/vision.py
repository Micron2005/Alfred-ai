"""Vision endpoints — face recognition + workout coach.

All routes mounted under ``/vision`` so they're easy to firewall
behind Tailscale ACLs if you want to expose less surface to the
public internet.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.config import get_settings
from alfred_core.db.session import get_session
from alfred_core.router import Router
from alfred_core.vision import face_recognition as fr
from alfred_core.vision.workout_coach import (
    CoachResponse,
    PoseSnapshot,
    run_workout_coach,
)

router = APIRouter(prefix="/vision", tags=["vision"])


# ─── Face recognition ──────────────────────────────────────────────────


class EnrollRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    identity_vector: list[float]
    notes: str | None = None


class IdentifyRequest(BaseModel):
    identity_vector: list[float]
    threshold: float | None = None


class EnrollmentListOut(BaseModel):
    enrollments: list[fr.EnrollmentOut]


@router.post("/face/enroll", response_model=fr.EnrollmentOut)
async def face_enroll(
    req: EnrollRequest,
    session: AsyncSession = Depends(get_session),
) -> fr.EnrollmentOut:
    try:
        return await fr.enroll(
            session,
            name=req.name,
            identity_vector=req.identity_vector,
            notes=req.notes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/face/identify", response_model=fr.IdentifyOut)
async def face_identify(
    req: IdentifyRequest,
    session: AsyncSession = Depends(get_session),
) -> fr.IdentifyOut:
    threshold = req.threshold if req.threshold is not None else fr.DEFAULT_MATCH_THRESHOLD
    try:
        return await fr.identify(
            session, identity_vector=req.identity_vector, threshold=threshold
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/face/enrollments", response_model=EnrollmentListOut)
async def face_list(
    session: AsyncSession = Depends(get_session),
) -> EnrollmentListOut:
    enrollments = await fr.list_enrollments(session)
    return EnrollmentListOut(enrollments=enrollments)


@router.delete("/face/enrollments/{enrollment_id}")
async def face_delete(
    enrollment_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    deleted = await fr.delete_enrollment(session, enrollment_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Enrollment not found.")
    return {"status": "ok"}


# ─── Workout coach ─────────────────────────────────────────────────────


class CoachRequest(BaseModel):
    goal: str = Field(..., min_length=1)
    pose: PoseSnapshot | None = None
    history: list[str] = Field(default_factory=list)


# Cache the LLM router. Built lazily to avoid hammering settings
# at import time.
_router_singleton: Router | None = None


def _get_router() -> Router:
    global _router_singleton
    if _router_singleton is None:
        _router_singleton = Router.from_settings(get_settings())
    return _router_singleton


@router.post("/coach", response_model=CoachResponse)
async def coach(req: CoachRequest) -> CoachResponse:
    settings = get_settings()
    llm_router = _get_router()
    try:
        return await run_workout_coach(
            goal=req.goal,
            pose=req.pose,
            history=req.history,
            llm_router=llm_router,
            settings=settings,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — surface anything else as 502
        raise HTTPException(
            status_code=502,
            detail=f"Coach failed: {exc}",
        ) from exc
