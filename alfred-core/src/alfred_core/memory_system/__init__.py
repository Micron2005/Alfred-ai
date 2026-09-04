"""Alfred's structured, persistent memory.

Layers, bottom-up:

* :mod:`~alfred_core.memory_system.backend` — the abstract storage
  contract, with :class:`InMemoryBackend` (default, volatile) and
  :class:`SQLiteBackend` (persistent, single file) implementations.
* :mod:`~alfred_core.memory_system.entities` — typed, versioned entities:
  :class:`Project`, :class:`Decision`, :class:`Experiment`,
  :class:`Device`, :class:`Preference`.
* :mod:`~alfred_core.memory_system.manager` — :class:`MemoryManager`,
  the CRUD / search / history façade that also emits bus events.
* :mod:`~alfred_core.memory_system.migration` — copying state between
  backends and to/from JSON snapshots.

:func:`build_memory_manager` reads :class:`~alfred_core.config.Settings`
and assembles the right stack; :func:`get_memory_manager` is the
process-wide instance used by the FastAPI app.

This module deliberately stops at relational persistence. Vector search
over these entities and graph relationships between them are future
layers that will sit on top of the same backend interface.
"""

from __future__ import annotations

import logging
from pathlib import Path

from alfred_core.bus import EventBus
from alfred_core.config import Settings, get_settings
from alfred_core.memory_system.backend import MemoryBackend, Record
from alfred_core.memory_system.entities import (
    ENTITY_TYPES,
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
from alfred_core.memory_system.manager import (
    MemoryManager,
    MemoryNotFoundError,
    MemoryVersionConflictError,
)
from alfred_core.memory_system.migration import (
    MigrationReport,
    export_snapshot,
    import_snapshot,
    migrate_backend,
)
from alfred_core.memory_system.sqlite_backend import SQLiteBackend

log = logging.getLogger(__name__)

__all__ = [
    "ENTITY_TYPES",
    "Decision",
    "Device",
    "EntityKind",
    "Experiment",
    "InMemoryBackend",
    "MemoryBackend",
    "MemoryEntity",
    "MemoryManager",
    "MemoryNotFoundError",
    "MemoryVersionConflictError",
    "MigrationReport",
    "Preference",
    "Project",
    "Record",
    "SQLiteBackend",
    "build_backend",
    "build_memory_manager",
    "entity_from_record",
    "export_snapshot",
    "get_memory_manager",
    "import_snapshot",
    "migrate_backend",
    "reset_memory_manager",
]


def build_backend(settings: Settings | None = None) -> MemoryBackend:
    """Pick a backend from ``ALFRED_MEMORY_BACKEND``."""
    settings = settings or get_settings()
    if settings.alfred_memory_backend == "sqlite":
        return SQLiteBackend(settings.alfred_memory_sqlite_path)
    return InMemoryBackend()


def build_memory_manager(
    settings: Settings | None = None, *, bus: EventBus | None = None
) -> MemoryManager:
    """Assemble a manager from settings, seeding it from a snapshot if configured.

    The seed snapshot is only imported when the backend has no entities
    yet, so an existing SQLite file is never overwritten by a stale export.
    """
    settings = settings or get_settings()
    backend = build_backend(settings)
    seed = settings.alfred_memory_seed_snapshot.strip()
    if seed and backend.count() == 0:
        seed_path = Path(seed).expanduser()
        if seed_path.is_file():
            report = import_snapshot(seed_path, backend)
            log.info("Seeded memory from %s: %s", seed_path, report)
        else:
            log.warning("ALFRED_MEMORY_SEED_SNAPSHOT=%s not found; starting empty", seed)
    log.info(
        "Memory backend: %s%s",
        settings.alfred_memory_backend,
        f" ({settings.alfred_memory_sqlite_path})" if settings.memory_persistence_enabled else "",
    )
    return MemoryManager(backend, bus=bus)


_manager: MemoryManager | None = None


def get_memory_manager() -> MemoryManager:
    """Process-wide manager, built lazily from the live settings."""
    global _manager
    if _manager is None:
        _manager = build_memory_manager()
    return _manager


def reset_memory_manager() -> None:
    """Close and forget the process-wide manager (startup/shutdown + tests)."""
    global _manager
    if _manager is not None:
        _manager.close()
        _manager = None
