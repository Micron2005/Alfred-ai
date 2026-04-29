"""
Stub backend for the Emergent preview pod.

The real Alfred backend (alfred-core) needs Postgres + pgvector +
Ollama, which only run on the user's home PC via docker-compose.
This stub just keeps the supervisor happy and serves a friendly
banner from the API root so the preview UI shows a clear message
about the backend being a stub.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Alfred-AI Preview Stub")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {
        "name": "Alfred AI (preview stub)",
        "note": (
            "This is the Emergent preview environment. The full Alfred "
            "backend needs Postgres + Ollama and runs only via "
            "docker-compose on your home PC. The frontend you're seeing "
            "uses MediaPipe entirely client-side, so all the new "
            "vision features (face mesh, pose tracking, 3D orb, "
            "expression panel, biomechanics readout) work right here in "
            "the browser. Chat / coach / face-recognition need the real "
            "backend."
        ),
    }


@app.get("/api/health")
async def health():
    return {"status": "preview-stub"}
