#!/usr/bin/env python3
"""Restore Alfred's memory archive from the markdown mirror.

Standalone disaster-recovery script — runs OUTSIDE Docker. Talks
directly to whatever Postgres ``DATABASE_URL`` in ``.env`` points at
(native or container), and uses the local Ollama instance for
re-embedding (best-effort; missing embeddings just disable semantic
search for those notes).

Reuses the canonical parser + restore code from
``alfred_core.memory_archive`` so this script and the
``POST /memory/restore`` endpoint share one implementation — no
divergent regexes, no drift.

Usage (from the repo root, native or Docker setup):

    # Activate the alfred-core venv (created by scripts/native/go-native.sh)
    source .venv-alfred-core/bin/activate
    python3 scripts/restore-memory.py

The script auto-loads .env and the alfred-core settings, parses every
``*.md`` file in ``ALFRED_MEMORY_HOST_PATH`` (or
``ALFRED_MEMORY_DIR``), upserts the rows by their original UUID (so
re-runs are idempotent), and re-embeds via Ollama.

Exit codes:
  0  success (or partial — see report)
  2  config error (env vars, missing markdown dir)
  3  Postgres connection failed
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

# Make ``alfred_core`` importable without `pip install -e .` having to
# have happened yet — handy on a fresh checkout.
_REPO_ROOT = Path(__file__).resolve().parent.parent
_SRC = _REPO_ROOT / "alfred-core" / "src"
if _SRC.exists() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))


def _load_dotenv() -> None:
    """Tiny .env loader so this script works without python-dotenv.

    Only sets variables that aren't already in ``os.environ`` — same
    precedence as ``python-dotenv``.
    """

    env_path = _REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


async def _main() -> int:
    _load_dotenv()

    # When running natively (no Docker), the in-container path
    # ``/app/alfred-memory`` doesn't exist on the host. Fall back to
    # ALFRED_MEMORY_HOST_PATH (which IS the host path) so the same
    # script works in both deployments.
    if not os.environ.get("ALFRED_MEMORY_DIR"):
        host_path = os.environ.get("ALFRED_MEMORY_HOST_PATH", "").strip()
        if host_path:
            os.environ["ALFRED_MEMORY_DIR"] = str(
                (_REPO_ROOT / host_path).resolve()
                if not Path(host_path).is_absolute()
                else Path(host_path)
            )

    try:
        from alfred_core.config import get_settings
        from alfred_core.db.session import init_db
        from alfred_core.memory_archive import restore_from_mirror
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
        from sqlalchemy.exc import SQLAlchemyError
    except ImportError as exc:
        print(
            "ERROR: alfred-core not importable. Run from the repo root after\n"
            "       `source .venv-alfred-core/bin/activate` (or `pip install -e\n"
            "       alfred-core` if you haven't set up the venv yet).\n"
            f"       Details: {exc}",
            file=sys.stderr,
        )
        return 2

    settings = get_settings()
    memory_dir = Path(settings.alfred_memory_dir)
    if not memory_dir.exists():
        print(
            f"ERROR: memory directory does not exist: {memory_dir}\n"
            "       Set ALFRED_MEMORY_HOST_PATH (or ALFRED_MEMORY_DIR) in .env\n"
            "       to the folder containing your .md files.",
            file=sys.stderr,
        )
        return 2

    md_count = len(list(memory_dir.glob("*.md")))
    print(f"Memory directory: {memory_dir} ({md_count} .md files)")
    print(f"Postgres:         {_redact(settings.database_url)}")
    print(f"Ollama:           {settings.ollama_host} (embeddings: best-effort)")
    print()

    # Use a one-shot engine for this script (don't pollute the global
    # one used by FastAPI processes).
    from alfred_core.db.session import _async_url  # type: ignore[attr-defined]

    engine = create_async_engine(_async_url(settings.database_url), future=True)
    try:
        # Make sure the schema exists (no-op if alfred-core has ever
        # started against this Postgres, useful on a totally fresh
        # native install).
        await init_db()
    except SQLAlchemyError as exc:
        print(f"ERROR: Postgres connection failed: {exc}", file=sys.stderr)
        return 3

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        report = await restore_from_mirror(session=session, settings=settings)
        await session.commit()

    await engine.dispose()

    print("─" * 60)
    print(f"Imported:     {report.imported}")
    print(f"Skipped:      {report.skipped} (already in DB)")
    print(f"Failed:       {report.failed}")
    print(f"Embedded:     {report.embedded} (semantic recall works for these)")
    if report.errors:
        print()
        print("Warnings / errors:")
        for line in report.errors[:20]:
            print(f"  · {line}")
        if len(report.errors) > 20:
            print(f"  · ... and {len(report.errors) - 20} more.")
    print("─" * 60)
    if report.imported == 0 and report.skipped == md_count and md_count > 0:
        print("All files were already in the DB — nothing to do.")
    elif report.imported > 0:
        print(
            f"Restored {report.imported} note(s). "
            "Open the HUD's MEMORY tab to see them."
        )
    return 0


def _redact(url: str) -> str:
    """Hide the DB password in the URL when we echo it back."""
    if "://" not in url or "@" not in url:
        return url
    scheme, rest = url.split("://", 1)
    creds, host = rest.rsplit("@", 1)
    user, _, _ = creds.partition(":")
    return f"{scheme}://{user}:***@{host}"


if __name__ == "__main__":
    sys.exit(asyncio.run(_main()))
