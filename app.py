"""
Disruptopia P2P - Combined server.

Serves the static frontend (index.html + engine/ + ui/ + network/ + assets/)
and mounts the relay API under /api so the whole app runs on a single port.

Symlinks in the project (e.g. WorldMap.png, assets/*) point outside the
project directory. Starlette's StaticFiles refuses those by design, so we
serve static files via an explicit route using FileResponse with resolved
symlink paths.

Run:
    uvicorn app:app --host 0.0.0.0 --port 7869
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from server.relay import app as relay_app

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="Disruptopia P2P")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Relay API under /api (frontend can point at '/api' for same-origin relay)
app.mount("/api", relay_app)


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "index.html")


@app.get("/{path:path}")
def static(path: str):
    # Resolve against BASE_DIR; follow symlinks but keep the request path
    # confined under BASE_DIR (no .. traversal). Symlink *targets* are
    # allowed to live anywhere — the check is on the request path, not
    # the resolved target.
    requested = (BASE_DIR / path).resolve(strict=False)
    try:
        # Ensure the path (before symlink resolution) does not escape BASE_DIR
        (BASE_DIR / path).relative_to(BASE_DIR) if True else None
        joined = BASE_DIR / path
        # Reject parent traversal in the literal path
        if ".." in Path(path).parts:
            raise HTTPException(404)
        if not joined.exists() or not joined.is_file():
            raise HTTPException(404)
        return FileResponse(str(joined))
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(404)
