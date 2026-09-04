"""MemoryManager — the one object the rest of Alfred talks to.

It owns a :class:`MemoryBackend`, converts between typed entities and
stored records, enforces the versioning rules, and announces every
store / retrieve / delete on the :class:`~alfred_core.bus.EventBus`.

Typical use::

    manager = MemoryManager(SQLiteBackend("alfred-memory.db"))
    printer = manager.store(Device(name="K1 Max", device_type="3d-printer"))
    manager.update(printer.id, online=True)          # version 2
    manager.history(printer.id)                      # [v1, v2]
    manager.search("printer")                        # [Device(...)]
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any, TypeVar

from alfred_core.bus import EventBus, EventType, get_bus
from alfred_core.memory_system.backend import MemoryBackend
from alfred_core.memory_system.entities import (
    Decision,
    Device,
    EntityKind,
    Experiment,
    MemoryEntity,
    Preference,
    Project,
    entity_from_record,
)
from alfred_core.memory_system.in_memory import InMemoryBackend

log = logging.getLogger(__name__)

E = TypeVar("E", bound=MemoryEntity)

_SOURCE = "memory_system"


class MemoryNotFoundError(KeyError):
    """Raised when an update/history call targets an unknown entity id."""


class MemoryVersionConflictError(RuntimeError):
    """Raised when ``update(expected_version=...)`` doesn't match the stored version."""


class MemoryManager:
    def __init__(
        self, backend: MemoryBackend | None = None, *, bus: EventBus | None = None
    ) -> None:
        self.backend: MemoryBackend = backend if backend is not None else InMemoryBackend()
        self.bus: EventBus = bus if bus is not None else get_bus()

    # ─── writes ───────────────────────────────────────────────────────

    def store(self, entity: E) -> E:
        """Persist a *new* entity (or re-store a full entity at its current version).

        Fails if an entity with the same id already exists at a higher
        version — use :meth:`update` for that.
        """
        existing = self.backend.get(entity.id)
        if existing is not None and int(existing["version"]) > entity.version:
            raise MemoryVersionConflictError(
                f"{entity.kind} {entity.id} is at v{existing['version']}, got v{entity.version}"
            )
        self.backend.put(entity.to_record(), search_text=entity.search_text())
        self._emit(EventType.MEMORY_STORE, entity, created=existing is None)
        return entity

    def update(
        self, entity_id: str, *, expected_version: int | None = None, **changes: Any
    ) -> MemoryEntity:
        """Apply ``changes`` to the current version and store it as a new version.

        ``expected_version`` gives optimistic concurrency: if the stored
        version differs, :class:`MemoryVersionConflictError` is raised and
        nothing is written.
        """
        record = self.backend.get(entity_id)
        if record is None:
            raise MemoryNotFoundError(entity_id)
        current = entity_from_record(record)
        if expected_version is not None and current.version != expected_version:
            raise MemoryVersionConflictError(
                f"{entity_id} is at v{current.version}, expected v{expected_version}"
            )
        for immutable in ("id", "kind", "version", "created_at"):
            changes.pop(immutable, None)
        updated = current.model_copy(
            update={**changes, "version": current.version + 1, "updated_at": datetime.now(UTC)}
        )
        # ``model_copy`` skips validation; round-trip to enforce field types.
        updated = entity_from_record(updated.to_record())
        self.backend.put(updated.to_record(), search_text=updated.search_text())
        self._emit(EventType.MEMORY_STORE, updated, created=False)
        return updated

    def delete(self, entity_id: str) -> bool:
        current = self.backend.get(entity_id)
        removed = self.backend.delete(entity_id)
        if removed and current is not None:
            self.bus.emit(
                EventType.MEMORY_DELETE,
                {"id": entity_id, "kind": current["kind"], "name": current.get("name")},
                source=_SOURCE,
            )
        return removed

    # ─── reads ────────────────────────────────────────────────────────

    def get(self, entity_id: str) -> MemoryEntity | None:
        record = self.backend.get(entity_id)
        if record is None:
            return None
        entity = entity_from_record(record)
        self._emit_retrieve("get", [entity], id=entity_id)
        return entity

    def get_as(self, entity_id: str, entity_type: type[E]) -> E | None:
        """``get`` with a type check — returns ``None`` if the kind doesn't match."""
        entity = self.get(entity_id)
        return entity if isinstance(entity, entity_type) else None

    def list_all(
        self,
        kind: EntityKind | str | None = None,
        *,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[MemoryEntity]:
        kind_str = str(kind) if kind is not None else None
        entities = [
            entity_from_record(r)
            for r in self.backend.list_all(kind_str, limit=limit, offset=offset)
        ]
        self._emit_retrieve("list", entities, kind=kind_str)
        return entities

    def search(
        self, query: str, kind: EntityKind | str | None = None, *, limit: int = 20
    ) -> list[MemoryEntity]:
        """Simple case-insensitive substring retrieval across an entity's text fields."""
        kind_str = str(kind) if kind is not None else None
        entities = [
            entity_from_record(r) for r in self.backend.search(query, kind_str, limit=limit)
        ]
        self._emit_retrieve("search", entities, query=query, kind=kind_str)
        return entities

    def history(self, entity_id: str) -> list[MemoryEntity]:
        """Every stored version of an entity, oldest first."""
        records = self.backend.history(entity_id)
        if not records:
            raise MemoryNotFoundError(entity_id)
        return [entity_from_record(r) for r in records]

    def count(self, kind: EntityKind | str | None = None) -> int:
        return self.backend.count(str(kind) if kind is not None else None)

    # ─── typed conveniences ───────────────────────────────────────────

    def projects(self) -> list[Project]:
        return [e for e in self.list_all(EntityKind.PROJECT) if isinstance(e, Project)]

    def decisions(self, project_id: str | None = None) -> list[Decision]:
        return [
            e
            for e in self.list_all(EntityKind.DECISION)
            if isinstance(e, Decision) and (project_id is None or e.project_id == project_id)
        ]

    def experiments(self, project_id: str | None = None) -> list[Experiment]:
        return [
            e
            for e in self.list_all(EntityKind.EXPERIMENT)
            if isinstance(e, Experiment) and (project_id is None or e.project_id == project_id)
        ]

    def devices(self) -> list[Device]:
        return [e for e in self.list_all(EntityKind.DEVICE) if isinstance(e, Device)]

    def preferences(self, category: str | None = None) -> list[Preference]:
        return [
            e
            for e in self.list_all(EntityKind.PREFERENCE)
            if isinstance(e, Preference) and (category is None or e.category == category)
        ]

    def preference(self, key: str) -> Preference | None:
        """Look up a preference by its ``key`` (newest wins if duplicated)."""
        for pref in self.preferences():
            if pref.key == key:
                return pref
        return None

    def set_preference(self, key: str, value: Any, *, category: str = "general") -> Preference:
        """Create-or-update a preference by key, keeping its version history."""
        existing = self.preference(key)
        if existing is None:
            return self.store(Preference(name=key, key=key, value=value, category=category))
        updated = self.update(existing.id, value=value, category=category)
        assert isinstance(updated, Preference)
        return updated

    # ─── lifecycle ────────────────────────────────────────────────────

    def close(self) -> None:
        self.backend.close()

    # ─── internals ────────────────────────────────────────────────────

    def _emit(self, event_type: EventType, entity: MemoryEntity, *, created: bool) -> None:
        self.bus.emit(
            event_type,
            {
                "id": entity.id,
                "kind": str(entity.kind),
                "name": entity.name,
                "version": entity.version,
                "created": created,
            },
            source=_SOURCE,
        )

    def _emit_retrieve(self, operation: str, entities: list[MemoryEntity], **extra: Any) -> None:
        self.bus.emit(
            EventType.MEMORY_RETRIEVE,
            {
                "operation": operation,
                "count": len(entities),
                "ids": [e.id for e in entities],
                **{k: v for k, v in extra.items() if v is not None},
            },
            source=_SOURCE,
        )
