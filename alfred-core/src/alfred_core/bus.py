"""In-process event bus.

A tiny synchronous publish/subscribe hub that lets subsystems announce
what they are doing without importing one another. Today its only
producer is the persistent-memory subsystem (``alfred_core.memory_system``),
which emits ``MEMORY_STORE`` / ``MEMORY_RETRIEVE`` / ``MEMORY_DELETE``
events; future producers (printer control, smart-home, voice) plug into
the same bus.

Design notes:

* Delivery is synchronous and in-order. Handlers run on the publisher's
  thread, so keep them cheap — spawn a task if you need real work done.
* A misbehaving handler never breaks the publisher: exceptions are
  logged and swallowed so memory writes can't be vetoed by an observer.
* Handlers can subscribe to a specific ``EventType`` or to *every* event
  with ``subscribe_all``. Both return an unsubscribe callable.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

log = logging.getLogger(__name__)


class EventType(StrEnum):
    """Well-known event names. String-valued so they serialise cleanly."""

    MEMORY_STORE = "memory.store"
    MEMORY_RETRIEVE = "memory.retrieve"
    MEMORY_DELETE = "memory.delete"


@dataclass(frozen=True, slots=True)
class Event:
    """A single bus message.

    ``payload`` is free-form but should stay JSON-friendly so events can
    be logged or forwarded over the wire later.
    """

    type: EventType
    payload: dict[str, Any] = field(default_factory=dict)
    source: str = ""
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))


Handler = Callable[[Event], None]
Unsubscribe = Callable[[], None]


class EventBus:
    """Synchronous pub/sub hub. Safe to instantiate per-app or per-test."""

    def __init__(self) -> None:
        self._handlers: dict[EventType, list[Handler]] = defaultdict(list)
        self._global: list[Handler] = []

    def subscribe(self, event_type: EventType, handler: Handler) -> Unsubscribe:
        self._handlers[event_type].append(handler)

        def _unsub() -> None:
            handlers = self._handlers.get(event_type, [])
            if handler in handlers:
                handlers.remove(handler)

        return _unsub

    def subscribe_all(self, handler: Handler) -> Unsubscribe:
        self._global.append(handler)

        def _unsub() -> None:
            if handler in self._global:
                self._global.remove(handler)

        return _unsub

    def publish(self, event: Event) -> None:
        for handler in [*self._handlers.get(event.type, []), *self._global]:
            try:
                handler(event)
            except Exception:  # observers must never break producers
                log.exception("Event handler %r failed for %s", handler, event.type)

    def emit(
        self, event_type: EventType, payload: dict[str, Any] | None = None, *, source: str = ""
    ) -> Event:
        """Convenience wrapper: build an ``Event`` and publish it."""
        event = Event(type=event_type, payload=payload or {}, source=source)
        self.publish(event)
        return event


_default_bus: EventBus | None = None


def get_bus() -> EventBus:
    """Process-wide default bus (lazily created)."""
    global _default_bus
    if _default_bus is None:
        _default_bus = EventBus()
    return _default_bus
