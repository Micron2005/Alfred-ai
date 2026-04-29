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
