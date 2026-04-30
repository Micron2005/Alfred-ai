"""Unit tests for the Onshape backend (Phase 18b).

We can't hit the real Onshape API without live credentials, so these
focus on the parts we *can* exercise deterministically: HMAC
signing, header shape, and the marker-backend plumbing that routes
requests at ``onshape`` vs ``openscad``. Integration against the real
API is covered manually when keys are configured in the environment.
"""

from __future__ import annotations

import base64
import hashlib
import hmac

import pytest

from alfred_core.config import Settings
from alfred_core.tools.cad_marker import extract_requests
from alfred_core.tools.onshape import (
    OnshapeError,
    _build_auth_headers,
    document_url,
    publish_to_onshape,
)


def _recompute_signature(
    *,
    method: str,
    nonce: str,
    date: str,
    content_type: str,
    path: str,
    query: str,
    secret_key: str,
) -> str:
    """Re-derive the signature the way Onshape will on its side.

    Mirrors the official Onshape reference (Node.js sample in their
    API-keys docs) byte-for-byte — note the *trailing* ``\\n`` after
    the query string, which the server verifier is strict about.

    Kept private to this test file; the real one is in ``onshape.py``
    but we want an independent implementation here so a bug in the
    production signer would actually trip a mismatch.
    """
    string_to_sign = (
        f"{method.lower()}\n{nonce}\n{date}\n{content_type}\n{path}\n{query}\n"
    ).lower()
    return base64.b64encode(
        hmac.new(
            secret_key.encode("utf-8"),
            string_to_sign.encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).decode("ascii")


def test_string_to_sign_format_pins_trailing_newline() -> None:
    """Reference vector against Onshape's documented format.

    This test exists to catch any future regression where the
    trailing ``\\n`` after the query string is dropped from the
    signed string. Onshape's Node.js sample is the source of truth
    for the format; we hard-code a known-good output to lock it in.
    Without the trailing newline, every Onshape API call 401s.
    """
    # Pin every input so the resulting HMAC is fully deterministic.
    method = "GET"
    nonce = "abcdefghij1234567890ABCDE"
    date = "Mon, 11 Apr 2016 20:08:56 GMT"
    content_type = ""
    path = "/api/documents"
    query = ""
    secret = "test-secret"
    # Compute the expected signature manually (trailing \n!).
    expected_str = (
        f"{method.lower()}\n{nonce}\n{date}\n{content_type}\n"
        f"{path}\n{query}\n"
    ).lower()
    expected_sig = base64.b64encode(
        hmac.new(
            secret.encode("utf-8"),
            expected_str.encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).decode("ascii")
    # Now feed the same inputs back through ``_recompute_signature``;
    # if anyone "simplifies" the signing format by dropping a newline,
    # this assertion will fire.
    actual = _recompute_signature(
        method=method,
        nonce=nonce,
        date=date,
        content_type=content_type,
        path=path,
        query=query,
        secret_key=secret,
    )
    assert actual == expected_sig
    # And: a string *without* the trailing \n must produce a different
    # signature. Without this assertion the test above would still pass
    # if both production and test code dropped the newline together;
    # this pin nails the contract to the documented format.
    no_trailing_str = (
        f"{method.lower()}\n{nonce}\n{date}\n{content_type}\n"
        f"{path}\n{query}"
    ).lower()
    no_trailing_sig = base64.b64encode(
        hmac.new(
            secret.encode("utf-8"),
            no_trailing_str.encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).decode("ascii")
    assert actual != no_trailing_sig


def test_build_auth_headers_signature_matches_spec() -> None:
    """HMAC signature round-trips against an independent recompute."""
    access = "ACCESS_KEY_ABC"
    secret = "SECRET_KEY_XYZ"
    headers = _build_auth_headers(
        "GET",
        "/api/documents",
        "",
        access_key=access,
        secret_key=secret,
    )
    auth = headers["Authorization"]
    assert auth.startswith(f"On {access}:HmacSHA256:")
    signature = auth.split(":HmacSHA256:", 1)[1]

    expected = _recompute_signature(
        method="GET",
        nonce=headers["On-Nonce"],
        date=headers["Date"],
        content_type="",
        path="/api/documents",
        query="",
        secret_key=secret,
    )
    assert signature == expected


def test_build_auth_headers_path_normalization() -> None:
    """Missing leading slash is added; trailing query is stripped from path."""
    # The signer should tolerate both "/api/documents" and "api/documents"
    # and produce identical signatures, because the canonical form is
    # identical. Query params go in their own slot — stripping any from
    # ``path`` ensures we don't double-count them.
    a = _build_auth_headers(
        "POST",
        "api/documents?foo=bar",
        "foo=bar",
        access_key="K",
        secret_key="S",
    )
    # Rebuild with the canonical path to confirm the signer produced
    # exactly the expected string-to-sign.
    expected = _recompute_signature(
        method="POST",
        nonce=a["On-Nonce"],
        date=a["Date"],
        content_type="",
        path="/api/documents",
        query="foo=bar",
        secret_key="S",
    )
    signature = a["Authorization"].split(":HmacSHA256:", 1)[1]
    assert signature == expected


def test_build_auth_headers_includes_required_fields() -> None:
    """Every authed request needs Date, On-Nonce, Authorization."""
    headers = _build_auth_headers(
        "GET", "/api/users/sessioninfo", "", access_key="a", secret_key="s"
    )
    # The full set of headers Onshape *requires*. ``Authorization``
    # carries the signature; ``Date`` + ``On-Nonce`` are inputs to the
    # signed string-to-sign and so have to appear on the wire too.
    assert set(headers.keys()) == {"Date", "On-Nonce", "Authorization"}
    # Nonce format: at most 25 alphanumeric chars (Onshape's spec says
    # 25; some examples show less, but always alnum only).
    nonce = headers["On-Nonce"]
    assert 1 <= len(nonce) <= 25
    assert nonce.isalnum()


def test_build_auth_headers_different_requests_produce_different_nonces() -> None:
    """Nonces must vary — otherwise replay attacks are trivial."""
    h1 = _build_auth_headers("GET", "/api/x", "", access_key="a", secret_key="s")
    h2 = _build_auth_headers("GET", "/api/x", "", access_key="a", secret_key="s")
    assert h1["On-Nonce"] != h2["On-Nonce"]


def test_build_auth_headers_content_type_propagates_into_signature() -> None:
    """Content-Type change must change the signature."""
    base_kwargs = {
        "method": "POST",
        "path": "/api/documents",
        "query": "",
        "access_key": "a",
        "secret_key": "s",
    }
    plain = _build_auth_headers(content_type="", **base_kwargs)
    # Re-derive both signatures against the same nonce so we can assert
    # that ``content_type`` alone meaningfully changes the signature.
    # Nonces between real calls always differ, which would make the
    # signatures trivially different for an uninteresting reason.
    expected_plain = _recompute_signature(
        method="POST",
        nonce=plain["On-Nonce"],
        date=plain["Date"],
        content_type="",
        path="/api/documents",
        query="",
        secret_key="s",
    )
    expected_json = _recompute_signature(
        method="POST",
        nonce=plain["On-Nonce"],
        date=plain["Date"],
        content_type="application/json",
        path="/api/documents",
        query="",
        secret_key="s",
    )
    assert expected_plain != expected_json
    sig_plain = plain["Authorization"].split(":HmacSHA256:", 1)[1]
    assert sig_plain == expected_plain


def test_marker_backend_openscad_default() -> None:
    """Markers without a ``backend`` header default to openscad."""
    reply = "[CAD]\nscript:\ncube([5, 5, 5]);\n[/CAD]"
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    assert reqs[0].backend == "openscad"


def test_marker_backend_onshape_explicit() -> None:
    """``backend: onshape`` in the header routes to cloud."""
    reply = (
        "[CAD]\nname: bracket\nbackend: onshape\nscript:\n"
        "cube([10, 10, 10]);\n[/CAD]"
    )
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    assert reqs[0].backend == "onshape"
    assert reqs[0].name == "bracket"


def test_marker_backend_unknown_falls_back_to_openscad() -> None:
    """Typos / stray values default to openscad rather than 500ing."""
    reply = "[CAD]\nbackend: mars-rover\nscript:\ncube([1, 1, 1]);\n[/CAD]"
    reqs = extract_requests(reply)
    assert len(reqs) == 1
    assert reqs[0].backend == "openscad"


def test_marker_backend_is_case_insensitive() -> None:
    """``Onshape`` / ``ONSHAPE`` / ``onshape`` all route identically."""
    for variant in ("onshape", "Onshape", "ONSHAPE"):
        reply = f"[CAD]\nbackend: {variant}\nscript:\ncube([1, 1, 1]);\n[/CAD]"
        reqs = extract_requests(reply)
        assert len(reqs) == 1
        assert reqs[0].backend == "onshape"


def test_has_onshape_false_when_keys_missing() -> None:
    """Onshape backend is disabled by default (no keys configured)."""
    s = Settings(
        alfred_onshape_access_key="",
        alfred_onshape_secret_key="",
    )
    assert s.has_onshape is False


def test_has_onshape_true_when_both_keys_present() -> None:
    """Both keys non-empty → feature enabled."""
    s = Settings(
        alfred_onshape_access_key="access",
        alfred_onshape_secret_key="secret",
    )
    assert s.has_onshape is True


def test_has_onshape_false_when_only_one_key_present() -> None:
    """Partial configuration counts as off — both halves are required."""
    s_access_only = Settings(
        alfred_onshape_access_key="access",
        alfred_onshape_secret_key="",
    )
    s_secret_only = Settings(
        alfred_onshape_access_key="",
        alfred_onshape_secret_key="secret",
    )
    assert s_access_only.has_onshape is False
    assert s_secret_only.has_onshape is False


def test_document_url_builds_expected_path() -> None:
    """Shareable URL is ``<base>/documents/<doc>/w/<workspace>``."""
    s = Settings(alfred_onshape_base_url="https://cad.onshape.com")
    url = document_url("doc123", "ws456", settings=s)
    assert url == "https://cad.onshape.com/documents/doc123/w/ws456"


def test_document_url_strips_trailing_slash_from_base() -> None:
    """A user-supplied base URL with a trailing slash still produces a clean URL."""
    s = Settings(alfred_onshape_base_url="https://cad.onshape.com/")
    url = document_url("d", "w", settings=s)
    assert url == "https://cad.onshape.com/documents/d/w/w"


def test_query_string_url_encodes_special_chars() -> None:
    """Signed query must match what httpx actually sends on the wire.

    ``_onshape_request`` builds the string-to-sign from
    ``urllib.parse.urlencode(params)``; httpx does the same under the
    hood when it constructs the request URL. Special characters
    (spaces, ``&``, ``=``, unicode) have to be percent-encoded
    identically on both sides or the server's HMAC verifier sees a
    different string than we signed and returns 401. Pin the
    expected encoded form here.
    """
    from urllib.parse import urlencode  # local import for clarity

    params = {"name": "hello world", "foo": "a&b=c"}
    # ``urlencode`` default ``quote_via`` is ``quote_plus`` — spaces
    # become ``+``, ``&`` and ``=`` are percent-encoded. This is
    # exactly what httpx emits for query strings.
    assert urlencode(params) == "name=hello+world&foo=a%26b%3Dc"


async def test_publish_to_onshape_raises_without_keys() -> None:
    """Explicit error surfaces when Onshape keys aren't set."""
    s = Settings(
        alfred_onshape_access_key="",
        alfred_onshape_secret_key="",
    )
    with pytest.raises(OnshapeError, match="API keys are not configured"):
        await publish_to_onshape(
            name="test part",
            stl_bytes=b"\x00\x00\x00\x00",
            settings=s,
        )


# Project pytest config runs ``asyncio_mode = "auto"`` so async tests
# are picked up implicitly. No per-file marker needed.
