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
- ``POST /workshop/dry-run``        — apply diff to a throwaway worktree,
                                      run the project's test suite,
                                      report pass/fail + output. Does
                                      NOT touch the real tree.
- ``POST /workshop/apply``          — apply a unified diff to the
                                      filesystem (after user approval)
- ``GET  /workshop/git-status``     — branch, remote, dirty files
- ``POST /workshop/commit-push``    — commit allowlisted dirty files,
                                      optionally to a fresh
                                      ``alfred/<id>`` branch instead
                                      of the current branch, then push

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
import shutil
import subprocess
import tempfile
import uuid
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
    return subprocess.run(
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
    # Branching strategy. ``current`` commits to the current branch
    # (legacy behaviour). ``alfred-pr`` creates a fresh
    # ``alfred/<short-id>`` branch off HEAD before committing, pushes
    # that, and surfaces a hint URL the user can use to open a PR
    # — so Alfred's self-fixes never land on main without review.
    branch_strategy: str = "current"  # "current" | "alfred-pr"
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
    # Populated when ``branch_strategy="alfred-pr"`` and the push went
    # through — the branch the commit landed on, plus a best-effort
    # GitHub compare URL the user can click to open a PR.
    branch: str = ""
    pr_url: str = ""


@router.post("/commit-push", response_model=CommitPushReply)
async def commit_and_push(req: CommitPushRequest) -> CommitPushReply:
    """Commit allowlisted working-tree changes as Alfred + push to
    origin. Refuses to run if the tree is clean or if there's nothing
    inside the allowlist to commit."""
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Commit message is empty.")
    if req.branch_strategy not in ("current", "alfred-pr"):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unknown branch_strategy {req.branch_strategy!r}. "
                "Expected 'current' or 'alfred-pr'."
            ),
        )

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

    # Branch strategy = "alfred-pr": create a fresh ``alfred/<short-id>``
    # branch BEFORE adding/committing, so the commit lands on a
    # branch the user can review on GitHub instead of on main. We
    # use ``checkout -b`` which moves working-tree changes onto the
    # new branch atomically — no risk of staging changes on the wrong
    # branch if the user fat-fingers the request.
    branch_name = ""
    if req.branch_strategy == "alfred-pr":
        branch_name = f"alfred/{uuid.uuid4().hex[:8]}"
        new_branch = _git_run("checkout", "-b", branch_name)
        if new_branch.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=(
                    f"Failed to create branch {branch_name!r}:\n"
                    f"{new_branch.stderr.strip()}"
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
            branch=branch_name,
        )

    sha_res = _git_run("rev-parse", "HEAD")
    sha = sha_res.stdout.strip() if sha_res.returncode == 0 else ""

    # Resolve the actual current branch — for ``current`` strategy this
    # is whatever we were already on, for ``alfred-pr`` it's the
    # freshly-created one.
    cur_branch_res = _git_run("rev-parse", "--abbrev-ref", "HEAD")
    cur_branch = cur_branch_res.stdout.strip() if cur_branch_res.returncode == 0 else ""

    if req.skip_push:
        return CommitPushReply(
            committed=True,
            pushed=False,
            commit_sha=sha,
            files_committed=to_add,
            detail=(
                f"Committed {len(to_add)} file(s) as {sha[:7]} on "
                f"{cur_branch} — push skipped per request."
            ),
            branch=cur_branch if branch_name else "",
        )

    # For alfred-pr we set the upstream too so subsequent pushes from
    # the same branch don't need ``-u``.
    push_args = ["push"]
    if req.branch_strategy == "alfred-pr":
        push_args += ["-u", "origin", cur_branch]
    else:
        push_args += ["origin", "HEAD"]
    push = _git_run(*push_args)
    if push.returncode != 0:
        return CommitPushReply(
            committed=True,
            pushed=False,
            commit_sha=sha,
            files_committed=to_add,
            detail=(
                f"Committed {sha[:7]} locally on {cur_branch}, but push failed:\n"
                f"{push.stderr.strip() or push.stdout.strip()}\n\n"
                "Fix the git remote auth on the host (deploy key / PAT) "
                "and re-run the push manually, or set up the remote "
                "correctly and try again."
            ),
            branch=cur_branch if branch_name else "",
        )

    pr_url = ""
    if req.branch_strategy == "alfred-pr":
        # Best-effort GitHub PR-compose URL. Not every remote is
        # GitHub-shaped — we only emit a URL when the remote looks
        # like one. Anything else (Gitea, GitLab, raw SSH path) gets
        # an empty string and the frontend just hides the link.
        remote_res = _git_run("remote", "get-url", "origin")
        if remote_res.returncode == 0:
            origin = remote_res.stdout.strip()
            owner_repo = _github_owner_repo(origin)
            if owner_repo:
                pr_url = (
                    f"https://github.com/{owner_repo}/pull/new/{cur_branch}"
                )

    return CommitPushReply(
        committed=True,
        pushed=True,
        commit_sha=sha,
        files_committed=to_add,
        detail=(
            f"Committed {sha[:7]} on {cur_branch} and pushed "
            f"{len(to_add)} file(s) to origin."
            + (f"\nReview at {pr_url}" if pr_url else "")
        ),
        branch=cur_branch if branch_name else "",
        pr_url=pr_url,
    )


def _github_owner_repo(remote_url: str) -> str:
    """Extract ``<owner>/<repo>`` from any of the three URL shapes
    GitHub supports: ``git@github.com:foo/bar.git``,
    ``https://github.com/foo/bar.git``, ``ssh://git@github.com/foo/bar``.
    Returns empty string if the remote isn't a GitHub URL — used to
    decide whether to surface a ``pull/new/...`` link."""
    if "github.com" not in remote_url:
        return ""
    raw = remote_url
    if raw.startswith("git@github.com:"):
        raw = raw[len("git@github.com:"):]
    elif raw.startswith("https://github.com/"):
        raw = raw[len("https://github.com/"):]
    elif raw.startswith("ssh://git@github.com/"):
        raw = raw[len("ssh://git@github.com/"):]
    else:
        return ""
    if raw.endswith(".git"):
        raw = raw[: -len(".git")]
    return raw.strip("/")


# ─── Dry-run: apply patch + run tests in a throwaway worktree ─────────────


class DryRunRequest(BaseModel):
    """Diff to test, plus the list of test commands to run.

    We keep the test commands on the request rather than baking them
    into the server so different parts of the codebase can run
    different test suites (Python pytest, frontend tsc, eslint, etc.)
    without us hard-coding policy. The frontend defaults to a
    sensible set; advanced users can override per-request.
    """

    diff: str
    # Each entry is a shell-style argv list. We deliberately reject
    # raw shell strings — running ``shell=True`` invites injection
    # bugs even with our trust model. Default = the project's pytest
    # backend tests, which is what almost every patch needs to pass.
    test_commands: list[list[str]] = [
        ["python", "-m", "pytest", "alfred-core/tests", "-q", "--tb=short"],
    ]
    # Hard cap on how long all tests are allowed to take, in seconds.
    # Prevents a runaway test from holding the worktree forever.
    timeout_seconds: int = 180


class DryRunResult(BaseModel):
    applied: bool
    all_passed: bool
    apply_detail: str
    # One per ``test_commands`` entry, in order. Each is the truncated
    # combined stdout+stderr so the user (or the LLM, when this is
    # routed to a self-fix loop) can see exactly what failed.
    command_results: list[dict]


@router.post("/dry-run", response_model=DryRunResult)
async def dry_run(req: DryRunRequest) -> DryRunResult:
    """Apply ``diff`` to a temporary git worktree, run each command
    in ``test_commands``, and report the outcome. The real working
    tree is NEVER touched — worktrees share the repo's git database
    but have an isolated checkout, so this is fast (no full clone)
    and safe (the worktree is removed in a finally).

    The dry-run is the safety net the user asked for: "show me the
    fix passes tests before I click APPLY". When ``all_passed`` is
    true, the frontend can highlight APPLY in green; when it's false,
    the frontend shows the failing test output so the user (or
    Alfred himself, in a future self-fix loop) can iterate."""
    if not req.diff.strip():
        raise HTTPException(status_code=400, detail="Diff is empty.")

    # Same allowlist guard as ``/apply`` — refuse a diff that targets
    # paths we wouldn't let through anyway. Catching it here gives a
    # cleaner error than waiting for ``git apply --check`` inside the
    # worktree to fail.
    for line in req.diff.splitlines():
        if line.startswith("+++ b/"):
            rel = line[len("+++ b/"):].strip()
            if rel == "/dev/null":
                continue
            if Path(rel).name in _READ_ONLY_NAMES:
                raise HTTPException(
                    status_code=403,
                    detail=f"Refusing to dry-run on {rel!r} — read-only.",
                )
            _safe_path(rel)

    work_root = Path(tempfile.mkdtemp(prefix="alfred-workshop-dryrun-"))
    branch_name = f"alfred-dryrun/{uuid.uuid4().hex[:8]}"
    try:
        # Create a worktree pinned to current HEAD on a fresh branch.
        wt = _git_run("worktree", "add", "--detach", str(work_root), "HEAD")
        if wt.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=(
                    "Could not create worktree for dry-run:\n"
                    f"{wt.stderr.strip() or wt.stdout.strip()}"
                ),
            )
        _git_run("checkout", "-b", branch_name, cwd=work_root)

        # Apply the diff inside the worktree. ``--check`` first so we
        # report a malformed diff cleanly without partial application.
        check = _git_run("apply", "--check", "-", cwd=work_root, input_text=req.diff)
        if check.returncode != 0:
            return DryRunResult(
                applied=False,
                all_passed=False,
                apply_detail=(
                    "git apply --check failed in worktree:\n"
                    f"{check.stderr.strip()}"
                ),
                command_results=[],
            )
        real = _git_run("apply", "-", cwd=work_root, input_text=req.diff)
        if real.returncode != 0:
            return DryRunResult(
                applied=False,
                all_passed=False,
                apply_detail=f"git apply failed:\n{real.stderr.strip()}",
                command_results=[],
            )

        # Run each test command sequentially. We bail on the first
        # failure to keep the response time low — if the unit tests
        # already failed, running the slower frontend lint is wasted
        # work. The user can re-trigger after fixing the unit tests.
        results: list[dict] = []
        all_ok = True
        per_cmd_timeout = max(15, req.timeout_seconds // max(len(req.test_commands), 1))
        for cmd in req.test_commands:
            if not cmd:
                continue
            try:
                proc = subprocess.run(
                    cmd,
                    cwd=work_root,
                    capture_output=True,
                    text=True,
                    timeout=per_cmd_timeout,
                )
                # Truncate huge outputs to keep payloads sane.
                tail = (proc.stdout + proc.stderr)[-8000:]
                results.append(
                    {
                        "command": cmd,
                        "returncode": proc.returncode,
                        "output": tail,
                        "passed": proc.returncode == 0,
                    }
                )
                if proc.returncode != 0:
                    all_ok = False
                    break
            except subprocess.TimeoutExpired:
                results.append(
                    {
                        "command": cmd,
                        "returncode": -1,
                        "output": (
                            f"timeout after {per_cmd_timeout}s — abort"
                        ),
                        "passed": False,
                    }
                )
                all_ok = False
                break

        return DryRunResult(
            applied=True,
            all_passed=all_ok,
            apply_detail="patch applied to dry-run worktree",
            command_results=results,
        )
    finally:
        # Worktree cleanup. ``git worktree remove`` is idempotent.
        # ``shutil.rmtree`` is the belt-and-braces for the rare case
        # where the worktree got into a weird state and ``remove``
        # refused. We never want a leaked worktree.
        try:
            _git_run("worktree", "remove", "--force", str(work_root))
        except Exception:
            pass
        if work_root.exists():
            shutil.rmtree(work_root, ignore_errors=True)


# ─── Voice-driven self-fix routing helper ─────────────────────────────────


class SelfFixHintRequest(BaseModel):
    """Free-text problem description from the user (typically spoken).
    The handler returns the same problem statement plus a list of
    candidate files Alfred should read — chosen by keyword match
    against an internal registry. The frontend uses this to
    pre-populate the Workshop view when the user says "Alfred, fix
    the X" without having to know which files matter.
    """

    problem: str


class SelfFixHintReply(BaseModel):
    problem: str
    paths: list[str]
    matched_topic: str


# Topic → candidate-files map. Each entry is "say X to make Alfred
# look at these files". Add to this list as new subsystems get added.
_SELF_FIX_TOPICS: tuple[tuple[tuple[str, ...], str, list[str]], ...] = (
    (
        ("radial", "menu", "orb"),
        "radial-menu",
        [
            "alfred-web/src/components/RadialMenu.tsx",
            "alfred-web/src/components/Orb3D.tsx",
            "alfred-web/src/components/ChatWindow.tsx",
        ],
    ),
    (
        ("spotify", "music", "audio", "eq"),
        "spotify",
        [
            "alfred-web/src/components/Spotify3DView.tsx",
            "alfred-core/src/alfred_core/api/spotify.py",
        ],
    ),
    (
        ("workout", "form", "coach", "pose"),
        "workout",
        [
            "alfred-web/src/components/WorkoutTabView.tsx",
            "alfred-core/src/alfred_core/vision/workout_coach.py",
        ],
    ),
    (
        ("chat", "conversation", "message", "reply"),
        "chat",
        [
            "alfred-web/src/components/ChatWindow.tsx",
            "alfred-core/src/alfred_core/api/chat.py",
            "alfred-core/src/alfred_core/router.py",
        ],
    ),
    (
        ("voice", "wake", "hands", "listen", "mic", "speech"),
        "voice",
        [
            "alfred-web/src/components/Composer.tsx",
            "alfred-web/src/components/HandsFreeOverlay.tsx",
            "alfred-web/src/lib/useWakeWord.ts",
            "alfred-core/src/alfred_core/api/voice.py",
        ],
    ),
    (
        ("vitals", "diagnostic", "health"),
        "vitals",
        [
            "alfred-web/src/components/VitalsPanel.tsx",
            "alfred-core/src/alfred_core/api/vitals.py",
        ],
    ),
    (
        ("workshop", "self", "patch", "diff", "code"),
        "workshop",
        [
            "alfred-web/src/components/WorkshopView.tsx",
            "alfred-core/src/alfred_core/api/workshop.py",
        ],
    ),
    (
        ("camera", "face", "recognition", "nightfall"),
        "vision",
        [
            "alfred-web/src/components/CameraPreview.tsx",
            "alfred-web/src/lib/useFaceIdentity.ts",
            "alfred-core/src/alfred_core/api/vision.py",
        ],
    ),
    (
        ("hud", "widget", "layout", "earth"),
        "hud-layout",
        [
            "alfred-web/src/components/ChatWindow.tsx",
            "alfred-web/src/components/HudWidget.tsx",
            "alfred-web/src/lib/hudLayout.ts",
        ],
    ),
    (
        ("auth", "login", "password", "session"),
        "auth",
        [
            "alfred-core/src/alfred_core/api/auth.py",
            "alfred-web/src/lib/AuthContext.tsx",
            "alfred-web/src/components/LoginGate.tsx",
        ],
    ),
)


@router.post("/self-fix-hint", response_model=SelfFixHintReply)
async def self_fix_hint(req: SelfFixHintRequest) -> SelfFixHintReply:
    """Match the user's "Alfred, fix the X" utterance against the
    topic registry and return candidate files. When nothing matches
    we fall back to the broadest-impact files (chat + workshop) so
    Alfred can still do *something* with the request rather than
    refusing.

    This is intentionally a thin endpoint — keyword matching, no LLM
    call. The actual fix is a follow-up POST to ``/diagnose`` with
    these paths. Splitting the two means the frontend can pop the
    Workshop view immediately on voice intent without waiting for an
    LLM round-trip.
    """
    text = req.problem.lower()
    if not text.strip():
        raise HTTPException(status_code=400, detail="Problem statement is empty.")
    best: tuple[int, str, list[str]] | None = None
    for keywords, topic, paths in _SELF_FIX_TOPICS:
        score = sum(1 for k in keywords if k in text)
        if score > 0 and (best is None or score > best[0]):
            best = (score, topic, paths)
    if best is None:
        return SelfFixHintReply(
            problem=req.problem,
            paths=[
                "alfred-web/src/components/ChatWindow.tsx",
                "alfred-core/src/alfred_core/api/chat.py",
                "alfred-core/src/alfred_core/api/workshop.py",
            ],
            matched_topic="generic",
        )
    return SelfFixHintReply(
        problem=req.problem, paths=best[2], matched_topic=best[1]
    )
