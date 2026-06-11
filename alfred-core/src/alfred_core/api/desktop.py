"""Desktop integration — voice-driven URL opening + whitelisted file
browsing.

Scope is intentionally narrow:

  - ``POST /api/desktop/open-url`` — open a URL on the host's default
    browser via ``xdg-open`` / ``open`` / ``start``. The host is
    assumed to be the same machine the user is sitting at; this
    endpoint is useless when Alfred runs on a different box.

  - ``GET /api/desktop/files/list?path=…`` — list files inside one of
    the user's whitelisted directories. Path traversal is rejected.
    Symlinks are NOT followed outside the whitelist.

  - ``GET /api/desktop/files/read?path=…`` — return up to 64 KB of
    text from a whitelisted file. Binary files refuse cleanly.

What this is NOT:
  - Arbitrary command execution. Don't add it.
  - Arbitrary file write. Workshop endpoint exists for code edits.
  - Anything outside ``ALFRED_ALLOWED_DIRS`` from ``.env``.

Security model: the whitelist comes from env. If the env var is
empty, the file endpoints refuse with 409 (not configured). The
URL endpoint always works because there's nothing user-data
sensitive about opening a URL — at worst a phishing site is
opened, which the user will see immediately.
"""

from __future__ import annotations

import os
import shlex
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from alfred_core.config import Settings, get_settings

router = APIRouter(prefix="/api/desktop", tags=["desktop"])

_MAX_READ_BYTES = 64 * 1024
_MAX_LIST_ENTRIES = 200


# ─── Schemas ──────────────────────────────────────────────────────────


class OpenUrlRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)


class OpenUrlResponse(BaseModel):
    opened: bool
    url: str


class FileEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    size_bytes: int
    modified_ts: float


class FileListResponse(BaseModel):
    path: str
    entries: list[FileEntry]
    truncated: bool


class FileReadResponse(BaseModel):
    path: str
    content: str
    truncated: bool


# ─── Helpers ──────────────────────────────────────────────────────────


def _allowed_dirs(settings: Settings) -> list[Path]:
    """Resolve the env-configured whitelist into absolute Paths.

    Empty / missing entries are dropped. Non-existent paths are kept
    (user might mount them later) but listing under them will fail
    with a normal "not a directory" error from the OS.
    """
    raw = (getattr(settings, "alfred_allowed_dirs", "") or "").strip()
    if not raw:
        return []
    out: list[Path] = []
    for part in raw.split(","):
        clean = part.strip()
        if not clean:
            continue
        # Expand ~ and env vars so users can write ``~/Documents``
        # in .env without the literal string getting stored.
        expanded = os.path.expanduser(os.path.expandvars(clean))
        out.append(Path(expanded).resolve())
    return out


def _resolve_within_whitelist(target: str, whitelist: list[Path]) -> Path:
    """Resolve ``target`` and ensure it sits inside ``whitelist``.

    Refuses path traversal (``..`` segments that escape the
    whitelist), absolute paths outside the whitelist, and any
    symlink that would resolve outside the whitelist. Always
    returns a fully-resolved absolute Path.
    """
    if not whitelist:
        raise HTTPException(
            status_code=409,
            detail=(
                "File access isn't configured. Set ALFRED_ALLOWED_DIRS "
                "in .env (comma-separated paths)."
            ),
        )
    cleaned = target.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="path is required.")
    cleaned = os.path.expanduser(os.path.expandvars(cleaned))
    candidate = Path(cleaned).resolve()
    for allowed in whitelist:
        try:
            candidate.relative_to(allowed)
            return candidate
        except ValueError:
            continue
    raise HTTPException(
        status_code=403,
        detail="Path is outside the configured whitelist.",
    )


def _validate_url(url: str) -> str:
    """Reject schemes that aren't safe to fire blindly.

    Allowed: http, https, file (only on the local host — file://
    URLs to remote shares are rejected by the OS anyway).
    Rejected: javascript:, data:, about:, anything else.
    """
    parsed = urlparse(url.strip())
    scheme = (parsed.scheme or "").lower()
    if scheme not in {"http", "https", "file"}:
        raise HTTPException(
            status_code=400,
            detail=f"Refusing to open {scheme!r} URL — only http(s) and file allowed.",
        )
    if not parsed.netloc and scheme in {"http", "https"}:
        raise HTTPException(status_code=400, detail="URL has no host.")
    return url.strip()


def _opener_argv(url: str) -> list[str]:
    """Return the platform-appropriate argv for "open this URL"."""
    if sys.platform.startswith("darwin"):
        return ["open", url]
    if sys.platform.startswith("win"):
        # ``start`` is a cmd.exe builtin — has to be invoked through cmd.
        # The empty "" first arg is the window title; without it cmd
        # interprets a quoted URL as the title.
        return ["cmd", "/c", "start", "", url]
    # Linux / BSD: xdg-open is the de-facto standard.
    return ["xdg-open", url]


# ─── Endpoints ────────────────────────────────────────────────────────


@router.post("/open-url", response_model=OpenUrlResponse)
async def open_url(payload: OpenUrlRequest) -> OpenUrlResponse:
    """Open ``payload.url`` on the host's default browser/handler."""
    url = _validate_url(payload.url)
    argv = _opener_argv(url)
    try:
        # We DON'T capture output. The OS handler may take seconds
        # to spawn, and we don't want to block the chat reply.
        # Using shell=False is essential — argv is already split.
        subprocess.Popen(
            argv,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Couldn't find {argv[0]!r} on this host — install xdg-utils "
                f"(Linux) or ensure 'open' / 'start' is on PATH."
            ),
        ) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to launch URL handler: {exc}",
        ) from exc
    return OpenUrlResponse(opened=True, url=url)


@router.get("/files/list", response_model=FileListResponse)
async def list_files(
    path: str = Query(..., min_length=1),
    settings: Settings = Depends(get_settings),
) -> FileListResponse:
    """List files in ``path``, restricted to the whitelist."""
    whitelist = _allowed_dirs(settings)
    target = _resolve_within_whitelist(path, whitelist)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found.")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory.")
    entries: list[FileEntry] = []
    truncated = False
    try:
        for child in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            if len(entries) >= _MAX_LIST_ENTRIES:
                truncated = True
                break
            try:
                stat = child.stat()
            except OSError:
                continue  # broken symlink, permission denied — skip silently
            entries.append(
                FileEntry(
                    name=child.name,
                    path=str(child),
                    is_dir=child.is_dir(),
                    size_bytes=stat.st_size,
                    modified_ts=stat.st_mtime,
                ),
            )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return FileListResponse(path=str(target), entries=entries, truncated=truncated)


@router.get("/files/read", response_model=FileReadResponse)
async def read_file(
    path: str = Query(..., min_length=1),
    settings: Settings = Depends(get_settings),
) -> FileReadResponse:
    """Return up to 64 KB of UTF-8 text from a whitelisted file."""
    whitelist = _allowed_dirs(settings)
    target = _resolve_within_whitelist(path, whitelist)
    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found.")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file.")
    try:
        raw = target.read_bytes()
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    truncated = len(raw) > _MAX_READ_BYTES
    if truncated:
        raw = raw[:_MAX_READ_BYTES]
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=415,
            detail="File isn't UTF-8 text. Refusing to dump binary.",
        ) from exc
    return FileReadResponse(path=str(target), content=content, truncated=truncated)


@router.get("/whitelist", response_model=list[str])
async def whitelist(settings: Settings = Depends(get_settings)) -> list[str]:
    """Return the currently configured allowed-dir whitelist.

    Used by the frontend to populate the file-browser sidebar with
    legitimate roots so the user knows where they can navigate to.
    """
    return [str(p) for p in _allowed_dirs(settings)]


class DiagnosticEntry(BaseModel):
    """Per-directory status used by the frontend toast / chat hint
    when a file request goes sideways. ``exists`` distinguishes the
    "user forgot to mount the host volume into the container" case
    (path is configured but doesn't exist inside the container) from
    "directory simply isn't readable". Both lead the user to the
    docker-compose edit, but the messages differ."""

    path: str
    exists: bool
    is_dir: bool
    readable: bool


class DiagnosticResponse(BaseModel):
    configured: bool
    in_container: bool
    entries: list[DiagnosticEntry]
    fix_hint: str


@router.get("/diagnostics", response_model=DiagnosticResponse)
async def diagnostics(
    settings: Settings = Depends(get_settings),
) -> DiagnosticResponse:
    """Return a per-path status of the configured whitelist so the
    user can debug "Alfred can't read my files" without trial-and-
    error. Specifically distinguishes:

      - Empty whitelist (env var not set)
      - Whitelist set but path doesn't exist (user didn't mount the
        host volume into the container — extremely common pitfall
        for first-time Docker users)
      - Whitelist set, path exists, but isn't readable (permission)
    """
    in_container = os.path.exists("/.dockerenv")
    whitelist_paths = _allowed_dirs(settings)
    entries: list[DiagnosticEntry] = []
    for p in whitelist_paths:
        exists = p.exists()
        is_dir = exists and p.is_dir()
        readable = is_dir and os.access(p, os.R_OK)
        entries.append(
            DiagnosticEntry(
                path=str(p),
                exists=exists,
                is_dir=is_dir,
                readable=readable,
            ),
        )
    configured = len(entries) > 0
    if not configured:
        fix_hint = (
            "Set ALFRED_ALLOWED_DIRS in .env to a comma-separated list "
            "of host paths Alfred is allowed to read, e.g. "
            "'/host/Documents,/host/Downloads'. Inside Docker you must "
            "ALSO bind-mount those host folders into the alfred-core "
            "service in docker-compose.yml — for example add: "
            "'- ~/Documents:/host/Documents:ro' under the volumes "
            "section. Then run docker compose up -d --build."
        )
    elif in_container and any(not e.exists for e in entries):
        missing = ", ".join(e.path for e in entries if not e.exists)
        fix_hint = (
            f"Configured paths exist in .env but aren't visible inside the "
            f"alfred-core Docker container: {missing}. Add bind mounts to "
            f"docker-compose.yml under the alfred-core service's "
            f"'volumes:' block (e.g. '- ~/Documents:/host/Documents:ro') "
            f"and update ALFRED_ALLOWED_DIRS to match. Then run "
            f"'docker compose up -d --build'."
        )
    elif any(not e.readable for e in entries):
        bad = ", ".join(e.path for e in entries if not e.readable)
        fix_hint = (
            f"Paths exist but Alfred can't read them: {bad}. "
            f"Check that the directories are readable (chmod 755) and "
            f"that the bind mount isn't using a read-only flag the "
            f"alfred-core container's user can't traverse."
        )
    else:
        fix_hint = "All configured directories are readable."
    return DiagnosticResponse(
        configured=configured,
        in_container=in_container,
        entries=entries,
        fix_hint=fix_hint,
    )


# ``shlex`` import kept above for downstream extensions; appease ruff.
_ = shlex
