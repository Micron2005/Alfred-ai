"""Integration tests for the workshop self-coding endpoints.

These exercise the actual file IO + path-allowlist enforcement against
a temporary repo tree. The LLM-backed ``/diagnose`` endpoint is tested
with a stubbed Router so we don't need Anthropic / Ollama to be
reachable from CI.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alfred_core.api import workshop
from alfred_core.config import Settings, get_settings
from alfred_core.llm.base import ChatMessage, ChatResponse, LLMBackend
from alfred_core.router import Router


@pytest.fixture
def fake_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Build a tiny throwaway repo tree the workshop can read & write.

    Layout mirrors the real allowlist so the path-traversal guards
    behave the same as in production:

        <tmp>/
          alfred-core/src/alfred_core/api/chat.py     (text, in allowlist)
          alfred-core/tests/test_x.py                 (text, in allowlist)
          alfred-web/src/components/Foo.tsx           (text, in allowlist)
          docs/setup.md                               (text, in allowlist)
          .env                                        (READ-ONLY name)
          secret.txt                                  (outside allowlist)
    """
    (tmp_path / "alfred-core/src/alfred_core/api").mkdir(parents=True)
    (tmp_path / "alfred-core/src/alfred_core/api/chat.py").write_text(
        "def handle_chat():\n    return 'hello'\n"
    )
    (tmp_path / "alfred-core/tests").mkdir(parents=True)
    (tmp_path / "alfred-core/tests/test_x.py").write_text("def test_x(): pass\n")
    (tmp_path / "alfred-web/src/components").mkdir(parents=True)
    (tmp_path / "alfred-web/src/components/Foo.tsx").write_text(
        "export const Foo = () => <div>foo</div>;\n"
    )
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs/setup.md").write_text("# Setup\n")
    (tmp_path / ".env").write_text("SECRET=do-not-touch\n")
    (tmp_path / "secret.txt").write_text("definitely-out-of-bounds\n")
    # Initialise it as a git repo so ``git apply`` can run.
    import subprocess

    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "alfred@test"], cwd=tmp_path, check=True
    )
    subprocess.run(
        ["git", "config", "user.name", "Alfred Test"], cwd=tmp_path, check=True
    )
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "init"], cwd=tmp_path, check=True
    )
    # Re-point the workshop module at this tree. The module captures
    # the path at import time, so we monkeypatch in-place.
    monkeypatch.setattr(workshop, "_REPO_ROOT", tmp_path)
    return tmp_path


def _make_app(settings: Settings) -> FastAPI:
    app = FastAPI()
    app.include_router(workshop.router, prefix="/api")
    app.dependency_overrides[get_settings] = lambda: settings
    return app


@pytest.fixture
def settings() -> Settings:
    return Settings(alfred_password_hash="", alfred_jwt_secret="x" * 64)


def test_list_files_returns_only_allowlisted(
    fake_repo: Path, settings: Settings
) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.get("/api/workshop/files")
        assert r.status_code == 200
        paths = {f["path"] for f in r.json()["files"]}
        # Allowlisted files present
        assert "alfred-core/src/alfred_core/api/chat.py" in paths
        assert "alfred-web/src/components/Foo.tsx" in paths
        assert "docs/setup.md" in paths
        # Out-of-bounds files NOT present
        assert ".env" not in paths
        assert "secret.txt" not in paths


def test_read_file_returns_contents(fake_repo: Path, settings: Settings) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.get(
            "/api/workshop/file",
            params={"path": "alfred-core/src/alfred_core/api/chat.py"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["path"] == "alfred-core/src/alfred_core/api/chat.py"
        assert "handle_chat" in body["content"]


def test_read_file_refuses_path_traversal(
    fake_repo: Path, settings: Settings
) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.get("/api/workshop/file", params={"path": "../etc/hosts"})
        # 400 (relative path with ..) or 403 (outside allowlist).
        assert r.status_code in (400, 403)


def test_read_file_refuses_outside_allowlist(
    fake_repo: Path, settings: Settings
) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.get("/api/workshop/file", params={"path": ".env"})
        assert r.status_code == 403
        r2 = client.get("/api/workshop/file", params={"path": "secret.txt"})
        assert r2.status_code == 403


def test_read_file_refuses_absolute_path(
    fake_repo: Path, settings: Settings
) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.get("/api/workshop/file", params={"path": "/etc/passwd"})
        assert r.status_code == 400


# ─── Diagnose ─────────────────────────────────────────────────────────────


class _StubBackend(LLMBackend):
    """Returns whatever ``reply`` we set, so we can assert the backend
    is being asked the right question."""

    def __init__(self, reply: str) -> None:
        self.name = "stub"
        self.reply = reply
        self.last_messages: list[ChatMessage] = []

    async def complete(
        self, messages: list[ChatMessage], *, model: str | None = None
    ) -> ChatResponse:
        self.last_messages = messages
        return ChatResponse(content=self.reply, model="stub", backend="stub")


@pytest.fixture
def stub_router(monkeypatch: pytest.MonkeyPatch) -> _StubBackend:
    backend = _StubBackend(
        reply=(
            "I see the issue. Apply this:\n"
            "```diff\n"
            "--- a/alfred-core/src/alfred_core/api/chat.py\n"
            "+++ b/alfred-core/src/alfred_core/api/chat.py\n"
            "@@ -1,2 +1,2 @@\n"
            " def handle_chat():\n"
            "-    return 'hello'\n"
            "+    return 'hello, sir'\n"
            "```\n"
        )
    )

    def fake_from_settings(_settings: Settings) -> Router:
        return Router(
            local=backend,
            cloud=None,
            local_vision=None,
            local_fast=None,
            use_cloud_for_coding=False,
        )

    monkeypatch.setattr(workshop.Router, "from_settings", staticmethod(fake_from_settings))
    return backend


def test_diagnose_includes_file_contents_in_prompt(
    fake_repo: Path, settings: Settings, stub_router: _StubBackend
) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/diagnose",
            json={
                "problem": "the chat handler greeting is too curt",
                "paths": ["alfred-core/src/alfred_core/api/chat.py"],
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "diff" in body["explanation"]
        # The user message we built must include the file body so the
        # LLM has actual context.
        assert any(
            "handle_chat" in m.content for m in stub_router.last_messages
        )
        # And the user's problem statement.
        assert any(
            "greeting is too curt" in m.content
            for m in stub_router.last_messages
        )


def test_diagnose_refuses_empty_problem(
    fake_repo: Path, settings: Settings, stub_router: _StubBackend
) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post("/api/workshop/diagnose", json={"problem": "  ", "paths": []})
        assert r.status_code == 400


# ─── Apply ────────────────────────────────────────────────────────────────


def test_apply_writes_a_clean_diff_to_disk(
    fake_repo: Path, settings: Settings
) -> None:
    """The signature smoke test for the whole self-coding loop:
    DIAGNOSE returns a diff, APPLY writes it, the file actually
    changes on disk."""
    diff = textwrap.dedent(
        """\
        --- a/alfred-core/src/alfred_core/api/chat.py
        +++ b/alfred-core/src/alfred_core/api/chat.py
        @@ -1,2 +1,2 @@
         def handle_chat():
        -    return 'hello'
        +    return 'hello, sir'
        """
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post("/api/workshop/apply", json={"diff": diff})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["applied"] is True
        assert "alfred-core/src/alfred_core/api/chat.py" in body["files_touched"]
    # And the file on disk should reflect the change.
    new = (fake_repo / "alfred-core/src/alfred_core/api/chat.py").read_text()
    assert "hello, sir" in new
    assert "return 'hello'\n" not in new.replace("hello, sir", "")


def test_apply_refuses_diff_outside_allowlist(
    fake_repo: Path, settings: Settings
) -> None:
    diff = textwrap.dedent(
        """\
        --- a/secret.txt
        +++ b/secret.txt
        @@ -1 +1 @@
        -definitely-out-of-bounds
        +pwned
        """
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post("/api/workshop/apply", json={"diff": diff})
        assert r.status_code == 403


def test_apply_refuses_to_write_dotenv(
    fake_repo: Path, settings: Settings
) -> None:
    """``.env`` is on the read-only blocklist — even if a diff manages
    to be technically inside the allowlist (it isn't, but belt &
    braces) we refuse to touch it."""
    # Build a diff targeting a path where ``.env`` is the leaf — even
    # under an allowlisted parent (``docs/.env``) it should be refused.
    (fake_repo / "docs" / ".env").write_text("nothing\n")
    import subprocess

    subprocess.run(["git", "add", "-A"], cwd=fake_repo, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "add docs/.env"], cwd=fake_repo, check=True
    )
    diff = textwrap.dedent(
        """\
        --- a/docs/.env
        +++ b/docs/.env
        @@ -1 +1 @@
        -nothing
        +pwned
        """
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post("/api/workshop/apply", json={"diff": diff})
        assert r.status_code == 403


def test_apply_returns_failure_for_bad_diff(
    fake_repo: Path, settings: Settings
) -> None:
    """A diff that doesn't apply cleanly should report as
    ``applied: false`` rather than mutating the tree partially."""
    diff = textwrap.dedent(
        """\
        --- a/alfred-core/src/alfred_core/api/chat.py
        +++ b/alfred-core/src/alfred_core/api/chat.py
        @@ -1,2 +1,2 @@
         def some_other_function():
        -    return 'wrong base'
        +    return 'whatever'
        """
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post("/api/workshop/apply", json={"diff": diff})
        # Either 200 with applied=false, or 400 for a malformed diff —
        # both are acceptable failure modes; what we don't want is a
        # silent partial write.
        if r.status_code == 200:
            assert r.json()["applied"] is False
        else:
            assert r.status_code == 400
    # File on disk must NOT have changed.
    text = (fake_repo / "alfred-core/src/alfred_core/api/chat.py").read_text()
    assert "handle_chat" in text
    assert "wrong base" not in text


# ─── Git status + commit/push ────────────────────────────────────────────


@pytest.fixture
def fake_repo_with_remote(
    fake_repo: Path, tmp_path: Path
) -> tuple[Path, Path]:
    """Attach a bare remote to ``fake_repo`` so we can push against it
    and assert the push actually landed. Returns ``(work_tree, remote)``.

    The remote lives in a SIBLING directory (``tmp_path.parent``) so it
    doesn't pollute the work-tree's ``git status`` output as an
    untracked ``remote.git/`` entry — that's what bit the first run."""
    import subprocess

    remote = tmp_path.parent / "alfred-test-remote.git"
    if remote.exists():
        # ``tmp_path.parent`` is shared across tests in the same run;
        # wipe any prior bare repo so we always start clean.
        import shutil
        shutil.rmtree(remote)
    subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)
    subprocess.run(
        ["git", "remote", "add", "origin", str(remote)], cwd=fake_repo, check=True
    )
    # Push the initial commit so subsequent pushes have a base.
    subprocess.run(
        ["git", "push", "-q", "-u", "origin", "HEAD"], cwd=fake_repo, check=True
    )
    return fake_repo, remote


def test_git_status_reports_clean_tree(
    fake_repo_with_remote: tuple[Path, Path], settings: Settings
) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.get("/api/workshop/git-status")
        assert r.status_code == 200, r.text
        body = r.json()
        # Diagnostic if this assertion ever fails again — porcelain
        # output is the source of truth.
        import subprocess
        debug = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=fake_repo_with_remote[0], capture_output=True, text=True
        )
        assert body["clean"] is True, (
            f"clean=false, dirty={body['dirty_files']}, "
            f"porcelain={debug.stdout!r}"
        )
        assert body["dirty_files"] == []
        assert body["last_commit"]  # non-empty


def test_git_status_surfaces_outside_allowlist_files(
    fake_repo_with_remote: tuple[Path, Path], settings: Settings
) -> None:
    """When the user has dirty ``.env`` or out-of-allowlist files, the
    status endpoint separates them from the safe ones so the UI can
    warn that they WON'T be committed."""
    work, _ = fake_repo_with_remote
    # Mutate a safe file + an unsafe one.
    (work / "alfred-core/src/alfred_core/api/chat.py").write_text(
        "def handle_chat():\n    return 'hi'\n"
    )
    (work / ".env").write_text("SECRET=changed\n")
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.get("/api/workshop/git-status")
        body = r.json()
        assert body["clean"] is False
        assert "alfred-core/src/alfred_core/api/chat.py" in body["dirty_files"]
        assert ".env" in body["dirty_files"]
        assert ".env" in body["dirty_files_outside_allowlist"]
        # Safe file is NOT flagged as outside-allowlist.
        assert (
            "alfred-core/src/alfred_core/api/chat.py"
            not in body["dirty_files_outside_allowlist"]
        )


def test_commit_push_lands_in_remote(
    fake_repo_with_remote: tuple[Path, Path], settings: Settings
) -> None:
    """The real end-to-end: APPLY a patch → commit + push → the commit
    shows up in the bare remote with Alfred's authorship."""
    work, remote = fake_repo_with_remote
    # Change a safe file so there's something to commit.
    (work / "alfred-core/src/alfred_core/api/chat.py").write_text(
        "def handle_chat():\n    return 'hi, sir'\n"
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/commit-push",
            json={"message": "alfred: tighten greeting"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["committed"] is True
        assert body["pushed"] is True
        assert body["commit_sha"]  # non-empty hash
        assert body["files_committed"] == [
            "alfred-core/src/alfred_core/api/chat.py"
        ]

    # Confirm the commit actually landed in the bare remote.
    import subprocess

    log = subprocess.run(
        ["git", "--git-dir", str(remote), "log", "-1", "--pretty=%an <%ae>|%s"],
        capture_output=True,
        text=True,
        check=True,
    )
    line = log.stdout.strip()
    assert "Alfred <alfred@localhost>" in line
    assert "tighten greeting" in line


def test_commit_push_skips_outside_allowlist_files(
    fake_repo_with_remote: tuple[Path, Path], settings: Settings
) -> None:
    """If the user dirties BOTH an allowlisted file AND ``.env``, only
    the allowlisted one ends up in the commit. The ``.env`` stays
    dirty in the working tree (not reset, not added, not pushed)."""
    work, remote = fake_repo_with_remote
    (work / "alfred-core/src/alfred_core/api/chat.py").write_text(
        "def handle_chat():\n    return 'hi'\n"
    )
    (work / ".env").write_text("SECRET=oh-no\n")
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/commit-push", json={"message": "alfred: tweak"}
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["committed"] is True
        assert body["files_committed"] == [
            "alfred-core/src/alfred_core/api/chat.py"
        ]
    # ``.env`` should still be dirty in the working tree — proving we
    # didn't accidentally stage it.
    import subprocess

    st = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=work,
        capture_output=True,
        text=True,
        check=True,
    )
    assert ".env" in st.stdout
    # And it should NOT be in the latest commit.
    show = subprocess.run(
        ["git", "--git-dir", str(remote), "log", "-1", "--name-only", "--pretty="],
        capture_output=True,
        text=True,
        check=True,
    )
    assert ".env" not in show.stdout


def test_commit_push_refuses_empty_message(
    fake_repo_with_remote: tuple[Path, Path], settings: Settings
) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post("/api/workshop/commit-push", json={"message": "  "})
        assert r.status_code == 400


def test_commit_push_refuses_clean_tree(
    fake_repo_with_remote: tuple[Path, Path], settings: Settings
) -> None:
    """Nothing to commit inside the allowlist → 400 rather than an
    empty commit. Empty commits confuse `git log` and break the
    diagnose→apply→commit flow's feedback loop."""
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post("/api/workshop/commit-push", json={"message": "noop"})
        assert r.status_code == 400


def test_commit_push_skip_push_only_commits_locally(
    fake_repo_with_remote: tuple[Path, Path], settings: Settings
) -> None:
    """``skip_push=true`` commits locally but doesn't talk to the
    remote. Useful for offline / airgapped setups."""
    work, remote = fake_repo_with_remote
    (work / "alfred-core/src/alfred_core/api/chat.py").write_text(
        "def handle_chat():\n    return 'local-only'\n"
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/commit-push",
            json={"message": "alfred: local only", "skip_push": True},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["committed"] is True
        assert body["pushed"] is False
    # Commit is in local HEAD but NOT in remote.
    import subprocess

    local_head = subprocess.run(
        ["git", "log", "-1", "--pretty=%s"],
        cwd=work,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert "local only" in local_head
    remote_head = subprocess.run(
        ["git", "--git-dir", str(remote), "log", "-1", "--pretty=%s"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert "local only" not in remote_head


def test_commit_push_reports_push_failure_without_losing_commit(
    fake_repo: Path, settings: Settings
) -> None:
    """If the remote isn't reachable (e.g. bad deploy key, network
    down), the local commit still exists and the response tells the
    user exactly what git said."""
    # No remote attached = push will fail.
    (fake_repo / "alfred-core/src/alfred_core/api/chat.py").write_text(
        "def handle_chat():\n    return 'x'\n"
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/commit-push", json={"message": "alfred: x"}
        )
        assert r.status_code == 200
        body = r.json()
        assert body["committed"] is True
        assert body["pushed"] is False
        assert "push failed" in body["detail"].lower()
    # Local commit is still there.
    import subprocess

    head = subprocess.run(
        ["git", "log", "-1", "--pretty=%s"],
        cwd=fake_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert head == "alfred: x"


def test_commit_push_alfred_pr_creates_branch(
    fake_repo_with_remote: tuple[Path, Path], settings: Settings
) -> None:
    """``branch_strategy="alfred-pr"`` puts the commit on a fresh
    ``alfred/<id>`` branch instead of master, leaves master alone,
    and returns the new branch name + (when remote is GitHub-shaped)
    a PR-compose URL."""
    work, remote = fake_repo_with_remote
    (work / "alfred-core/src/alfred_core/api/chat.py").write_text(
        "def handle_chat():\n    return 'pr'\n"
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/commit-push",
            json={
                "message": "alfred: pr",
                "branch_strategy": "alfred-pr",
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["committed"] is True
        assert body["pushed"] is True
        assert body["branch"].startswith("alfred/")
        # Local repo must now be on the new branch.
    import subprocess

    cur = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=work, capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert cur.startswith("alfred/")
    # The remote must have BOTH master (untouched) and the new branch.
    branches = subprocess.run(
        ["git", "--git-dir", str(remote), "branch", "--list"],
        capture_output=True, text=True, check=True,
    ).stdout
    assert "master" in branches
    assert "alfred/" in branches


def test_commit_push_alfred_pr_with_local_remote_has_no_pr_url(
    fake_repo_with_remote: tuple[Path, Path], settings: Settings
) -> None:
    """When the remote isn't GitHub (here it's a local bare repo on
    disk), we don't fabricate a PR URL — the field stays empty and
    the frontend hides the link."""
    work, _ = fake_repo_with_remote
    (work / "alfred-core/src/alfred_core/api/chat.py").write_text(
        "def handle_chat():\n    return 'no-pr'\n"
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/commit-push",
            json={"message": "x", "branch_strategy": "alfred-pr"},
        )
        body = r.json()
        assert body["pushed"] is True
        assert body["pr_url"] == ""


def test_commit_push_alfred_pr_with_github_remote_has_pr_url(
    fake_repo: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the origin URL is GitHub-shaped, the response carries a
    ``pull/new/<branch>`` link the user can click."""
    import subprocess

    # Swap in a fake GitHub remote URL. We won't actually push to it
    # (that would 403); we monkey-patch the push step to short-circuit.
    subprocess.run(
        ["git", "remote", "add", "origin", "git@github.com:wayne/alfred.git"],
        cwd=fake_repo, check=True,
    )
    (fake_repo / "alfred-core/src/alfred_core/api/chat.py").write_text(
        "def handle_chat():\n    return 'gh'\n"
    )
    # Stub the push call. _git_run is module-level — wrap it so any
    # call with the first argv element "push" succeeds with a fake
    # zero-exit result.
    orig = workshop._git_run

    def fake_run(*args: str, **kwargs):  # type: ignore[no-untyped-def]
        if args and args[0] == "push":
            class _R:
                returncode = 0
                stdout = ""
                stderr = ""
            return _R()
        return orig(*args, **kwargs)

    monkeypatch.setattr(workshop, "_git_run", fake_run)
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/commit-push",
            json={"message": "fix it", "branch_strategy": "alfred-pr"},
        )
        body = r.json()
        assert body["committed"] is True
        assert body["pushed"] is True
        assert body["pr_url"].startswith(
            "https://github.com/wayne/alfred/pull/new/alfred/"
        )


# ─── Dry-run ─────────────────────────────────────────────────────────────


def test_dry_run_passes_when_tests_pass(
    fake_repo: Path, settings: Settings
) -> None:
    """The clean-path: a syntactically valid diff that lands cleanly
    + a test command that exits 0 → ``all_passed: true``."""
    diff = textwrap.dedent(
        """\
        --- a/alfred-core/src/alfred_core/api/chat.py
        +++ b/alfred-core/src/alfred_core/api/chat.py
        @@ -1,2 +1,2 @@
         def handle_chat():
        -    return 'hello'
        +    return 'hi, sir'
        """
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/dry-run",
            json={
                "diff": diff,
                # Dummy command that exits 0 — proves the runner
                # mechanics work without forcing the test to depend
                # on pytest being available in this fake repo.
                "test_commands": [["python", "-c", "print('ok')"]],
                "timeout_seconds": 30,
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["applied"] is True
        assert body["all_passed"] is True
        assert body["command_results"][0]["passed"] is True
    # Real working tree is untouched — the worktree was disposable.
    real = (fake_repo / "alfred-core/src/alfred_core/api/chat.py").read_text()
    assert "hi, sir" not in real
    assert "return 'hello'" in real


def test_dry_run_fails_when_tests_fail(
    fake_repo: Path, settings: Settings
) -> None:
    """A non-zero exit from the test command surfaces as
    ``all_passed: false`` with the failing command's output, even
    though the patch itself applied cleanly."""
    diff = textwrap.dedent(
        """\
        --- a/alfred-core/src/alfred_core/api/chat.py
        +++ b/alfred-core/src/alfred_core/api/chat.py
        @@ -1,2 +1,2 @@
         def handle_chat():
        -    return 'hello'
        +    return 'broken'
        """
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/dry-run",
            json={
                "diff": diff,
                "test_commands": [
                    ["python", "-c", "import sys; sys.exit(1)"]
                ],
                "timeout_seconds": 15,
            },
        )
        body = r.json()
        assert body["applied"] is True
        assert body["all_passed"] is False
        assert body["command_results"][0]["passed"] is False


def test_dry_run_refuses_dotenv_diff(
    fake_repo: Path, settings: Settings
) -> None:
    diff = textwrap.dedent(
        """\
        --- a/.env
        +++ b/.env
        @@ -1 +1 @@
        -SECRET=do-not-touch
        +SECRET=pwned
        """
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/dry-run",
            json={"diff": diff, "test_commands": [["echo", "x"]]},
        )
        assert r.status_code == 403


def test_dry_run_with_bad_diff_reports_apply_failure(
    fake_repo: Path, settings: Settings
) -> None:
    """Malformed diff → ``applied=false``, no commands run."""
    diff = textwrap.dedent(
        """\
        --- a/alfred-core/src/alfred_core/api/chat.py
        +++ b/alfred-core/src/alfred_core/api/chat.py
        @@ -1,2 +1,2 @@
         def nonexistent():
        -    bogus context
        +    new line
        """
    )
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/dry-run",
            json={"diff": diff, "test_commands": [["echo", "x"]]},
        )
        body = r.json()
        assert body["applied"] is False
        assert body["all_passed"] is False
        assert body["command_results"] == []


# ─── Self-fix-hint (voice routing) ───────────────────────────────────────


def test_self_fix_hint_matches_radial_menu_keywords(settings: Settings) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/self-fix-hint",
            json={
                "problem": "the radial menu Spotify icon doesn't pulse on the beat"
            },
        )
        body = r.json()
        assert body["matched_topic"] == "radial-menu"
        assert "alfred-web/src/components/RadialMenu.tsx" in body["paths"]


def test_self_fix_hint_matches_voice_keywords(settings: Settings) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/self-fix-hint",
            json={"problem": "wake word and mic don't listen on hands-free"},
        )
        body = r.json()
        assert body["matched_topic"] == "voice"
        assert any("Composer" in p or "useWakeWord" in p for p in body["paths"])


def test_self_fix_hint_falls_back_when_no_match(settings: Settings) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/self-fix-hint",
            json={"problem": "asdf qwerty unrelated nonsense"},
        )
        body = r.json()
        assert body["matched_topic"] == "generic"
        assert len(body["paths"]) >= 2


def test_self_fix_hint_refuses_empty(settings: Settings) -> None:
    app = _make_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/api/workshop/self-fix-hint", json={"problem": "  "}
        )
        assert r.status_code == 400
