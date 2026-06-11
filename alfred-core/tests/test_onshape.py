"""Tests for the Onshape HMAC signer.

Onshape's signature contract is unforgiving — a single space, case
flip, or missing newline silently produces 401s. These tests pin the
expected signature for a fixed (method, nonce, date, content-type,
path, query, secret) tuple so any future refactor that drifts from
the spec gets caught immediately.

Reference: https://onshape-public.github.io/docs/api-intro/api-signatures/
"""

from __future__ import annotations

import base64
import hashlib
import hmac

import pytest

from alfred_core.tools.onshape import (
    OnshapeClient,
    OnshapeUnconfiguredError,
    build_onshape_client,
)


def _expected_sig(secret: str, signing: str) -> str:
    # Every test's ``signing`` must include the trailing newline —
    # Onshape's canonical signing string is always 7 lines (6 fields
    # + trailing ``\n``).
    return base64.b64encode(
        hmac.new(secret.encode(), signing.encode(), hashlib.sha256).digest()
    ).decode("ascii")


def test_sign_get_no_query() -> None:
    client = OnshapeClient("AK_TEST", "SECRET_TEST")
    sig = client._sign(
        method="GET",
        nonce="ABCDEF1234567890ABCDEF123",
        date="Wed, 30 Apr 2026 18:01:24 GMT",
        content_type="",
        path="/api/v6/documents",
        query="",
    )
    expected = _expected_sig(
        "SECRET_TEST",
        "get\nabcdef1234567890abcdef123\nwed, 30 apr 2026 18:01:24 gmt\n\n/api/v6/documents\n\n",
    )
    assert sig == expected


def test_sign_post_with_body_content_type() -> None:
    client = OnshapeClient("AK_TEST", "SECRET_TEST")
    sig = client._sign(
        method="POST",
        nonce="N0NCE1234567890NONCE12345",
        date="Wed, 30 Apr 2026 18:02:00 GMT",
        content_type="application/json; charset=UTF-8",
        path="/api/v6/documents",
        query="",
    )
    expected = _expected_sig(
        "SECRET_TEST",
        "post\nn0nce1234567890nonce12345\nwed, 30 apr 2026 18:02:00 gmt\napplication/json; charset=utf-8\n/api/v6/documents\n\n",
    )
    assert sig == expected


def test_sign_get_with_sorted_query() -> None:
    client = OnshapeClient("AK_TEST", "SECRET_TEST")
    sig = client._sign(
        method="GET",
        nonce="QU3RY1234567890QU3RY12345",
        date="Wed, 30 Apr 2026 18:03:00 GMT",
        content_type="",
        path="/api/v6/documents",
        query="limit=20&offset=0",
    )
    expected = _expected_sig(
        "SECRET_TEST",
        "get\nqu3ry1234567890qu3ry12345\nwed, 30 apr 2026 18:03:00 gmt\n\n/api/v6/documents\nlimit=20&offset=0\n",
    )
    assert sig == expected


def test_sign_string_has_trailing_newline() -> None:
    """Regression test — the sig must NOT match a signing string
    without the trailing ``\\n``, which was the Feb 2026 bug that
    caused every request to be rejected with 401 "Unauthenticated"."""
    client = OnshapeClient("AK_TEST", "SECRET_TEST")
    sig = client._sign(
        method="GET",
        nonce="N1234567890123456789012345",
        date="Wed, 30 Apr 2026 18:04:00 GMT",
        content_type="",
        path="/api/v6/documents",
        query="",
    )
    # NO trailing newline — simulates the bug.
    buggy = _expected_sig(
        "SECRET_TEST",
        "get\nn1234567890123456789012345\nwed, 30 apr 2026 18:04:00 gmt\n\n/api/v6/documents\n",
    )
    assert sig != buggy, "trailing newline regression — sig matches the buggy form"


def test_nonce_is_25_chars() -> None:
    nonce = OnshapeClient._make_nonce()
    assert len(nonce) == 25
    assert nonce.isascii() and nonce.isalnum()


def test_rfc1123_date_format() -> None:
    import re

    date = OnshapeClient._rfc1123_now()
    # e.g. "Wed, 30 Apr 2026 18:01:24 GMT"
    assert re.match(
        r"^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$",
        date,
    ), date


def test_compact_document_projection() -> None:
    raw = {
        "id": "abc123",
        "name": "Bracket",
        "owner": {"name": "Mukarram"},
        "modifiedAt": "2026-04-30T18:00:00Z",
        "createdAt": "2026-04-29T12:00:00Z",
        "defaultWorkspace": {"id": "ws_xyz"},
        "thumbnail": {"href": "..."},
    }
    out = OnshapeClient._compact_document(raw)
    assert out == {
        "id": "abc123",
        "name": "Bracket",
        "owner": "Mukarram",
        "modified_at": "2026-04-30T18:00:00Z",
        "created_at": "2026-04-29T12:00:00Z",
        "default_workspace_id": "ws_xyz",
        "has_thumbnail": True,
    }


def test_compact_document_handles_missing_fields() -> None:
    out = OnshapeClient._compact_document({})
    assert out == {
        "id": "",
        "name": "",
        "owner": "",
        "modified_at": "",
        "created_at": "",
        "default_workspace_id": "",
        "has_thumbnail": False,
    }


def test_compact_element_carries_doc_and_workspace() -> None:
    raw = {"id": "el1", "name": "Part Studio 1", "elementType": "PARTSTUDIO"}
    out = OnshapeClient._compact_element(
        raw, document_id="doc1", workspace_id="ws1"
    )
    assert out == {
        "id": "el1",
        "name": "Part Studio 1",
        "type": "PARTSTUDIO",
        "document_id": "doc1",
        "workspace_id": "ws1",
    }


class _FakeSettings:
    def __init__(self, access: str = "", secret: str = "") -> None:
        self.alfred_onshape_access_key = access
        self.alfred_onshape_secret_key = secret
        self.alfred_onshape_api_base = "https://cad.onshape.com"


def test_build_client_rejects_missing_keys() -> None:
    with pytest.raises(OnshapeUnconfiguredError):
        build_onshape_client(_FakeSettings())


def test_build_client_with_keys() -> None:
    client = build_onshape_client(_FakeSettings(access="ak", secret="sk"))
    assert isinstance(client, OnshapeClient)


def test_design_router_registered() -> None:
    """The 5 design routes are wired into the FastAPI router."""
    from alfred_core.api.design import router

    paths = {route.path for route in router.routes}  # type: ignore[attr-defined]
    assert "/api/design/status" in paths
    assert "/api/design/documents" in paths
    assert "/api/design/documents/{document_id}" in paths
    assert "/api/design/documents/{document_id}/thumbnail" in paths
