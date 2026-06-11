# Vision HUD Upgrade — Holistic Tracking + 3D Orb + Form Coach

This branch (`feature/holistic-tracking-3d-hud`) layers in a major
new chunk of capability on top of the existing Phase 12c.x hand
tracking work, without disturbing any of it.

## What's new

### 1. Facial expression detection (no face mesh) 🙂
- `alfred-web/src/lib/useFaceTracking.ts`: in-browser MediaPipe
  FaceLandmarker. 478 face landmarks + 52 ARKit-compatible
  blendshape coefficients (smile / frown / brow raise / mouth
  open / etc.) at ~30 fps, all client-side.
- `ExpressionReadout` (`components/ExpressionReadout.tsx`):
  small fixed-position HUD pill in the bottom-right corner that
  shows the dominant expression (e.g. "Smile · 47%"). Auto-hides
  1.5 s after the face leaves frame. **Does NOT draw on the
  user's face** — Alfred sees the expression silently.
- Auto-starts with the page (no toggle button), exactly like
  hand tracking. Falls back to a no-op overlay if the user
  denies camera permission.

### 2. Body pose tracking (auto-on, like hand tracking) 🦴
- `alfred-web/src/lib/usePoseTracking.ts`: in-browser MediaPipe
  PoseLandmarker (BlazePose Lite). 33-point body skeleton +
  pre-computed joint angles (left/right elbow, knee, hip,
  shoulder, plus stance ratio and torso lean) at ~20 fps.
- `PoseSkeleton` overlay (`components/PoseSkeleton.tsx`):
  visibility-aware skeleton render with a "BIOMECHANICS"
  readout panel showing live joint angles.
- **Auto-starts with the page** (same lifecycle as hand
  tracking — no opt-in button). The skeleton draws on top of
  the user as they move, identical UX to the hand cursor.

### 3. 3D orb upgrade 🌐 ORB
- `Orb3D` (`components/Orb3D.tsx`): drop-in replacement for the
  legacy 2D `Orb`. Built with pure CSS 3D transforms (no
  Three.js dependency, so the bundle stays small and the orb
  still works on a Pi 5).
  - Four concentric rings rotating in 3D about different axes
    (X, Y, Z, tilted-Y) for proper depth parallax.
  - Three orbiting satellites at independent radii / speeds.
  - Glowing core that pulses to the same `orbStore` audio
    level the legacy orb subscribed to (so listening /
    speaking heartbeat behaves identically).
  - Subtle scene-wide tilt tied to the breath cycle.
- New header toggle `🌐 ORB · 3D` / `🌐 ORB · 2D`
  (`data-testid="orb-3d-toggle"`). Defaults ON.

### 4. Workout / form coach 🥋
- `lib/poseAnalyzer.ts`: dependency-free heuristic rules for
  six exercises — squat, push-up, plank, lunge, fighting
  stance, horse stance. Returns severity-tagged cues + a
  0..100 form score.
- `WorkoutCoachWidget` (`components/WorkoutCoachWidget.tsx`):
  HUD widget combining live cues + an "ASK COACH" prompt
  that round-trips to the backend's new `/vision/coach`
  endpoint. Coach replies are persona-aligned (Alfred's
  voice) and can include a structured workout plan.
- Backend `alfred_core/vision/workout_coach.py`: prompts the
  existing LLM router with the live pose snapshot, harvests
  any fenced ```json``` plan block from the reply, returns
  prose + structured plan to the client.
- New `/vision/coach` POST endpoint.
- HUD widget id `workout-coach`, hidden by default — flip it
  on via the customise toolbar.

### 5. Facial recognition 👤
- `lib/visionApi.ts` + `FaceRecognitionWidget`: enroll & identify
  faces. The 96-D identity vector comes from the FaceLandmarker
  pipeline already running for expression tracking — no extra
  computer-vision dependency.
- Backend `alfred_core/vision/face_recognition.py`: pgvector-
  backed enrollment & cosine-similarity match (default
  threshold 0.92). New `face_enrollments` table with a
  96-dim Vector column.
- New endpoints under `/vision/face/*`:
  - `POST /enroll` — store a (name, vector) pair
  - `POST /identify` — top-K cosine-similarity match
  - `GET /enrollments` — list
  - `DELETE /enrollments/{id}` — remove
- HUD widget id `face-recognition`, hidden by default.
- **Caveat**: the geometric identity vector distinguishes a
  few household members at similar pose / lighting but is not
  a learned face embedding. To upgrade for real recognition
  robustness, swap to `@vladmandic/face-api` (128-D dlib) on
  the client or `insightface` (512-D ArcFace) on the backend.
  The API shape doesn't change — only the dim constant in
  `db/models.py` and `lib/useFaceTracking.ts` need to match.

## Bug audit notes

The existing Phase 12c.x hand tracking pipeline is already
heavily polished — I did **not** rewrite it. It already has
adaptive smoothing, pinch hysteresis, fist hysteresis,
two-handed pinch combo, manual pointer capture for synthetic
events, and pre-mirror canvas handling for handedness. No
real bugs surfaced during the audit.

A handful of minor surface fixes:
- `db/models.py`: added a `FACE_IDENTITY_DIM` constant alongside
  the existing `MEMORY_EMBEDDING_DIM` so the new `FaceEnrollment`
  table dimensionality is documented in code.
- `hudLayout.ts`: extended the widget id union and default
  layout to cover the two new widgets.

## Requires a database migration

Adding `face_enrollments` is a new table. On first
`docker compose up --build` after this branch lands, the
SQLAlchemy `init_db` lifespan in `main.py` will create it
automatically (the project doesn't run Alembic migrations
end-to-end yet — table creation is via metadata reflection).

## Testing locally

```bash
docker compose up --build
# Web UI:    http://localhost:3000
# Backend:   http://localhost:8000
```

1. Toggle `📷 CAM` to allow camera access.
2. Toggle `🙂 FACE` — face mesh + expression panel appear.
3. Toggle `🦴 POSE` — body skeleton + biomechanics panel
   appear.
4. Toggle `🎛 CUSTOMIZE` and reveal the `Form Coach` and
   `Recognition` widgets from the toolbar.
5. In the Form Coach, pick an exercise and step into frame.
   Live cues update at 10 Hz; the "ASK" button hits the
   backend coach endpoint.
6. In Recognition, step into frame and click `ENROLL` with
   your name. Subsequent visits should auto-identify.
