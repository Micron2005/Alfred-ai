"""Face recognition — identity-vector enrollment & lookup.

The frontend's ``useFaceTracking`` hook produces a 96-D
normalized pairwise-distance signature from MediaPipe FaceLandmarker
output. We store enrolled (name, vector) pairs in pgvector and
match incoming queries via cosine distance.

This is a pragmatic stub: the geometric signature is enough to
distinguish a few household members at similar pose / lighting,
but it's *not* a learned face embedding. To upgrade for real
recognition robustness, swap the vector source on the client to
something like ``@vladmandic/face-api`` (128-D dlib descriptors)
or move face-feature extraction to the backend with
``insightface`` (ArcFace, 512-D) and update ``FACE_IDENTITY_DIM``
in ``db/models.py``.

Match threshold default of 0.92 cosine similarity is tuned for
the geometric signature — relax/tighten in
``ALFRED_FACE_MATCH_THRESHOLD`` once you've enrolled a few people
and have a feel for false-positive vs false-negative rates.
"""

from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from alfred_core.db.models import FACE_IDENTITY_DIM, FaceEnrollment

# Default match threshold (cosine similarity, 0..1). Anything
# above this is considered the same person.
DEFAULT_MATCH_THRESHOLD = 0.92


class EnrollmentOut(BaseModel):
    id: UUID
    name: str
    enrolled_at: str
    notes: str | None = None


class MatchOut(BaseModel):
    enrollment: EnrollmentOut
    similarity: float


class IdentifyOut(BaseModel):
    match: MatchOut | None = None
    candidates: list[MatchOut] = Field(default_factory=list)


def _validate_vector(vec: list[float]) -> list[float]:
    if len(vec) != FACE_IDENTITY_DIM:
        raise ValueError(
            f"Identity vector must be {FACE_IDENTITY_DIM} dims, got {len(vec)}."
        )
    return [float(x) for x in vec]


def _to_out(row: FaceEnrollment) -> EnrollmentOut:
    return EnrollmentOut(
        id=row.id,
        name=row.name,
        enrolled_at=row.created_at.isoformat(),
        notes=row.notes,
    )


async def enroll(
    session: AsyncSession,
    *,
    name: str,
    identity_vector: list[float],
    notes: str | None = None,
) -> EnrollmentOut:
    vec = _validate_vector(identity_vector)
    row = FaceEnrollment(
        name=name.strip() or "Unknown",
        identity_vector=vec,
        notes=notes,
    )
    session.add(row)
    await session.flush()
    await session.commit()
    await session.refresh(row)
    return _to_out(row)


async def list_enrollments(session: AsyncSession) -> list[EnrollmentOut]:
    result = await session.execute(
        select(FaceEnrollment).order_by(FaceEnrollment.created_at.desc())
    )
    return [_to_out(r) for r in result.scalars().all()]


async def delete_enrollment(session: AsyncSession, enrollment_id: UUID) -> bool:
    row = await session.get(FaceEnrollment, enrollment_id)
    if row is None:
        return False
    await session.delete(row)
    await session.commit()
    return True


async def identify(
    session: AsyncSession,
    *,
    identity_vector: list[float],
    threshold: float = DEFAULT_MATCH_THRESHOLD,
    top_k: int = 5,
) -> IdentifyOut:
    """Find the closest enrollments by cosine similarity.

    Uses pgvector's cosine_distance operator. similarity = 1 - distance.
    """
    vec = _validate_vector(identity_vector)
    distance = FaceEnrollment.identity_vector.cosine_distance(vec)
    stmt = (
        select(FaceEnrollment, distance.label("distance"))
        .order_by(distance.asc())
        .limit(top_k)
    )
    result = await session.execute(stmt)
    matches: list[MatchOut] = []
    for row, dist in result.all():
        sim = max(0.0, min(1.0, 1.0 - float(dist)))
        matches.append(MatchOut(enrollment=_to_out(row), similarity=sim))
    best = matches[0] if matches and matches[0].similarity >= threshold else None
    return IdentifyOut(match=best, candidates=matches)
