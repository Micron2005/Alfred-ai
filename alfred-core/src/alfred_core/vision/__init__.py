"""Vision feature module — face recognition + workout coaching.

These are the backend pieces of the camera-driven HUD upgrade
(face mesh, body pose, form feedback). Frontend tracking still
lives entirely in the browser via MediaPipe; this module only
handles persistence (face enrollments) and LLM orchestration
(workout coach).
"""
