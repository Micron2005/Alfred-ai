"""Tests for the structured memory subsystem (``alfred_core.memory_system``).

The backend contract tests run against both ``InMemoryBackend`` and
``SQLiteBackend`` so the two can never drift. The restart tests are the
whole point of the subsystem: close everything, reopen the same file, and
the memories are still there — history included.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from alfred_core.bus import Event, EventBus, EventType
from alfred_core.config import Settings
from alfred_core.memory_system import (
    Decision,
    Device,
    EntityKind,
    Experiment,
    InMemoryBackend,
    MemoryBackend,
    MemoryManager,
    MemoryNotFoundError,
    MemoryVersionConflictError,
    Preference,
    Project,
    SQLiteBackend,
    build_backend,
    build_memory_manager,
    entity_from_record,
    export_snapshot,
    import_snapshot,
    migrate_backend,
)

# ─── fixtures ────────────────────────────────────────────────────────────


@pytest.fixture(params=["memory", "sqlite"])
def backend(request: pytest.FixtureRequest, tmp_path: Path) -> Iterator[MemoryBackend]:
    be: MemoryBackend = (
        InMemoryBackend() if request.param == "memory" else SQLiteBackend(tmp_path / "mem.db")
    )
    yield be
    be.close()


@pytest.fixture
def bus() -> EventBus:
    return EventBus()


@pytest.fixture
def manager(backend: MemoryBackend, bus: EventBus) -> MemoryManager:
    return MemoryManager(backend, bus=bus)


def _collect(bus: EventBus) -> list[Event]:
    seen: list[Event] = []
    bus.subscribe_all(seen.append)
    return seen


# ─── entities ────────────────────────────────────────────────────────────


def test_entities_round_trip_through_records() -> None:
    samples = [
        Project(name="Alfred", goals=["persist memory"], status="active"),
        Decision(name="Use SQLite first", rationale="zero deps", alternatives=["Postgres"]),
        Experiment(name="WAL mode", hypothesis="reads don't block", status="planned"),
        Device(name="K1 Max", device_type="3d-printer", capabilities=["print", "camera"]),
        Preference(name="units", key="units", value="metric", category="display"),
    ]
    for original in samples:
        restored = entity_from_record(original.to_record())
        assert type(restored) is type(original)
        assert restored == original


def test_entity_kind_is_pinned_per_subclass() -> None:
    assert Project(name="x").kind == EntityKind.PROJECT
    with pytest.raises(ValueError):
        Project(name="x", kind=EntityKind.DEVICE)  # type: ignore[arg-type]


def test_search_text_includes_subclass_fields() -> None:
    dev = Device(name="Printer", location="Workshop", capabilities=["Camera"])
    text = dev.search_text()
    assert "workshop" in text
    assert "camera" in text


# ─── backend contract (both backends) ───────────────────────────────────


def test_backend_crud(backend: MemoryBackend) -> None:
    proj = Project(name="Alfred")
    backend.put(proj.to_record(), search_text=proj.search_text())
    assert backend.get(proj.id) == proj.to_record()
    assert backend.count() == 1
    assert backend.count("project") == 1
    assert backend.count("device") == 0
    assert list(backend.ids()) == [proj.id]
    assert backend.delete(proj.id) is True
    assert backend.delete(proj.id) is False
    assert backend.get(proj.id) is None
    assert backend.history(proj.id) == []


def test_backend_keeps_versions_and_is_idempotent(backend: MemoryBackend) -> None:
    v1 = Project(name="Alfred", description="v1")
    v2 = v1.model_copy(update={"version": 2, "description": "v2"})
    backend.put(v1.to_record())
    backend.put(v2.to_record())
    backend.put(v2.to_record())  # duplicate (id, version) is a no-op
    backend.put(v1.to_record())  # older version doesn't clobber current
    assert backend.get(v1.id) == v2.to_record()
    assert [r["version"] for r in backend.history(v1.id)] == [1, 2]


def test_backend_list_filters_orders_and_paginates(backend: MemoryBackend) -> None:
    items = [Project(name=f"p{i}") for i in range(3)] + [Device(name="d0")]
    for it in items:
        backend.put(it.to_record(), search_text=it.search_text())
    assert len(backend.list_all()) == 4
    assert {r["name"] for r in backend.list_all("project")} == {"p0", "p1", "p2"}
    page = backend.list_all(limit=2, offset=1)
    assert len(page) == 2
    stamps = [r["updated_at"] for r in backend.list_all()]
    assert stamps == sorted(stamps, reverse=True)


def test_backend_search_is_case_insensitive_and_kind_scoped(backend: MemoryBackend) -> None:
    dev = Device(name="Creality K1 Max", location="Workshop")
    proj = Project(name="Workshop reorg")
    for e in (dev, proj):
        backend.put(e.to_record(), search_text=e.search_text())
    assert {r["id"] for r in backend.search("WORKSHOP")} == {dev.id, proj.id}
    assert [r["id"] for r in backend.search("workshop", "device")] == [dev.id]
    assert backend.search("") == []
    assert backend.search("100%_match") == []  # LIKE wildcards are escaped


# ─── manager ────────────────────────────────────────────────────────────


def test_manager_store_get_update_history(manager: MemoryManager) -> None:
    printer = manager.store(Device(name="K1 Max", device_type="3d-printer"))
    assert manager.get(printer.id) == printer

    v2 = manager.update(printer.id, online=True, tags=["workshop"])
    assert isinstance(v2, Device)
    assert v2.version == 2
    assert v2.online is True
    assert v2.created_at == printer.created_at
    assert v2.updated_at >= printer.updated_at

    history = manager.history(printer.id)
    assert [h.version for h in history] == [1, 2]
    assert isinstance(history[0], Device)
    assert history[0].online is None


def test_manager_update_validates_and_ignores_immutables(manager: MemoryManager) -> None:
    proj = manager.store(Project(name="Alfred"))
    with pytest.raises(ValueError):
        manager.update(proj.id, status="not-a-status")
    updated = manager.update(proj.id, id="hijack", version=99, status="paused")
    assert updated.id == proj.id
    assert updated.version == 2


def test_manager_errors(manager: MemoryManager) -> None:
    with pytest.raises(MemoryNotFoundError):
        manager.update("nope", name="x")
    with pytest.raises(MemoryNotFoundError):
        manager.history("nope")
    proj = manager.store(Project(name="Alfred"))
    manager.update(proj.id, description="v2")
    with pytest.raises(MemoryVersionConflictError):
        manager.update(proj.id, expected_version=1, description="stale")
    with pytest.raises(MemoryVersionConflictError):
        manager.store(proj)  # stored copy is at v2, this is v1


def test_manager_typed_helpers_and_preferences(manager: MemoryManager) -> None:
    alfred = manager.store(Project(name="Alfred"))
    other = manager.store(Project(name="Other"))
    manager.store(Decision(name="SQLite first", project_id=alfred.id))
    manager.store(Decision(name="Unrelated", project_id=other.id))
    manager.store(Experiment(name="WAL", project_id=alfred.id))
    manager.store(Device(name="K1 Max"))

    assert {p.name for p in manager.projects()} == {"Alfred", "Other"}
    assert [d.name for d in manager.decisions(alfred.id)] == ["SQLite first"]
    assert [e.name for e in manager.experiments(alfred.id)] == ["WAL"]
    assert [d.name for d in manager.devices()] == ["K1 Max"]
    assert manager.get_as(alfred.id, Device) is None
    assert manager.get_as(alfred.id, Project) == alfred

    pref = manager.set_preference("units", "metric", category="display")
    assert pref.version == 1
    again = manager.set_preference("units", "imperial", category="display")
    assert again.id == pref.id
    assert again.version == 2
    assert again.value == "imperial"
    assert manager.preference("units") == again
    assert manager.preference("missing") is None
    assert [p.key for p in manager.preferences("display")] == ["units"]


def test_manager_search(manager: MemoryManager) -> None:
    manager.store(Decision(name="Backend", rationale="SQLite is zero-dependency"))
    manager.store(Project(name="Alfred"))
    hits = manager.search("zero-dependency")
    assert len(hits) == 1
    assert isinstance(hits[0], Decision)
    assert manager.search("alfred", EntityKind.DECISION) == []


# ─── bus integration ────────────────────────────────────────────────────


def test_manager_emits_bus_events(manager: MemoryManager, bus: EventBus) -> None:
    seen = _collect(bus)
    dev = manager.store(Device(name="K1 Max"))
    manager.update(dev.id, online=True)
    manager.get(dev.id)
    manager.search("k1")
    manager.list_all(EntityKind.DEVICE)
    manager.delete(dev.id)

    types = [e.type for e in seen]
    assert types == [
        EventType.MEMORY_STORE,
        EventType.MEMORY_STORE,
        EventType.MEMORY_RETRIEVE,
        EventType.MEMORY_RETRIEVE,
        EventType.MEMORY_RETRIEVE,
        EventType.MEMORY_DELETE,
    ]
    assert seen[0].payload == {
        "id": dev.id,
        "kind": "device",
        "name": "K1 Max",
        "version": 1,
        "created": True,
    }
    assert seen[1].payload["version"] == 2
    assert seen[1].payload["created"] is False
    assert seen[3].payload == {
        "operation": "search",
        "count": 1,
        "ids": [dev.id],
        "query": "k1",
    }
    assert seen[4].payload["kind"] == "device"
    assert seen[5].payload["id"] == dev.id
    assert all(e.source == "memory_system" for e in seen)


def test_bus_subscribe_specific_and_unsubscribe(bus: EventBus) -> None:
    stores: list[Event] = []
    unsub = bus.subscribe(EventType.MEMORY_STORE, stores.append)
    manager = MemoryManager(InMemoryBackend(), bus=bus)
    manager.store(Project(name="a"))
    manager.list_all()
    assert len(stores) == 1
    unsub()
    manager.store(Project(name="b"))
    assert len(stores) == 1


def test_bus_handler_errors_do_not_break_writes(bus: EventBus) -> None:
    def boom(_e: Event) -> None:
        raise RuntimeError("observer crashed")

    bus.subscribe_all(boom)
    manager = MemoryManager(InMemoryBackend(), bus=bus)
    proj = manager.store(Project(name="resilient"))
    assert manager.get(proj.id) == proj


# ─── persistence across restarts ────────────────────────────────────────


def test_sqlite_memory_survives_restart(tmp_path: Path, bus: EventBus) -> None:
    db = tmp_path / "alfred-memory.db"

    first = MemoryManager(SQLiteBackend(db), bus=bus)
    project = first.store(Project(name="Alfred", goals=["remember things"]))
    printer = first.store(Device(name="K1 Max", device_type="3d-printer"))
    first.update(printer.id, online=True)
    first.update(printer.id, location="Workshop")
    first.set_preference("units", "metric")
    first.close()  # simulate process exit

    second = MemoryManager(SQLiteBackend(db), bus=bus)
    assert second.count() == 3
    assert second.get(project.id) == project
    restored = second.get_as(printer.id, Device)
    assert restored is not None
    assert restored.version == 3
    assert restored.online is True
    assert restored.location == "Workshop"
    assert [h.version for h in second.history(printer.id)] == [1, 2, 3]
    pref = second.preference("units")
    assert pref is not None and pref.value == "metric"
    assert [d.name for d in second.search("workshop")] == ["K1 Max"]
    second.close()


def test_in_memory_backend_forgets_on_restart(bus: EventBus) -> None:
    first = MemoryManager(InMemoryBackend(), bus=bus)
    first.store(Project(name="ephemeral"))
    first.close()
    second = MemoryManager(InMemoryBackend(), bus=bus)
    assert second.count() == 0


def test_sqlite_backend_creates_parent_dirs(tmp_path: Path) -> None:
    be = SQLiteBackend(tmp_path / "nested" / "dir" / "mem.db")
    be.put(Project(name="x").to_record())
    be.close()
    assert (tmp_path / "nested" / "dir" / "mem.db").exists()


# ─── migration ──────────────────────────────────────────────────────────


def test_migrate_in_memory_to_sqlite_keeps_history(tmp_path: Path, bus: EventBus) -> None:
    volatile = MemoryManager(InMemoryBackend(), bus=bus)
    proj = volatile.store(Project(name="Alfred"))
    volatile.update(proj.id, status="paused")
    volatile.store(Device(name="K1 Max"))

    target = SQLiteBackend(tmp_path / "mem.db")
    report = migrate_backend(volatile.backend, target)
    assert (report.entities, report.versions, report.skipped_versions) == (2, 3, 0)

    # Re-running is a no-op thanks to (id, version) idempotency.
    again = migrate_backend(volatile.backend, target)
    assert (again.entities, again.versions, again.skipped_versions) == (2, 0, 3)

    persistent = MemoryManager(target, bus=bus)
    assert [h.version for h in persistent.history(proj.id)] == [1, 2]
    restored = persistent.get_as(proj.id, Project)
    assert restored is not None and restored.status == "paused"
    assert [d.name for d in persistent.search("k1 max")] == ["K1 Max"]
    persistent.close()


def test_snapshot_export_import_round_trip(tmp_path: Path, bus: EventBus) -> None:
    src = MemoryManager(InMemoryBackend(), bus=bus)
    proj = src.store(Project(name="Alfred"))
    src.update(proj.id, description="v2")
    snapshot = tmp_path / "memory.json"
    assert export_snapshot(src.backend, snapshot) == 1

    target = InMemoryBackend()
    report = import_snapshot(snapshot, target)
    assert (report.entities, report.versions) == (1, 2)
    assert target.get(proj.id) == src.backend.get(proj.id)
    assert len(target.history(proj.id)) == 2
    # imported records are searchable (search text is recomputed)
    assert target.search("alfred")[0]["id"] == proj.id


def test_import_rejects_unknown_format(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text('{"format": 99, "entities": []}')
    with pytest.raises(ValueError):
        import_snapshot(bad, InMemoryBackend())


# ─── configuration ──────────────────────────────────────────────────────


def _settings(**overrides: object) -> Settings:
    return Settings(_env_file=None, **overrides)  # type: ignore[call-arg]


def test_default_config_is_in_memory_and_volatile() -> None:
    settings = _settings()
    assert settings.alfred_memory_backend == "memory"
    assert settings.memory_persistence_enabled is False
    assert isinstance(build_backend(settings), InMemoryBackend)


def test_sqlite_config_persists_across_managers(tmp_path: Path, bus: EventBus) -> None:
    db = tmp_path / "cfg.db"
    settings = _settings(alfred_memory_backend="sqlite", alfred_memory_sqlite_path=str(db))
    assert settings.memory_persistence_enabled is True

    m1 = build_memory_manager(settings, bus=bus)
    assert isinstance(m1.backend, SQLiteBackend)
    proj = m1.store(Project(name="configured"))
    m1.close()

    m2 = build_memory_manager(settings, bus=bus)
    assert m2.get(proj.id) == proj
    m2.close()


def test_seed_snapshot_only_imports_into_empty_backend(tmp_path: Path, bus: EventBus) -> None:
    snapshot = tmp_path / "seed.json"
    seed_src = MemoryManager(InMemoryBackend(), bus=bus)
    seeded = seed_src.store(Project(name="from-snapshot"))
    export_snapshot(seed_src.backend, snapshot)

    db = tmp_path / "seeded.db"
    settings = _settings(
        alfred_memory_backend="sqlite",
        alfred_memory_sqlite_path=str(db),
        alfred_memory_seed_snapshot=str(snapshot),
    )
    m1 = build_memory_manager(settings, bus=bus)
    assert m1.get(seeded.id) == seeded
    m1.delete(seeded.id)
    m1.store(Project(name="live"))
    m1.close()

    # Backend is non-empty now, so the seed is not re-applied.
    m2 = build_memory_manager(settings, bus=bus)
    assert m2.get(seeded.id) is None
    assert [p.name for p in m2.projects()] == ["live"]
    m2.close()


def test_missing_seed_snapshot_is_ignored(tmp_path: Path, bus: EventBus) -> None:
    settings = _settings(
        alfred_memory_backend="memory", alfred_memory_seed_snapshot=str(tmp_path / "nope.json")
    )
    m = build_memory_manager(settings, bus=bus)
    assert m.count() == 0
