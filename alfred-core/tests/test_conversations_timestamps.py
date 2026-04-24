"""Sidebar timestamp normalization."""

from __future__ import annotations

from datetime import UTC, datetime

from alfred_core.api.conversations import _as_utc


def test_naive_datetime_is_tagged_as_utc() -> None:
    naive = datetime(2026, 4, 24, 19, 36, 50)
    aware = _as_utc(naive)
    assert aware.tzinfo is not None
    assert aware.utcoffset().total_seconds() == 0
    assert aware.replace(tzinfo=None) == naive


def test_aware_datetime_is_converted_to_utc() -> None:
    eastern = datetime(2026, 4, 24, 15, 36, 50, tzinfo=UTC).astimezone(
        UTC
    )
    converted = _as_utc(eastern)
    assert converted.tzinfo is UTC
    assert converted == eastern


def test_none_passes_through_as_none() -> None:
    assert _as_utc(None) is None


def test_serialised_iso_includes_offset() -> None:
    naive = datetime(2026, 4, 24, 19, 36, 50)
    iso = _as_utc(naive).isoformat()
    assert iso.endswith("+00:00")
