"""
Disruptopia P2P - Static file server.

Serves the frontend (index.html + engine/ + ui/ + network/ + assets/).
Multiplayer no longer needs a shared backend — peers exchange WebRTC
data channels via the public PeerJS broker, with all game traffic
flowing browser-to-browser. This file just serves the bundle.

Symlinks in the project (e.g. WorldMap.png, assets/*) may point outside
the project directory. Starlette's StaticFiles refuses those by design,
so we serve static files via an explicit route using FileResponse with
resolved symlink paths.

Run:
    uvicorn app:app --host 0.0.0.0 --port 7869
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="Disruptopia P2P")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "index.html")


@app.get("/{path:path}")
def static(path: str):
    # Reject literal parent traversal; allow symlinks to resolve to anywhere.
    if ".." in Path(path).parts:
        raise HTTPException(404)
    joined = BASE_DIR / path
    if not joined.exists() or not joined.is_file():
        raise HTTPException(404)
    return FileResponse(str(joined))
