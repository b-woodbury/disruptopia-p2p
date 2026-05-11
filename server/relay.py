"""
Disruptopia P2P - Relay Server (Minimal Mailbox)

This server does NOT run game logic. It just:
1. Stores game rooms (identified by short codes)
2. Accepts actions from players and queues them
3. Serves queued actions to other players when they poll

Run: uvicorn server.relay:app --host 0.0.0.0 --port 8090
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import time

app = FastAPI(title="Disruptopia Relay")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# In-memory storage (rooms expire after 24h of inactivity)
rooms: dict = {}
EXPIRY_SECONDS = 86400


class Room:
    def __init__(self, game_code: str, host_player_id: int, initial_state: dict):
        self.game_code = game_code
        self.host_player_id = host_player_id
        self.state = initial_state
        self.actions: list = []
        self.players: list = [host_player_id]
        self.created_at = time.time()
        self.last_activity = time.time()

    def touch(self):
        self.last_activity = time.time()


class CreateRoomRequest(BaseModel):
    gameCode: str
    initialState: dict
    hostPlayerId: int


class JoinRequest(BaseModel):
    playerId: int


class ActionRequest(BaseModel):
    playerId: int
    action: dict
    timestamp: Optional[int] = None


class StateUpdate(BaseModel):
    state: dict
    playerId: int


def _cleanup():
    """Remove expired rooms."""
    now = time.time()
    expired = [code for code, room in rooms.items() if now - room.last_activity > EXPIRY_SECONDS]
    for code in expired:
        del rooms[code]


@app.post("/room")
def create_room(req: CreateRoomRequest):
    _cleanup()
    if req.gameCode in rooms:
        raise HTTPException(400, "Room already exists")
    rooms[req.gameCode] = Room(req.gameCode, req.hostPlayerId, req.initialState)
    return {"status": "created", "gameCode": req.gameCode}


@app.post("/room/{game_code}/join")
def join_room(game_code: str, req: JoinRequest):
    if game_code not in rooms:
        raise HTTPException(404, "Room not found")
    room = rooms[game_code]
    room.touch()
    if req.playerId not in room.players:
        room.players.append(req.playerId)
    return {
        "status": "joined",
        "actionCount": len(room.actions),
        "players": room.players,
        "state": room.state,
    }


@app.post("/room/{game_code}/action")
def post_action(game_code: str, req: ActionRequest):
    if game_code not in rooms:
        raise HTTPException(404, "Room not found")
    room = rooms[game_code]
    room.touch()
    room.actions.append({
        "playerId": req.playerId,
        "action": req.action,
        "timestamp": req.timestamp or int(time.time() * 1000),
        "index": len(room.actions),
    })
    return {"status": "ok", "index": len(room.actions) - 1}


@app.get("/room/{game_code}/actions")
def get_actions(game_code: str, since: int = 0):
    if game_code not in rooms:
        raise HTTPException(404, "Room not found")
    room = rooms[game_code]
    room.touch()
    actions = room.actions[since:]
    return {"actions": actions, "lastIndex": len(room.actions)}


@app.get("/room/{game_code}/state")
def get_state(game_code: str):
    if game_code not in rooms:
        raise HTTPException(404, "Room not found")
    room = rooms[game_code]
    room.touch()
    return room.state


@app.put("/room/{game_code}/state")
def update_state(game_code: str, req: StateUpdate):
    if game_code not in rooms:
        raise HTTPException(404, "Room not found")
    room = rooms[game_code]
    room.touch()
    room.state = req.state
    return {"status": "updated"}


@app.get("/rooms")
def list_rooms():
    _cleanup()
    return [
        {
            "gameCode": r.game_code,
            "playerCount": len(r.players),
            "actionCount": len(r.actions),
            "createdAt": r.created_at,
        }
        for r in rooms.values()
    ]
