# Structured memory

`alfred_core/memory_system/` is Alfred's long-lived, structured memory: the
projects he is helping with, the decisions made along the way, experiments
and their outcomes, the devices in the house, and standing preferences. It
is separate from the Postgres conversation store and from the Phase 12b
Markdown/pgvector "memory archive" — those remember *what was said*; this
remembers *what is true*.

The design goal for this first cut is boring reliability: plain relational
persistence, no vector search, no graph database. Both can be layered on
later behind the same backend interface.

## Layers

```
MemoryManager            CRUD, search, history, typed helpers, bus events
   │
   ▼
MemoryBackend (ABC)      put / get / delete / list_all / history / search / ids
   ├── InMemoryBackend   default — dict, forgotten on restart
   └── SQLiteBackend     one file, WAL mode, full version history
```

* **Entities** (`entities.py`) are Pydantic models. All share `id`, `name`,
  `description`, `tags`, `version`, `created_at`, `updated_at`; each kind
  adds its own fields (`Project.status`, `Decision.rationale`,
  `Device.capabilities`, `Preference.key/value`, …).
* **Versioning**: `manager.update(id, **changes)` writes a *new* version and
  keeps the old one. `manager.history(id)` returns every version, oldest
  first. `update(..., expected_version=n)` gives optimistic locking.
* **Retrieval**: `manager.search("printer")` is a case-insensitive substring
  match over each entity's text fields (name, description, tags, plus the
  kind-specific `searchable_fields`). `manager.list_all(kind)`,
  `manager.projects()`, `manager.decisions(project_id)`, etc. are the typed
  shortcuts.
* **Events**: every write emits `EventType.MEMORY_STORE` (payload: `id`,
  `kind`, `name`, `version`, `created`), every read emits
  `EventType.MEMORY_RETRIEVE` (`operation`, `count`, `ids`, plus `query` /
  `kind` when relevant), deletes emit `EventType.MEMORY_DELETE`. Subscribe via
  `alfred_core.bus.get_bus()`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ALFRED_MEMORY_BACKEND` | `memory` | `memory` (volatile, historical behaviour) or `sqlite` (persistent). |
| `ALFRED_MEMORY_SQLITE_PATH` | `/app/alfred-memory/alfred-memory.db` | SQLite file. The default sits inside the `alfred-memory` volume already mounted from the host in `docker-compose.yml`, so the file survives container rebuilds. |
| `ALFRED_MEMORY_SEED_SNAPSHOT` | *(empty)* | Optional JSON snapshot imported on startup **only if the backend is empty**. |

`Settings.memory_persistence_enabled` reports whether a persistent backend is
active. The FastAPI app builds the process-wide manager in its lifespan hook
(`get_memory_manager()`) and closes it on shutdown.

## Usage

```python
from alfred_core.memory_system import Device, Project, get_memory_manager

memory = get_memory_manager()

alfred = memory.store(Project(name="Alfred", goals=["persist memory"]))
printer = memory.store(Device(name="K1 Max", device_type="3d-printer"))

memory.update(printer.id, online=True)                 # -> version 2
memory.set_preference("units", "metric")               # create-or-update by key

memory.search("printer")                               # [Device(...)]
memory.history(printer.id)                             # [v1, v2]
```

For tests or one-off scripts, bypass the global and build your own:

```python
from alfred_core.bus import EventBus
from alfred_core.memory_system import MemoryManager, SQLiteBackend

manager = MemoryManager(SQLiteBackend("~/alfred.db"), bus=EventBus())
```

## Migrating from in-memory to persistent storage

Existing installs keep working unchanged: the default backend is still
in-memory. To turn persistence on, set `ALFRED_MEMORY_BACKEND=sqlite` in
`.env` and restart. From then on everything Alfred stores survives restarts.

If there is live in-memory state worth keeping (or you later move from
SQLite to Postgres), `memory_system.migration` copies entities **with their
full version history** and is idempotent — re-running only fills gaps:

```python
from alfred_core.memory_system import SQLiteBackend, migrate_backend

report = migrate_backend(manager.backend, SQLiteBackend("/app/alfred-memory/alfred-memory.db"))
print(report)   # "3 entities, 7 versions copied, 0 already present"
```

For a portable backup use JSON snapshots:

```python
from alfred_core.memory_system import export_snapshot, import_snapshot

export_snapshot(manager.backend, "memory-backup.json")
import_snapshot("memory-backup.json", SQLiteBackend("fresh.db"))
```

Point `ALFRED_MEMORY_SEED_SNAPSHOT` at such a file to have a brand-new
SQLite store populated automatically on first boot.

## SQLite schema

```
memory_versions (id, version, kind, updated_at, data JSON)   -- every version, PK (id, version)
memory_current  (id, version, kind, created_at, updated_at, search_text)  -- pointer to latest
memory_meta     (key, value)                                 -- schema_version = 1
```

`put` is append-only on `(id, version)`; the current pointer only moves
forward. Deleting an entity removes both its pointer and its history.

## Adding an entity kind

1. Subclass `MemoryEntity` in `entities.py`, pin `kind` to a new
   `EntityKind` value, list the extra text fields in `searchable_fields`.
2. Register it in `ENTITY_TYPES`.
3. (Optional) add a typed helper on `MemoryManager`.

No backend changes are needed — backends store JSON and never look inside.

## Not yet

Vector similarity search, relationships/graph queries between entities, and
a Postgres backend are intentionally out of scope for this foundation. Each
slots in as another `MemoryBackend` (or a layer on top of one) without
touching the entity or manager APIs.
