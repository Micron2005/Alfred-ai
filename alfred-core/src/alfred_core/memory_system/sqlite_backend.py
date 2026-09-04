"""SQLite backend — the first persistent store.

Why SQLite: it ships with Python, needs no server, lives in one file
that can be backed up with ``cp``, and comfortably handles the
single-user write volume Alfred produces. WAL mode is enabled so reads
never block on the (rare) write.

Schema
------
``memory_versions`` holds *every* version of every entity as a JSON
blob keyed by ``(id, version)``. ``memory_current`` is a thin pointer
table — one row per entity with its latest version, kind, timestamps
and the pre-computed search text — so listing and searching don't have
to scan history. Both are created on first open; ``schema_version`` in
``memory_meta`` leaves room for future in-place migrations.

The connection is opened with ``check_same_thread=False`` and guarded
by a lock, so a single backend instance can be shared across FastAPI
worker threads.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterator
from pathlib import Path

from alfred_core.memory_system.backend import MemoryBackend, Record

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_versions (
    id         TEXT    NOT NULL,
    version    INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    updated_at TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS memory_current (
    id          TEXT    PRIMARY KEY,
    version     INTEGER NOT NULL,
    kind        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    search_text TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS ix_memory_current_kind_updated
    ON memory_current (kind, updated_at DESC);
"""


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class SQLiteBackend(MemoryBackend):
    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).expanduser().parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        if self.path != ":memory:":
            self._conn.execute("PRAGMA journal_mode = WAL")
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.execute(
                "INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )

    # ─── MemoryBackend ────────────────────────────────────────────────

    def put(self, record: Record, *, search_text: str = "") -> None:
        entity_id = str(record["id"])
        version = int(record["version"])
        payload = json.dumps(record, ensure_ascii=False, sort_keys=True)
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                cur = self._conn.execute(
                    "INSERT OR IGNORE INTO memory_versions (id, version, kind, updated_at, data) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (entity_id, version, str(record["kind"]), str(record["updated_at"]), payload),
                )
                if cur.rowcount:
                    row = self._conn.execute(
                        "SELECT version FROM memory_current WHERE id = ?", (entity_id,)
                    ).fetchone()
                    if row is None or version > int(row["version"]):
                        self._conn.execute(
                            "INSERT INTO memory_current "
                            "(id, version, kind, created_at, updated_at, search_text) "
                            "VALUES (?, ?, ?, ?, ?, ?) "
                            "ON CONFLICT(id) DO UPDATE SET "
                            "version = excluded.version, kind = excluded.kind, "
                            "updated_at = excluded.updated_at, "
                            "search_text = excluded.search_text",
                            (
                                entity_id,
                                version,
                                str(record["kind"]),
                                str(record["created_at"]),
                                str(record["updated_at"]),
                                search_text,
                            ),
                        )
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def get(self, entity_id: str) -> Record | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT v.data FROM memory_current c "
                "JOIN memory_versions v ON v.id = c.id AND v.version = c.version "
                "WHERE c.id = ?",
                (entity_id,),
            ).fetchone()
        return json.loads(row["data"]) if row else None

    def delete(self, entity_id: str) -> bool:
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                cur = self._conn.execute("DELETE FROM memory_current WHERE id = ?", (entity_id,))
                self._conn.execute("DELETE FROM memory_versions WHERE id = ?", (entity_id,))
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
        return bool(cur.rowcount)

    def _select_current(
        self, where: str, params: tuple[object, ...], limit: int | None, offset: int
    ) -> list[Record]:
        sql = (
            "SELECT v.data FROM memory_current c "
            "JOIN memory_versions v ON v.id = c.id AND v.version = c.version "
            f"WHERE {where} ORDER BY c.updated_at DESC, c.id"
        )
        if limit is not None:
            sql += " LIMIT ? OFFSET ?"
            params = (*params, limit, offset)
        elif offset:
            sql += " LIMIT -1 OFFSET ?"
            params = (*params, offset)
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def list_all(
        self, kind: str | None = None, *, limit: int | None = None, offset: int = 0
    ) -> list[Record]:
        if kind is None:
            return self._select_current("1 = 1", (), limit, offset)
        return self._select_current("c.kind = ?", (kind,), limit, offset)

    def history(self, entity_id: str) -> list[Record]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT data FROM memory_versions WHERE id = ? ORDER BY version",
                (entity_id,),
            ).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def search(self, query: str, kind: str | None = None, *, limit: int = 20) -> list[Record]:
        needle = query.strip().lower()
        if not needle:
            return []
        pattern = f"%{_escape_like(needle)}%"
        if kind is None:
            return self._select_current("c.search_text LIKE ? ESCAPE '\\'", (pattern,), limit, 0)
        return self._select_current(
            "c.kind = ? AND c.search_text LIKE ? ESCAPE '\\'", (kind, pattern), limit, 0
        )

    def ids(self) -> Iterator[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id FROM memory_current ORDER BY created_at"
            ).fetchall()
        for r in rows:
            yield str(r["id"])

    def count(self, kind: str | None = None) -> int:
        with self._lock:
            if kind is None:
                row = self._conn.execute("SELECT COUNT(*) AS n FROM memory_current").fetchone()
            else:
                row = self._conn.execute(
                    "SELECT COUNT(*) AS n FROM memory_current WHERE kind = ?", (kind,)
                ).fetchone()
        return int(row["n"])

    def close(self) -> None:
        with self._lock:
            self._conn.close()
