"""Tests for the single-user password gate."""

from __future__ import annotations

import bcrypt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from alfred_core.api import auth
from alfred_core.api.auth import require_auth
from alfred_core.config import Settings, get_settings


def _password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _make_app(settings: Settings) -> FastAPI:
    """Build a tiny FastAPI app wired to the auth router and a single
    protected demo endpoint, then override get_settings so the test
    sees the auth config we want."""
    app = FastAPI()
    app.include_router(auth.router, prefix="/api")

    @app.get("/api/demo/protected")
    def protected(_: dict = Depends(require_auth)) -> dict:  # type: ignore[name-defined]
        return {"ok": True}

    app.dependency_overrides[get_settings] = lambda: settings
    # Reset the in-memory brute-force tracker between tests so a
    # previous test's lockout doesn't leak.
    auth._attempts.clear()
    return app


# Need the Depends import at the module level for the closure above.
from fastapi import Depends  # noqa: E402


@pytest.fixture
def auth_off_settings() -> Settings:
    return Settings(
        alfred_password_hash="",
        alfred_jwt_secret="x" * 64,
    )


@pytest.fixture
def auth_on_settings() -> Settings:
    return Settings(
        alfred_password_hash=_password_hash("alfred-rules-2026"),
        alfred_jwt_secret="testing-secret-do-not-use-in-prod-" + "a" * 32,
        alfred_login_max_failures=3,
        alfred_login_lockout_minutes=15,
    )


def test_auth_off_lets_protected_routes_through(auth_off_settings: Settings) -> None:
    """When ALFRED_PASSWORD_HASH is unset, ``require_auth`` is a no-op
    so existing deployments aren't broken by the upgrade."""
    app = _make_app(auth_off_settings)
    with TestClient(app) as client:
        r = client.get("/api/demo/protected")
        assert r.status_code == 200
        assert r.json() == {"ok": True}


def test_auth_on_blocks_anon_access(auth_on_settings: Settings) -> None:
    app = _make_app(auth_on_settings)
    with TestClient(app) as client:
        r = client.get("/api/demo/protected")
        assert r.status_code == 401


def test_login_with_correct_password_grants_cookie(
    auth_on_settings: Settings,
) -> None:
    app = _make_app(auth_on_settings)
    with TestClient(app) as client:
        r = client.post("/api/auth/login", json={"password": "alfred-rules-2026"})
        assert r.status_code == 200, r.text
        assert r.json()["authed"] is True
        assert "alfred_access" in client.cookies
        # The cookie should now let us hit the protected route.
        r2 = client.get("/api/demo/protected")
        assert r2.status_code == 200


def test_login_wrong_password_returns_401(auth_on_settings: Settings) -> None:
    app = _make_app(auth_on_settings)
    with TestClient(app) as client:
        r = client.post("/api/auth/login", json={"password": "nope"})
        assert r.status_code == 401


def test_brute_force_lockout(auth_on_settings: Settings) -> None:
    """3 failures = lockout. The 4th attempt — even with the right
    password — must come back as 429."""
    app = _make_app(auth_on_settings)
    with TestClient(app) as client:
        for _ in range(3):
            r = client.post("/api/auth/login", json={"password": "wrong"})
            assert r.status_code == 401
        r = client.post("/api/auth/login", json={"password": "alfred-rules-2026"})
        assert r.status_code == 429
        assert "try again" in r.json()["detail"].lower()


def test_logout_clears_cookies(auth_on_settings: Settings) -> None:
    app = _make_app(auth_on_settings)
    with TestClient(app) as client:
        client.post("/api/auth/login", json={"password": "alfred-rules-2026"})
        assert "alfred_access" in client.cookies
        r = client.post("/api/auth/logout")
        assert r.status_code == 200
        # After logout, hitting the protected route must 401 again.
        client.cookies.clear()
        r2 = client.get("/api/demo/protected")
        assert r2.status_code == 401


def test_me_reports_disabled_when_off(auth_off_settings: Settings) -> None:
    app = _make_app(auth_off_settings)
    with TestClient(app) as client:
        r = client.get("/api/auth/me")
        assert r.status_code == 200
        body = r.json()
        assert body["auth_enabled"] is False
        assert body["authed"] is True


def test_me_reports_unauthenticated_when_on(auth_on_settings: Settings) -> None:
    app = _make_app(auth_on_settings)
    with TestClient(app) as client:
        r = client.get("/api/auth/me")
        assert r.status_code == 200
        body = r.json()
        assert body["auth_enabled"] is True
        assert body["authed"] is False


def test_change_password_returns_new_hash(auth_on_settings: Settings) -> None:
    """The change endpoint hashes a new password and returns the hash
    for the user to paste into .env. We deliberately don't mutate the
    running settings — that would split the source of truth and the
    next restart would revert anyway."""
    app = _make_app(auth_on_settings)
    with TestClient(app) as client:
        client.post("/api/auth/login", json={"password": "alfred-rules-2026"})
        r = client.post(
            "/api/auth/change",
            json={
                "old_password": "alfred-rules-2026",
                "new_password": "even-stronger-passphrase-123",
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert body["new_password_hash"].startswith("$2b$")
        # The returned hash must verify against the new password.
        assert bcrypt.checkpw(
            b"even-stronger-passphrase-123",
            body["new_password_hash"].encode(),
        )


def test_jwt_placeholder_secret_refuses_to_enable_auth() -> None:
    """If the user sets ALFRED_PASSWORD_HASH but forgets to rotate the
    JWT secret, ``has_auth`` raises so they don't ship a deployment
    that signs tokens with a publicly-known secret."""
    s = Settings(
        alfred_password_hash=_password_hash("anything"),
        alfred_jwt_secret="CHANGE-ME-INSECURE-PLACEHOLDER",
    )
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        _ = s.has_auth
