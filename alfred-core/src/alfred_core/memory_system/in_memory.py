"""Dict-backed backend. The default: zero setup, nothing survives a restart.

Also the reference implementation — the SQLite backend must behave
identically, and the test-suite runs the same contract tests against both.
"""

from __future__ import annotations

import copy
from collections.abc import Iterator

from alfred_core.memory_system.backend import MemoryBackend, Record


class InMemoryBackend(MemoryBackend):
    def __init__(self) -> None:
        # id -> {version -> record}
        self._versions: dict[str, dict[int, Record]] = {}
        # id -> search text of the current version
        self._search: dict[str, str] = {}

    # ─── helpers ──────────────────────────────────────────────────────

    def _current(self, entity_id: str) -> Record | None:
        versions = self._versions.get(entity_id)
        if not versions:
            return None
        return versions[max(versions)]

    # ─── MemoryBackend ────────────────────────────────────────────────

    def put(self, record: Record, *, search_text: str = "") -> None:
        entity_id = str(record["id"])
        version = int(record["version"])
        versions = self._versions.setdefault(entity_id, {})
        if version in versions:
            return
        versions[version] = copy.deepcopy(record)
        if version == max(versions):
            self._search[entity_id] = search_text

    def get(self, entity_id: str) -> Record | None:
        current = self._current(entity_id)
        return copy.deepcopy(current) if current is not None else None

    def delete(self, entity_id: str) -> bool:
        existed = self._versions.pop(entity_id, None) is not None
        self._search.pop(entity_id, None)
        return existed

    def list_all(
        self, kind: str | None = None, *, limit: int | None = None, offset: int = 0
    ) -> list[Record]:
        rows = [
            rec
            for rec in (self._current(i) for i in self._versions)
            if rec is not None and (kind is None or rec["kind"] == kind)
        ]
        rows.sort(key=lambda r: str(r["updated_at"]), reverse=True)
        sliced = rows[offset:] if limit is None else rows[offset : offset + limit]
        return [copy.deepcopy(r) for r in sliced]

    def history(self, entity_id: str) -> list[Record]:
        versions = self._versions.get(entity_id, {})
        return [copy.deepcopy(versions[v]) for v in sorted(versions)]

    def search(self, query: str, kind: str | None = None, *, limit: int = 20) -> list[Record]:
        needle = query.strip().lower()
        if not needle:
            return []
        hits = [
            rec for rec in self.list_all(kind) if needle in self._search.get(str(rec["id"]), "")
        ]
        return hits[:limit]

    def ids(self) -> Iterator[str]:
        yield from list(self._versions)
