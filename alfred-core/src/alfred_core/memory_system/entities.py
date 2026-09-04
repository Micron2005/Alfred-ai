"""Typed memory entities.

Every long-lived thing Alfred should remember is modelled as a subclass
of :class:`MemoryEntity`. Entities are plain Pydantic models, so they
validate on construction and round-trip to JSON without ceremony.

Versioning: each entity carries a monotonically increasing ``version``.
The :class:`~alfred_core.memory_system.manager.MemoryManager` bumps it on
every update and the backend keeps every prior version, so
``manager.history(id)`` can replay how a project, decision, or device
record evolved over time.

Adding a new entity kind is three steps: subclass ``MemoryEntity``, set
``kind`` to a new :class:`EntityKind`, and register it in
``ENTITY_TYPES`` at the bottom of this file.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, ClassVar, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _new_id() -> str:
    return uuid4().hex


class EntityKind(StrEnum):
    PROJECT = "project"
    DECISION = "decision"
    EXPERIMENT = "experiment"
    DEVICE = "device"
    PREFERENCE = "preference"


class MemoryEntity(BaseModel):
    """Common shape shared by every memory entity.

    ``kind`` is a class-level discriminator; subclasses pin it with a
    ``Literal`` so deserialisation can dispatch on it.
    """

    model_config = ConfigDict(extra="forbid", validate_assignment=True)

    kind: EntityKind
    id: str = Field(default_factory=_new_id)
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    version: int = Field(default=1, ge=1)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    #: Fields a plain-text search should look at, in addition to
    #: ``name`` / ``description`` / ``tags``. Subclasses extend this.
    searchable_fields: ClassVar[tuple[str, ...]] = ()

    def search_text(self) -> str:
        """Lower-cased blob used for simple substring retrieval."""
        parts: list[str] = [self.name, self.description, *self.tags]
        for field_name in self.searchable_fields:
            value = getattr(self, field_name)
            if value is None:
                continue
            if isinstance(value, list | tuple):
                parts.extend(str(v) for v in value)
            else:
                parts.append(str(value))
        return " ".join(parts).lower()

    def to_record(self) -> dict[str, Any]:
        """JSON-safe dict, suitable for any backend."""
        return self.model_dump(mode="json")


class Project(MemoryEntity):
    """Something Mukarram is building — Alfred itself, a print, a circuit."""

    kind: Literal[EntityKind.PROJECT] = EntityKind.PROJECT
    status: Literal["idea", "active", "paused", "done", "abandoned"] = "active"
    goals: list[str] = Field(default_factory=list)
    repo_url: str = ""

    searchable_fields: ClassVar[tuple[str, ...]] = ("status", "goals", "repo_url")


class Decision(MemoryEntity):
    """A choice that was made, why, and what was rejected."""

    kind: Literal[EntityKind.DECISION] = EntityKind.DECISION
    project_id: str | None = None
    rationale: str = ""
    alternatives: list[str] = Field(default_factory=list)
    outcome: str = ""
    decided_at: datetime = Field(default_factory=_utcnow)

    searchable_fields: ClassVar[tuple[str, ...]] = ("rationale", "alternatives", "outcome")


class Experiment(MemoryEntity):
    """A hypothesis that was (or will be) tested."""

    kind: Literal[EntityKind.EXPERIMENT] = EntityKind.EXPERIMENT
    project_id: str | None = None
    hypothesis: str = ""
    method: str = ""
    result: str = ""
    status: Literal["planned", "running", "succeeded", "failed", "inconclusive"] = "planned"

    searchable_fields: ClassVar[tuple[str, ...]] = ("hypothesis", "method", "result", "status")


class Device(MemoryEntity):
    """A physical or virtual device Alfred knows about (printer, light, PC)."""

    kind: Literal[EntityKind.DEVICE] = EntityKind.DEVICE
    device_type: str = ""
    address: str = ""
    location: str = ""
    capabilities: list[str] = Field(default_factory=list)
    online: bool | None = None

    searchable_fields: ClassVar[tuple[str, ...]] = (
        "device_type",
        "address",
        "location",
        "capabilities",
    )


class Preference(MemoryEntity):
    """A standing user preference (``key`` → ``value``)."""

    kind: Literal[EntityKind.PREFERENCE] = EntityKind.PREFERENCE
    key: str = Field(min_length=1)
    value: Any = None
    category: str = "general"

    searchable_fields: ClassVar[tuple[str, ...]] = ("key", "value", "category")


ENTITY_TYPES: dict[EntityKind, type[MemoryEntity]] = {
    EntityKind.PROJECT: Project,
    EntityKind.DECISION: Decision,
    EntityKind.EXPERIMENT: Experiment,
    EntityKind.DEVICE: Device,
    EntityKind.PREFERENCE: Preference,
}


def entity_from_record(record: dict[str, Any]) -> MemoryEntity:
    """Rebuild the right entity subclass from a stored dict."""
    kind = EntityKind(record["kind"])
    return ENTITY_TYPES[kind].model_validate(record)
