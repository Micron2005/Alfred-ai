"""Tests for the desktop integration endpoints."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alfred_core.api import desktop as desktop_module
from alfred_core.config import get_settings


@pytest.fixture()
def temp_workspace():
    """Create a sandbox dir with subdirs and files, hooked up as the
    sole whitelist entry."""
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "Documents").mkdir()
        (root / "Documents" / "note.txt").write_text("hello world")
        (root / "Documents" / "binary.bin").write_bytes(b"\x00\x01\xff\xfe")
        (root / "Documents" / "sub").mkdir()
        (root / "Documents" / "sub" / "deep.txt").write_text("deep")
        # An "outside" file at the root that is NOT inside the
        # whitelisted Documents subdir — used to test traversal
        # rejection.
        (root / "outside.txt").write_text("secret")
        yield root


@pytest.fixture()
def client(temp_workspace: Path):
    app = FastAPI()
    app.include_router(desktop_module.router)

    def override_settings():
        # Real Settings instance so all the other fields stay valid;
        # we just patch the one we care about.
        s = get_settings()
        # Pydantic settings model is frozen in v2 — go through the
        # underlying dict.
        object.__setattr__(s, "alfred_allowed_dirs", str(temp_workspace / "Documents"))
        return s

    app.dependency_overrides[get_settings] = override_settings
    return TestClient(app)


def test_list_files_inside_whitelist(client: TestClient, temp_workspace: Path) -> None:
    docs = temp_workspace / "Documents"
    resp = client.get(f"/api/desktop/files/list?path={docs}")
    assert resp.status_code == 200
    body = resp.json()
    names = {e["name"] for e in body["entries"]}
    assert "note.txt" in names
    assert "sub" in names
    # The "sub" directory should be marked is_dir.
    sub = next(e for e in body["entries"] if e["name"] == "sub")
    assert sub["is_dir"] is True


def test_list_files_rejects_outside_whitelist(
    client: TestClient, temp_workspace: Path,
) -> None:
    """The root of the workspace is OUTSIDE the whitelisted Documents
    subdir — listing it must 403."""
    resp = client.get(f"/api/desktop/files/list?path={temp_workspace}")
    assert resp.status_code == 403


def test_list_files_rejects_traversal(
    client: TestClient, temp_workspace: Path,
) -> None:
    """``..`` segments that escape the whitelist must be rejected."""
    docs = temp_workspace / "Documents"
    bad = f"{docs}/../outside.txt"
    resp = client.get(f"/api/desktop/files/list?path={bad}")
    # Either 403 (escape detected) or 404 (file doesn't exist as dir);
    # either is acceptable as long as it's NOT 200 with leaked data.
    assert resp.status_code in {400, 403, 404}


def test_read_file_returns_text(client: TestClient, temp_workspace: Path) -> None:
    note = temp_workspace / "Documents" / "note.txt"
    resp = client.get(f"/api/desktop/files/read?path={note}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["content"] == "hello world"
    assert body["truncated"] is False


def test_read_file_refuses_binary(
    client: TestClient, temp_workspace: Path,
) -> None:
    binary = temp_workspace / "Documents" / "binary.bin"
    resp = client.get(f"/api/desktop/files/read?path={binary}")
    assert resp.status_code == 415


def test_read_file_outside_whitelist(
    client: TestClient, temp_workspace: Path,
) -> None:
    outside = temp_workspace / "outside.txt"
    resp = client.get(f"/api/desktop/files/read?path={outside}")
    assert resp.status_code == 403


def test_open_url_validates_scheme(client: TestClient) -> None:
    """``javascript:`` and ``data:`` URLs MUST be rejected."""
    bad_urls = [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "about:blank",
    ]
    for url in bad_urls:
        resp = client.post("/api/desktop/open-url", json={"url": url})
        assert resp.status_code == 400, f"{url} should have been rejected"


def test_open_url_dispatches(client: TestClient) -> None:
    """Valid http URL hits Popen with the right argv per platform."""
    with patch.object(desktop_module.subprocess, "Popen") as mock_popen:
        resp = client.post(
            "/api/desktop/open-url",
            json={"url": "https://example.com/iron-man"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"opened": True, "url": "https://example.com/iron-man"}
    assert mock_popen.called
    argv = mock_popen.call_args.args[0]
    assert "https://example.com/iron-man" in argv
    if sys.platform.startswith("darwin"):
        assert argv[0] == "open"
    elif sys.platform.startswith("win"):
        assert argv[0] == "cmd"
    else:
        assert argv[0] == "xdg-open"


def test_whitelist_endpoint(client: TestClient, temp_workspace: Path) -> None:
    resp = client.get("/api/desktop/whitelist")
    assert resp.status_code == 200
    paths = resp.json()
    assert len(paths) == 1
    assert os.path.basename(paths[0]) == "Documents"


def test_files_list_404_when_not_configured() -> None:
    """No ALFRED_ALLOWED_DIRS → file list endpoint refuses with 409."""
    app = FastAPI()
    app.include_router(desktop_module.router)

    def override_settings():
        s = get_settings()
        object.__setattr__(s, "alfred_allowed_dirs", "")
        return s

    app.dependency_overrides[get_settings] = override_settings
    cli = TestClient(app)
    resp = cli.get("/api/desktop/files/list?path=/etc")
    assert resp.status_code == 409


def test_diagnostics_unconfigured() -> None:
    """No ALFRED_ALLOWED_DIRS → diagnostics reports configured=False
    with a fix_hint pointing the user at .env + docker-compose."""
    app = FastAPI()
    app.include_router(desktop_module.router)

    def override_settings():
        s = get_settings()
        object.__setattr__(s, "alfred_allowed_dirs", "")
        return s

    app.dependency_overrides[get_settings] = override_settings
    cli = TestClient(app)
    resp = cli.get("/api/desktop/diagnostics")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is False
    assert body["entries"] == []
    assert "ALFRED_ALLOWED_DIRS" in body["fix_hint"]


def test_diagnostics_configured_and_readable(
    client: TestClient, temp_workspace: Path,
) -> None:
    """Configured + path exists + readable → all-readable hint."""
    resp = client.get("/api/desktop/diagnostics")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is True
    assert len(body["entries"]) == 1
    entry = body["entries"][0]
    assert entry["exists"] is True
    assert entry["is_dir"] is True
    assert entry["readable"] is True
    assert "readable" in body["fix_hint"].lower()


def test_diagnostics_path_missing() -> None:
    """Configured path that doesn't exist on disk → fix_hint
    mentions bind-mounts (the common "user forgot to mount the host
    volume into the container" pitfall)."""
    app = FastAPI()
    app.include_router(desktop_module.router)

    def override_settings():
        s = get_settings()
        object.__setattr__(
            s, "alfred_allowed_dirs", "/nope/this/path/does/not/exist",
        )
        return s

    app.dependency_overrides[get_settings] = override_settings
    cli = TestClient(app)
    resp = cli.get("/api/desktop/diagnostics")
    assert resp.status_code == 200
    body = resp.json()
    assert body["configured"] is True
    assert body["entries"][0]["exists"] is False
    # Hint must surface a docker-compose mount remedy when the path
    # exists in config but not on disk (typical container scenario).
    # If the test is running inside Docker we expect the bind-mount
    # hint; outside Docker we expect a permission/exist hint. Both
    # are valid — just ensure the hint is non-empty + actionable.
    assert body["fix_hint"]
    assert "docker" in body["fix_hint"].lower() or "exist" in body["fix_hint"].lower() or "read" in body["fix_hint"].lower()
