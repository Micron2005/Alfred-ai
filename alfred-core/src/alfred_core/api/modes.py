"""Mode (persona) management endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from alfred_core.persona import Mode
from alfred_core.state import mode_state

router = APIRouter(prefix="/mode", tags=["mode"])


class ModeResponse(BaseModel):
    mode: Mode


class ModeRequest(BaseModel):
    mode: Mode


@router.get("", response_model=ModeResponse)
async def get_mode() -> ModeResponse:
    return ModeResponse(mode=mode_state.mode)


@router.put("", response_model=ModeResponse)
async def set_mode(req: ModeRequest) -> ModeResponse:
    try:
        mode_state.set(req.mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ModeResponse(mode=mode_state.mode)
