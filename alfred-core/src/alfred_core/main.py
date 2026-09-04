"""FastAPI application entry point."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from alfred_core import __version__
from alfred_core.api import (
    chat,
    conversations,
    email,
    facts,
    health,
    memory,
    spotify,
    voice,
    weather,
)
from alfred_core.db.session import init_db
from alfred_core.memory_system import get_memory_manager, reset_memory_manager


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    await init_db()
    get_memory_manager()
    yield
    reset_memory_manager()


app = FastAPI(
    title="Alfred AI",
    version=__version__,
    description="Personal AI assistant — a butler's manners, a JARVIS's capability.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # behind Tailscale; tighten later if exposed publicly
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(facts.router)
app.include_router(conversations.router)
app.include_router(voice.router)
app.include_router(email.router)
app.include_router(spotify.router)
app.include_router(weather.router)
app.include_router(memory.router)


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "name": "Alfred AI",
        "version": __version__,
        "greeting": "At your service.",
    }
