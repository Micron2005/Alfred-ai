"""FastAPI application entry point."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from alfred_core import __version__
from alfred_core.api import (
    auth,
    chat,
    conversations,
    desktop,
    email,
    facts,
    health,
    location,
    memory,
    printer,
    routing,
    spotify,
    vision,
    vitals,
    voice,
    weather,
    workshop,
)
from alfred_core.api.auth import require_auth
from alfred_core.db.session import init_db


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    await init_db()
    yield


app = FastAPI(
    title="Alfred AI",
    version=__version__,
    description="Personal AI assistant — a butler's manners, a JARVIS's capability.",
    lifespan=lifespan,
)

# CORS origins. Behind Tailscale a wildcard would be fine, but as soon
# as the auth gate is on we MUST send a real origin (browsers refuse
# to send cookies to ``Access-Control-Allow-Origin: *`` with
# ``allow_credentials=True``). The user sets ALFRED_FRONTEND_ORIGIN in
# .env to their HUD URL, e.g. ``http://alfred.local:3000``.
_frontend_origin = os.environ.get("ALFRED_FRONTEND_ORIGIN", "").strip()
_cors_origins = (
    [_frontend_origin]
    if _frontend_origin
    else [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://alfred.local:3000",
    ]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Public routers — never gated.
app.include_router(health.router)
app.include_router(auth.router)

# Gated routers. ``require_auth`` is a no-op when ALFRED_PASSWORD_HASH
# is unset, so existing deployments keep working unchanged.
_protected = [Depends(require_auth)]
app.include_router(chat.router, dependencies=_protected)
app.include_router(facts.router, dependencies=_protected)
app.include_router(conversations.router, dependencies=_protected)
app.include_router(voice.router, dependencies=_protected)
app.include_router(email.router, dependencies=_protected)
app.include_router(spotify.router, dependencies=_protected)
app.include_router(weather.router, dependencies=_protected)
app.include_router(memory.router, dependencies=_protected)
app.include_router(vision.router, dependencies=_protected)
app.include_router(printer.router, dependencies=_protected)
app.include_router(vitals.router, dependencies=_protected)
app.include_router(workshop.router, dependencies=_protected)
app.include_router(location.router, dependencies=_protected)
app.include_router(desktop.router, dependencies=_protected)
app.include_router(routing.router, dependencies=_protected)


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "name": "Alfred AI",
        "version": __version__,
        "greeting": "At your service.",
    }
