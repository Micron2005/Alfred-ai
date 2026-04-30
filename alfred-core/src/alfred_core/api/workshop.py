"""Workshop — Alfred's self-coding console.

Lets Alfred (and the user, via the HUD) inspect and modify Alfred's
own source tree. The workflow the user asked for is:

  user: "Alfred, the radial menu's Spotify icon doesn't pulse on the
         beat — fix it."
  alfred: reads the relevant frontend file via this API, drafts a
          patch, returns it as a unified diff, and explains the
          change. The user reviews and applies via a dedicated
          frontend panel (or accepts in-place).

Endpoints
---------
- ``GET /workshop/files``           — list relevant source files
- ``GET /workshop/file?path=...``   — read one file's contents
- ``POST /workshop/diagnose``       — ask the LLM to analyse a problem,
                                      get back an explanation + a
                                      proposed unified-diff patch
- ``POST /workshop/apply``          — apply a unified diff to the
                                      filesystem (after user approval)

Safety
------
The filesystem is restricted to a hard-coded allowlist of project
directories — no escaping the repo, no /etc, no /. Patches are
validated to touch only allowed paths before being applied. The
endpoints are intentionally NOT exposed publicly — they're behind
the same Tailscale-only deployment as the rest of Alfred.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from alfred_core.config import Settings, get_settings
from alfred_core.llm.base import ChatMessage
from alfred_core.router import Router

router = APIRouter(prefix="/workshop", tags=["workshop"])

# Repo root inside the container. The Dockerfile bind-mounts the host
# repo here, so writes from this endpoint persist on the host. Set via
# env so a different layout can override.
_REPO_ROOT = Path(os.environ.get("ALFRED_REPO_ROOT", "/app")).resolve()

# Subtrees Alfred is allowed to read & modify. Everything else is
# off-limits — Alfred will not touch ``.git``, ``node_modules``,
# secrets in ``.env``, or anything outside these.
_ALLOWED_DIRS = (
    "alfred-core/src",
    "alfred-core/tests",
    "alfred-web/src",
    "docs",
    "scripts",
)

# Files that are safe to read but NEVER write. Belt-and-braces against
# a misbehaving model trying to rewrite something it shouldn't.
_READ_ONLY_NAMES = frozenset({".env", ".env.local", ".env.example"})

# Hard cap on file size we'll return — pathological 10MB JSONs would
# blow the LLM's context window and hammer the network.
_MAX_FILE_BYTES = 200_000


def _safe_path(rel: str) -> Path:
    """Resolve a relative path under the repo root, refusing escapes.

    Raises ``HTTPException(400)`` if the path is outside the allowlist
    or tries to traverse with ``..``. The check is done by resolving
    BOTH the candidate and the allowed root, then ensuring the
    resolved candidate is a child of an allowed subtree.
    """
    if not rel or rel.startswith("/"):
        raise HTTPException(status_code=400, detail="Path must be relative.")
    candidate = (_REPO_ROOT / rel).resolve()
    try:
        candidate.relative_to(_REPO_ROOT)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail="Path is outside the repository.",
        ) from exc
    rel_str = candidate.relative_to(_REPO_ROOT).as_posix()
    if not any(
        rel_str == d or rel_str.startswith(f"{d}/") for d in _ALLOWED_DIRS
    ):
        raise HTTPException(
            status_code=403,
            detail=(
                f"Path {rel_str!r} is outside the workshop allowlist "
                f"({', '.join(_ALLOWED_DIRS)})."
            ),
        )
    return candidate


class FileEntry(BaseModel):
    path: str
    size: int


class FileList(BaseModel):
    files: list[FileEntry]


@router.get("/files", response_model=FileList)
async def list_files() -> FileList:
    """Walk the allowed subtrees and return every source file.

    We deliberately filter out heavy generated trees (``node_modules``,
    ``.next``, ``__pycache__``, etc.) so the list stays useful. The
    intent is "files Alfred might want to reason about", not a full
    filesystem dump.
    """
    out: list[FileEntry] = []
    skip_dirs = {
        "node_modules",
        ".next",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".git",
        "dist",
        "build",
        ".venv",
    }
    for d in _ALLOWED_DIRS:
        base = _REPO_ROOT / d
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            if any(part in skip_dirs for part in p.parts):
                continue
            try:
                size = p.stat().st_size
            except OSError:
                continue
            if size > _MAX_FILE_BYTES:
                continue
            out.append(
                FileEntry(
                    path=p.relative_to(_REPO_ROOT).as_posix(),
                    size=size,
                )
            )
    out.sort(key=lambda e: e.path)
    return FileList(files=out)


class FileContent(BaseModel):
    path: str
    content: str
    size: int


@router.get("/file", response_model=FileContent)
async def read_file(path: str) -> FileContent:
    p = _safe_path(path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"File {path!r} not found.")
    size = p.stat().st_size
    if size > _MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"File is {size} bytes, larger than the workshop "
                f"limit of {_MAX_FILE_BYTES}."
            ),
        )
    try:
        content = p.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=415,
            detail="File isn't text (or isn't UTF-8); workshop won't open it.",
        ) from exc
    return FileContent(path=path, content=content, size=size)


class DiagnoseRequest(BaseModel):
    """User's description of a problem + the files Alfred should read.

    The frontend collects the problem statement and a small list of
    candidate files (typically chosen by the user from the file list,
    but eventually we can have Alfred pick them himself). Each file's
    contents are fetched server-side and stitched into the prompt
    rather than asking the user to copy-paste.
    """

    problem: str
    paths: list[str] = []


class DiagnoseReply(BaseModel):
    explanation: str
    backend: str
    model: str


_DIAGNOSE_SYSTEM = (
    "You are Alfred, performing self-maintenance on your own source code.\n"
    "Your user has reported a problem. Your job is to:\n"
    "  1. Read the attached file excerpts.\n"
    "  2. Diagnose the actual root cause — not a surface symptom.\n"
    "  3. Propose a SPECIFIC fix as a unified diff (```diff fenced code block).\n"
    "  4. Explain in plain English what changed and why.\n\n"
    "Rules:\n"
    "  - One coherent diff. Multiple files in the diff is fine; multiple\n"
    "    independent diffs is not.\n"
    "  - Use the standard ``--- a/<path>`` / ``+++ b/<path>`` headers with\n"
    "    paths relative to the repository root.\n"
    "  - Don't rewrite huge swaths of code — minimal change that solves\n"
    "    the problem.\n"
    "  - If you genuinely cannot fix it from what you can see, say so\n"
    "    clearly and tell the user which other files to attach.\n"
    "  - You have a foul mouth in this mode if it helps. No apologies\n"
    "    for being blunt about bad code."
)


@router.post("/diagnose", response_model=DiagnoseReply)
async def diagnose(
    req: DiagnoseRequest,
    settings: Settings = Depends(get_settings),
) -> DiagnoseReply:
    """Pull the requested files, send everything to the LLM, return its
    diagnosis + diff. Routing through ``Router`` means coding-flagged
    turns land on Anthropic Claude when configured (better at code),
    falling back to local Ollama otherwise.
    """
    if not req.problem.strip():
        raise HTTPException(status_code=400, detail="Problem statement is empty.")

    # Read each file with the same safety net as ``read_file``.
    excerpts: list[str] = []
    for path in req.paths[:12]:  # cap at 12 files / turn — sane upper bound
        try:
            p = _safe_path(path)
        except HTTPException as exc:
            excerpts.append(f"--- {path}\n[error: {exc.detail}]")
            continue
        if not p.is_file():
            excerpts.append(f"--- {path}\n[error: not found]")
            continue
        if p.stat().st_size > _MAX_FILE_BYTES:
            excerpts.append(f"--- {path}\n[error: file too large]")
            continue
        try:
            body = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            excerpts.append(f"--- {path}\n[error: binary file]")
            continue
        excerpts.append(f"--- {path}\n```\n{body}\n```")

    user_msg = (
        f"Problem reported by the user:\n{req.problem.strip()}\n\n"
        + "\n\n".join(excerpts)
        + "\n\nRespond with the diagnosis and a unified-diff patch."
    )

    llm_router = Router.from_settings(settings)
    msgs = [
        ChatMessage(role="system", content=_DIAGNOSE_SYSTEM),
        ChatMessage(role="user", content=user_msg),
    ]
    reply = await llm_router.complete(msgs)
    return DiagnoseReply(
        explanation=reply.content,
        backend=reply.backend or "",
        model=reply.model or "",
    )


class ApplyRequest(BaseModel):
    """Unified diff to apply, plus an idempotency token.

    The frontend should always show the diff to the user and require
    an explicit click before POSTing here. We deliberately don't let
    the LLM apply patches directly — there's a human in the loop.
    """

    diff: str


class ApplyReply(BaseModel):
    applied: bool
    detail: str
    files_touched: list[str] = []


def _git_run(
    *args: str, cwd: Path | None = None, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
    """Wrapper around ``git`` that captures stdout/stderr as text and
    enforces a hard timeout. We use this everywhere instead of
    ad-hoc ``subprocess.run`` calls so failures surface consistently."""
    return subprocess.run(  # noqa: S603 — we control all args
        ["git", *args],
        cwd=cwd or _REPO_ROOT,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=60,
    )


@router.post("/apply", response_model=ApplyReply)
async def apply_patch(req: ApplyRequest) -> ApplyReply:
    """Run ``git apply --check`` then ``git apply``, restricted to the
    workshop allowlist. The check pass means we either apply the
    whole diff or none of it — no half-applied state.
    """
    if not req.diff.strip():
        raise HTTPException(status_code=400, detail="Diff is empty.")

    # Pre-flight: parse the diff ourselves to pull out the target
    # files and refuse the call if any path is outside the allowlist
    # or named in ``_READ_ONLY_NAMES``. ``git apply`` would catch some
    # of these but a pre-check gives the user a clearer error.
    targets: list[str] = []
    for line in req.diff.splitlines():
        if line.startswith("+++ b/"):
            rel = line[len("+++ b/"):].strip()
            if rel == "/dev/null":
                continue
            if Path(rel).name in _READ_ONLY_NAMES:
                raise HTTPException(
                    status_code=403,
                    detail=f"Refusing to write {rel!r} — read-only.",
                )
            try:
                _safe_path(rel)
            except HTTPException:
                raise
            targets.append(rel)

    if not targets:
        raise HTTPException(
            status_code=400,
            detail="Diff has no ``+++ b/...`` headers — not a unified diff.",
        )

    # ``git apply --check`` first so we fail fast on a bad diff.
    check = _git_run("apply", "--check", "-", input_text=req.diff)
    if check.returncode != 0:
        return ApplyReply(
            applied=False,
            detail=f"git apply --check failed:\n{check.stderr.strip()}",
        )
    real = _git_run("apply", "-", input_text=req.diff)
    if real.returncode != 0:
        return ApplyReply(
            applied=False,
            detail=f"git apply failed:\n{real.stderr.strip()}",
        )
    return ApplyReply(
        applied=True,
        detail=f"Applied cleanly to {len(targets)} file(s).",
        files_touched=targets,
    )


# ─── Git commit + push ────────────────────────────────────────────────────
#
# After APPLY succeeds, the next natural step is a commit + push to the
# user's fork / origin. Two endpoints:
#
#   GET  /workshop/git-status   — branch, remote, dirty files, last commit.
#                                 Shown to the user so they know what's
#                                 about to ship.
#   POST /workshop/commit-push  — commits the working-tree changes that
#                                 fall inside the allowlist, authored as
#                                 Alfred, and pushes to origin/<branch>.
#
# Safety rails:
#   - Only allowlisted files are added. A stray change to `.env` won't
#     be swept up by accident.
#   - No force-push. No history rewriting. No ``git reset --hard``.
#   - Authentication is whatever the host has configured on the git
#     remote — SSH deploy key, GitHub PAT in a credential helper,
#     etc. We don't touch credentials ourselves.
#   - Every call returns verbose logs so a failing push tells the user
#     exactly what git said.


class GitStatus(BaseModel):
    """Snapshot of the repo the user is about to commit against."""

    branch: str
    remote: str
    ahead: int
    behind: int
    clean: bool
    dirty_files: list[str]
    dirty_files_outside_allowlist: list[str]
    last_commit: str


@router.get("/git-status", response_model=GitStatus)
async def git_status() -> GitStatus:
    branch_res = _git_run("rev-parse", "--abbrev-ref", "HEAD")
    branch = branch_res.stdout.strip() if branch_res.returncode == 0 else "(detached)"

    remote_res = _git_run("remote", "get-url", "origin")
    remote = remote_res.stdout.strip() if remote_res.returncode == 0 else ""

    # Ahead/behind vs upstream — best-effort. No upstream set is not an
    # error, just means we report zeros.
    ahead = behind = 0
    counts = _git_run("rev-list", "--left-right", "--count", "HEAD...@{u}")
    if counts.returncode == 0 and counts.stdout.strip():
        parts = counts.stdout.split()
        if len(parts) == 2:
            ahead, behind = int(parts[0]), int(parts[1])

    status = _git_run("status", "--porcelain")
    raw_lines = [ln for ln in status.stdout.splitlines() if ln.strip()]
    dirty: list[str] = []
    outside: list[str] = []
    for ln in raw_lines:
        # Porcelain format: ``XY <path>`` where X/Y are status flags.
        # Renames are ``XY <from> -> <to>`` — we just split on the
        # first space and take everything after as the (possibly
        # rename) path.
        path_part = ln[3:].strip()
        if " -> " in path_part:
            path_part = path_part.split(" -> ", 1)[1]
        path_part = path_part.strip('"')
        dirty.append(path_part)
        try:
            _safe_path(path_part)
        except HTTPException:
            outside.append(path_part)

    last = _git_run("log", "-1", "--pretty=%h %s")
    last_commit = last.stdout.strip() if last.returncode == 0 else ""

    return GitStatus(
        branch=branch,
        remote=remote,
        ahead=ahead,
        behind=behind,
        clean=len(dirty) == 0,
        dirty_files=dirty,
        dirty_files_outside_allowlist=outside,
        last_commit=last_commit,
    )


class CommitPushRequest(BaseModel):
    message: str
    # When true, do the commit but skip the push. Useful for users on
    # airgapped setups or those who want to review ``git log`` before
    # shipping. When false (default) we commit AND push.
    skip_push: bool = False
    # Author info the commit will carry. Defaults keep a consistent
    # identity for Alfred's self-coding commits, distinct from the
    # user's personal commits.
    author_name: str = "Alfred"
    author_email: str = "alfred@localhost"


class CommitPushReply(BaseModel):
    committed: bool
    pushed: bool
    commit_sha: str
    files_committed: list[str]
    detail: str


@router.post("/commit-push", response_model=CommitPushReply)
async def commit_and_push(req: CommitPushRequest) -> CommitPushReply:
    """Commit allowlisted working-tree changes as Alfred + push to
    origin. Refuses to run if the tree is clean or if there's nothing
    inside the allowlist to commit."""
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Commit message is empty.")

    status = _git_run("status", "--porcelain")
    if status.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"git status failed:\n{status.stderr.strip()}",
        )

    # Figure out which dirty files are inside the allowlist. Anything
    # else gets left untouched — we'd rather commit too little than
    # sweep up a secret.
    to_add: list[str] = []
    for ln in status.stdout.splitlines():
        if not ln.strip():
            continue
        path_part = ln[3:].strip()
        if " -> " in path_part:
            path_part = path_part.split(" -> ", 1)[1]
        path_part = path_part.strip('"')
        try:
            _safe_path(path_part)
        except HTTPException:
            # Outside the allowlist — silently skip. The status
            # endpoint surfaces these so the user knows what was
            # left behind.
            continue
        # Refuse .env even if it lives inside an allowlisted dir.
        if Path(path_part).name in _READ_ONLY_NAMES:
            continue
        to_add.append(path_part)

    if not to_add:
        raise HTTPException(
            status_code=400,
            detail=(
                "Nothing in the allowlist to commit. Run APPLY PATCH first, "
                "or check /workshop/git-status to see what's dirty."
            ),
        )

    add = _git_run("add", "--", *to_add)
    if add.returncode != 0:
        raise HTTPException(
            status_code=500, detail=f"git add failed:\n{add.stderr.strip()}"
        )

    commit_env_args = (
        "-c",
        f"user.name={req.author_name}",
        "-c",
        f"user.email={req.author_email}",
    )
    commit = _git_run(*commit_env_args, "commit", "-m", req.message)
    if commit.returncode != 0:
        return CommitPushReply(
            committed=False,
            pushed=False,
            commit_sha="",
            files_committed=[],
            detail=f"git commit failed:\n{commit.stderr.strip() or commit.stdout.strip()}",
        )

    sha_res = _git_run("rev-parse", "HEAD")
    sha = sha_res.stdout.strip() if sha_res.returncode == 0 else ""

    if req.skip_push:
        return CommitPushReply(
            committed=True,
            pushed=False,
            commit_sha=sha,
            files_committed=to_add,
            detail=(
                f"Committed {len(to_add)} file(s) as {sha[:7]} — push skipped "
                "per request."
            ),
        )

    # ``git push`` picks up whatever credentials the host has
    # configured. We never see or handle them.
    push = _git_run("push", "origin", "HEAD")
    if push.returncode != 0:
        return CommitPushReply(
            committed=True,
            pushed=False,
            commit_sha=sha,
            files_committed=to_add,
            detail=(
                f"Committed {sha[:7]} locally, but push failed:\n"
                f"{push.stderr.strip() or push.stdout.strip()}\n\n"
                "Fix the git remote auth on the host (deploy key / PAT) "
                "and re-run the push manually, or set up the remote "
                "correctly and try again."
            ),
        )
    return CommitPushReply(
        committed=True,
        pushed=True,
        commit_sha=sha,
        files_committed=to_add,
        detail=f"Committed {sha[:7]} and pushed {len(to_add)} file(s) to origin.",
    )
