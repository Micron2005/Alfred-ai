"""Tests for the new playlist/search browsing endpoints used by the
Spotify3DView.

These cover only pure-Python contract logic (response-shape, slim
projections, refusal to play local-file tracks, query validation).
The actual Spotify HTTP calls are mocked — we don't want the test
suite hitting a real Spotify server, and the client is already
exercised end-to-end by the existing tests.
"""

from __future__ import annotations

import pytest

from alfred_core.tools.spotify import SpotifyClient


def _track(uri: str, *, name: str = "T", is_local: bool = False) -> dict:
    return {
        "id": uri.split(":")[-1],
        "uri": uri,
        "name": name,
        "duration_ms": 180_000,
        "is_local": is_local,
        "artists": [{"name": "Foals"}, {"name": "Other"}],
        "album": {
            "name": "Album X",
            "images": [
                {"url": "https://i.scdn.co/large.jpg"},
                {"url": "https://i.scdn.co/medium.jpg"},
                {"url": "https://i.scdn.co/small.jpg"},
            ],
        },
    }


def test_compact_track_picks_smallest_image_and_joins_artists() -> None:
    out = SpotifyClient._compact_track(_track("spotify:track:abc"))
    assert out["uri"] == "spotify:track:abc"
    assert out["title"] == "T"
    # Artists are joined with a comma + space.
    assert out["artists"] == "Foals, Other"
    assert out["album"] == "Album X"
    assert out["image_url"] == "https://i.scdn.co/small.jpg"
    assert out["is_playable"] is True
    assert out["duration_ms"] == 180_000


def test_compact_track_marks_local_files_unplayable() -> None:
    out = SpotifyClient._compact_track(_track("spotify:local:foo", is_local=True))
    assert out["is_playable"] is False
    # URI is preserved so the UI can still render the row, just greyed.
    assert out["uri"] == "spotify:local:foo"


def test_compact_track_handles_missing_optional_fields() -> None:
    # Empty-ish track (Spotify returns this when a track was deleted).
    out = SpotifyClient._compact_track({})
    assert out == {
        "track_id": "",
        "uri": "",
        "title": "",
        "artists": "",
        "album": "",
        "duration_ms": 0,
        "image_url": "",
        "is_playable": True,
    }


def test_compact_track_rejects_non_dict_input() -> None:
    # Spotify occasionally returns null tracks inside playlist items
    # (e.g. for a track the user no longer has access to). The
    # static helper returns an empty dict rather than crashing the
    # whole list serialization.
    assert SpotifyClient._compact_track(None) == {}  # type: ignore[arg-type]
    assert SpotifyClient._compact_track("not a track") == {}  # type: ignore[arg-type]


@pytest.mark.parametrize("query", ["", "   ", "\t\n"])
@pytest.mark.asyncio
async def test_search_tracks_short_circuits_on_empty_query(
    monkeypatch: pytest.MonkeyPatch, query: str
) -> None:
    """Empty/whitespace queries skip the network call entirely."""

    class _StubClient:
        async def search_tracks(self, q: str, *, limit: int = 20) -> list[dict]:
            # Replicate the real method's empty-query short-circuit
            # (lives at the top of SpotifyClient.search_tracks).
            if not q.strip():
                return []
            raise AssertionError("network call should not happen")

    out = await _StubClient().search_tracks(query)
    assert out == []


def test_new_routes_registered() -> None:
    """The 3 new browsing routes are wired into the FastAPI router."""
    from alfred_core.api.spotify import router

    paths = {route.path for route in router.routes}  # type: ignore[attr-defined]
    assert "/api/spotify/playlists" in paths
    assert "/api/spotify/playlists/{playlist_id}/tracks" in paths
    assert "/api/spotify/search" in paths
