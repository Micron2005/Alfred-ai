"""Onshape backend for CAD generation (Phase 18b).

Sibling to :mod:`alfred_core.tools.cad` (OpenSCAD). OpenSCAD is fast,
local, and private — ideal for the 90% case. Onshape is the cloud
collaborative path: every generated part lands in a *real* Onshape
document the user can open in a browser, share with teammates, edit
parametrically, export in other formats, and iterate on outside of
Alfred.

Architecture: we don't ask the LLM to speak FeatureScript. OpenSCAD is
the canonical source format Alfred already knows how to author fluently
(Phase 18a), and Onshape happily imports STL meshes. So the flow is:

1. Render the OpenSCAD script locally → STL bytes + PNG preview (reuse
   ``_render_openscad_files`` from ``cad.py``).
2. Create a fresh Onshape document named after the part.
3. Upload the STL as a blob element. Onshape auto-tessellates it into
   a Part Studio on the server side.
4. Return a :class:`CadResult` whose ``document_url`` points at the
   newly-created document, plus the local STL + preview bytes so the
   chat bubble still works offline.

Auth is HMAC-SHA256 (``On`` scheme, per Onshape's docs). We sign every
request manually rather than pulling in the official SDK, to keep the
dependency surface small and the signing logic auditable.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from datetime import UTC, datetime
from email.utils import format_datetime
from typing import TYPE_CHECKING
from urllib.parse import urlencode

import httpx

if TYPE_CHECKING:
    from alfred_core.config import Settings

# Per-request timeout on Onshape REST calls. Onshape's import endpoint
# is the slowest (document is provisioned, then mesh is tessellated);
# 60 s is comfortable in practice. STL-export is faster but we use the
# same cap for consistency.
_HTTP_TIMEOUT_S = 60.0


class OnshapeError(RuntimeError):
    """Onshape API call failed.

    The message is always user-readable (never a raw stack trace) so
    the chat handler can surface it inline as a polite apology.
    """


def _canonical_path(path: str) -> str:
    """Ensure the path used for signing starts with ``/`` and has no query.

    Onshape's signing spec uses the *path only* — query params go in a
    separate slot in the string-to-sign. Strip any accidentally-included
    query so callers that pass a full URL-ish string still sign cleanly.
    """
    if "?" in path:
        path = path.split("?", 1)[0]
    if not path.startswith("/"):
        path = "/" + path
    return path


def _build_auth_headers(
    method: str,
    path: str,
    query: str,
    *,
    access_key: str,
    secret_key: str,
    content_type: str = "",
) -> dict[str, str]:
    """Build the HMAC-SHA256 ``On`` auth headers for one request.

    Implements Onshape's published signing scheme verbatim — the
    string-to-sign is::

        method + \\n + nonce + \\n + date + \\n + content_type + \\n +
        path + \\n + query

    with ``method`` lowercase, ``nonce`` a random 25-char token, ``date``
    in RFC 1123 form, and ``content_type`` blank for GET/DELETE. Anything
    off by a character (including a stray trailing slash in ``path`` or
    extra whitespace) produces a 401 with no useful error, so we're
    extremely deliberate about formatting here.
    """
    # Onshape expects a 25-character alnum nonce. ``secrets.token_urlsafe``
    # gives us URL-safe base64; strip punctuation and truncate. Padding
    # chars never appear in the Onshape-spec range so plain slicing is
    # safe. ``secrets`` (not ``random``) because the nonce is part of
    # the authentication envelope — predictable nonces would let a MITM
    # re-use a captured signature.
    nonce = secrets.token_urlsafe(24).replace("-", "").replace("_", "")[:25]
    # RFC 1123 / HTTP date format ("Mon, 01 Jan 2024 12:34:56 GMT").
    # Onshape checks this against server time (±5 min window) to reject
    # replayed requests, so we must use UTC, not local time.
    date = format_datetime(datetime.now(UTC), usegmt=True)

    method_lower = method.lower()
    # NB: trailing ``\n`` after the query string matters — Onshape's
    # reference Node.js sample appends one ("...path + '\\n' + query +
    # '\\n'..."), and the server-side verifier is byte-exact. Without
    # it every signature is off by one character and every call comes
    # back 401 with no useful diagnostic.
    string_to_sign = (
        f"{method_lower}\n{nonce}\n{date}\n{content_type}\n"
        f"{_canonical_path(path)}\n{query}\n"
    ).lower()
    signature = base64.b64encode(
        hmac.new(
            secret_key.encode("utf-8"),
            string_to_sign.encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).decode("ascii")

    return {
        "Date": date,
        "On-Nonce": nonce,
        "Authorization": f"On {access_key}:HmacSHA256:{signature}",
    }


async def _onshape_request(
    method: str,
    path: str,
    *,
    settings: Settings,
    params: dict[str, str] | None = None,
    json_body: dict[str, object] | None = None,
    files: dict[str, tuple[str, bytes, str]] | None = None,
    form: dict[str, str] | None = None,
) -> httpx.Response:
    """Make a signed request to Onshape's REST API.

    ``params`` is URL query params, ``json_body`` is a JSON payload
    (sets ``Content-Type: application/json``), ``files`` is a multipart
    upload (Onshape's blob-element endpoint needs this for STL import),
    ``form`` is url-encoded form fields that accompany a multipart
    upload. The caller passes at most one of the body variants.
    """
    base_url = settings.alfred_onshape_base_url.rstrip("/")
    access_key = settings.alfred_onshape_access_key.strip()
    secret_key = settings.alfred_onshape_secret_key.strip()
    if not access_key or not secret_key:
        raise OnshapeError(
            "Onshape API keys are not configured — set "
            "ALFRED_ONSHAPE_ACCESS_KEY and ALFRED_ONSHAPE_SECRET_KEY."
        )

    # Serialise the query string the same way httpx will, so the
    # signed query matches what the server actually receives. httpx
    # uses ``urllib.parse.urlencode`` under the hood, so any special
    # characters (spaces, ``&``, ``=``, unicode…) get percent-encoded
    # identically on both sides — otherwise the signed and transmitted
    # strings diverge and the server 401s silently.
    query_string = urlencode(params) if params else ""

    content_type = ""
    if json_body is not None:
        content_type = "application/json"

    headers = _build_auth_headers(
        method,
        path,
        query_string,
        access_key=access_key,
        secret_key=secret_key,
        content_type=content_type,
    )
    headers["Accept"] = "application/vnd.onshape.v1+json"
    if content_type:
        headers["Content-Type"] = content_type

    url = f"{base_url}{_canonical_path(path)}"
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S) as client:
        try:
            response = await client.request(
                method,
                url,
                params=params,
                json=json_body,
                files=files,
                data=form,
                headers=headers,
            )
        except httpx.HTTPError as exc:
            raise OnshapeError(
                f"Onshape request failed ({type(exc).__name__}): {exc}"
            ) from exc

    if response.status_code >= 400:
        # Onshape returns JSON error bodies with ``message`` and
        # ``moreInfoUrl`` fields. Surface ``message`` (which is usually
        # a one-liner like "Invalid API credentials") rather than the
        # full JSON; fall back to status + first 200 chars of body if
        # the response isn't JSON.
        detail: str
        try:
            body = response.json()
            detail = str(body.get("message") or body)
        except ValueError:
            detail = response.text[:200] or f"HTTP {response.status_code}"
        raise OnshapeError(
            f"Onshape API returned {response.status_code}: {detail}"
        )
    return response


async def create_document(name: str, *, settings: Settings) -> tuple[str, str]:
    """Create a new public Onshape document; return ``(doc_id, workspace_id)``.

    Documents are created ``isPublic=False`` (private to the user's
    account) unless the user later shares them via the Onshape UI. This
    matches the principle of least-surprise — nobody expects a chat
    part to be world-readable by default.
    """
    response = await _onshape_request(
        "POST",
        "/api/documents",
        settings=settings,
        json_body={
            "name": name,
            "isPublic": False,
            "description": "Generated by Alfred.",
        },
    )
    data = response.json()
    doc_id = data.get("id")
    default_workspace = data.get("defaultWorkspace") or {}
    workspace_id = default_workspace.get("id")
    if not isinstance(doc_id, str) or not isinstance(workspace_id, str):
        # The only way this fires is if Onshape changes its response
        # envelope — guard explicitly so the error is "we don't understand
        # the response" rather than a confusing KeyError 3 calls down.
        raise OnshapeError(
            "Onshape create-document response was missing id / workspace."
        )
    return doc_id, workspace_id


async def upload_stl_blob(
    *,
    doc_id: str,
    workspace_id: str,
    stl_bytes: bytes,
    filename: str,
    settings: Settings,
) -> str:
    """Upload an STL as a blob element into an Onshape workspace.

    Returns the ``elementId`` of the new blob element. Onshape auto-
    kicks off mesh tessellation in the background; the element is
    usable (downloadable, referenced from Part Studios) immediately.
    """
    # Blob-element import uses multipart/form-data. The signing spec
    # says the request body's content type is part of the signed
    # string-to-sign, which is why we pass ``content_type=""`` to the
    # auth-headers builder — ``httpx`` will fill in the real
    # ``multipart/form-data; boundary=…`` header after we sign. Onshape
    # explicitly documents this asymmetry: the signature only covers
    # the JSON/text content type, never multipart.
    path = f"/api/blobelements/d/{doc_id}/w/{workspace_id}"

    # We must hand-build the headers rather than using the request
    # helper, because we need to include Authorization but let httpx
    # compute Content-Type itself. Same signing rules apply.
    access_key = settings.alfred_onshape_access_key.strip()
    secret_key = settings.alfred_onshape_secret_key.strip()
    headers = _build_auth_headers(
        "POST",
        path,
        "",
        access_key=access_key,
        secret_key=secret_key,
        content_type="",
    )
    headers["Accept"] = "application/vnd.onshape.v1+json"

    url = f"{settings.alfred_onshape_base_url.rstrip('/')}{path}"
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S) as client:
        try:
            response = await client.post(
                url,
                files={"file": (filename, stl_bytes, "application/octet-stream")},
                data={
                    "encodedFilename": filename,
                    # ``translate`` = auto-import into a Part Studio after
                    # upload. Without this the file sits as a raw blob.
                    "translate": "true",
                    "storeInDocument": "true",
                },
                headers=headers,
            )
        except httpx.HTTPError as exc:
            raise OnshapeError(
                f"Onshape blob upload failed ({type(exc).__name__}): {exc}"
            ) from exc

    if response.status_code >= 400:
        try:
            body = response.json()
            detail = str(body.get("message") or body)
        except ValueError:
            detail = response.text[:200] or f"HTTP {response.status_code}"
        raise OnshapeError(
            f"Onshape blob upload returned {response.status_code}: {detail}"
        )

    data = response.json()
    element_id = data.get("id")
    if not isinstance(element_id, str):
        raise OnshapeError(
            "Onshape blob upload response was missing element id."
        )
    return element_id


def document_url(doc_id: str, workspace_id: str, *, settings: Settings) -> str:
    """Build the browser URL a human would use to view the document."""
    base = settings.alfred_onshape_base_url.rstrip("/")
    return f"{base}/documents/{doc_id}/w/{workspace_id}"


async def publish_to_onshape(
    *,
    name: str,
    stl_bytes: bytes,
    settings: Settings,
) -> str:
    """Publish an STL to a new Onshape document; return its browser URL.

    Full round-trip: create document → upload STL → return browser URL.
    Any step failing surfaces as :class:`OnshapeError`; the caller is
    expected to catch that and fold it into a polite chat apology.
    """
    # Onshape document names can't be blank; also strip filesystem-unsafe
    # chars so the name round-trips cleanly in the browser URL bar.
    safe_name = "".join(c for c in name if c.isalnum() or c in "._- ").strip()
    if not safe_name:
        safe_name = "Alfred Part"

    doc_id, workspace_id = await create_document(safe_name, settings=settings)
    filename = f"{safe_name.replace(' ', '_') or 'part'}.stl"
    await upload_stl_blob(
        doc_id=doc_id,
        workspace_id=workspace_id,
        stl_bytes=stl_bytes,
        filename=filename,
        settings=settings,
    )
    return document_url(doc_id, workspace_id, settings=settings)


# Small helper used by tests — expose it so signing can be unit-tested
# without hitting the network. Not part of the public API otherwise.
__all__ = [
    "OnshapeError",
    "_build_auth_headers",
    "create_document",
    "document_url",
    "publish_to_onshape",
    "upload_stl_blob",
]
