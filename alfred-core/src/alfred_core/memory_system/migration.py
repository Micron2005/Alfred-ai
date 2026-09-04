"""Moving memory between backends.

Two paths are supported:

* :func:`migrate_backend` copies every entity *and its full version
  history* from one live backend to another. Because ``put`` is
  idempotent on ``(id, version)``, re-running a migration is safe — it
  only fills in whatever the target is missing. This is how an
  in-memory manager's state is carried over to SQLite when persistence
  is switched on, and how a SQLite file will be moved to Postgres later.

* :func:`export_snapshot` / :func:`import_snapshot` dump the same data
  to / from a JSON file — a portable backup that survives schema changes
  and can be inspected by hand.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from alfred_core.memory_system.backend import MemoryBackend, Record
from alfred_core.memory_system.entities import entity_from_record

SNAPSHOT_FORMAT = 1


@dataclass(frozen=True, slots=True)
class MigrationReport:
    entities: int
    versions: int
    skipped_versions: int

    def __str__(self) -> str:
        return (
            f"{self.entities} entities, {self.versions} versions copied, "
            f"{self.skipped_versions} already present"
        )


def _search_text_for(record: Record) -> str:
    return entity_from_record(record).search_text()


def _copy_records(records: list[Record], target: MemoryBackend) -> tuple[int, int]:
    copied = skipped = 0
    for record in records:
        existing = {int(r["version"]) for r in target.history(str(record["id"]))}
        if int(record["version"]) in existing:
            skipped += 1
            continue
        target.put(record, search_text=_search_text_for(record))
        copied += 1
    return copied, skipped


def migrate_backend(source: MemoryBackend, target: MemoryBackend) -> MigrationReport:
    """Copy everything in ``source`` into ``target`` (history included)."""
    entities = versions = skipped = 0
    for entity_id in list(source.ids()):
        history = source.history(entity_id)
        if not history:
            continue
        entities += 1
        copied, already = _copy_records(history, target)
        versions += copied
        skipped += already
    return MigrationReport(entities=entities, versions=versions, skipped_versions=skipped)


def export_snapshot(source: MemoryBackend, path: str | Path) -> int:
    """Write every version of every entity to a JSON file. Returns entity count."""
    payload: dict[str, Any] = {"format": SNAPSHOT_FORMAT, "entities": []}
    for entity_id in list(source.ids()):
        history = source.history(entity_id)
        if history:
            payload["entities"].append({"id": entity_id, "versions": history})
    Path(path).expanduser().write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8"
    )
    return len(payload["entities"])


def import_snapshot(path: str | Path, target: MemoryBackend) -> MigrationReport:
    """Load a file written by :func:`export_snapshot` into ``target``."""
    payload = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    if payload.get("format") != SNAPSHOT_FORMAT:
        raise ValueError(f"Unsupported snapshot format: {payload.get('format')!r}")
    entities = versions = skipped = 0
    for item in payload["entities"]:
        entities += 1
        copied, already = _copy_records(item["versions"], target)
        versions += copied
        skipped += already
    return MigrationReport(entities=entities, versions=versions, skipped_versions=skipped)
