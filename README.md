# Disruptopia P2P

A static-frontend version of Disruptopia — an AI board game where you build a
rogue AI company and race competitors to take over the world. Game state lives
in the browser (IndexedDB); an optional lightweight relay server enables async
multiplayer.

## Architecture

- **Frontend**: plain HTML/CSS/JS, no build step. The full game engine runs
  client-side from [`engine/`](engine/), with UI in [`ui/`](ui/) and rendering
  via the world map in [`assets/`](assets/).
- **Relay** ([`server/relay.py`](server/relay.py)): a tiny FastAPI "mailbox"
  that stores rooms, queues actions, and serves them back when players poll.
  It does **not** run game logic — that all happens in the browser.
- **Combined entry** ([`app.py`](app.py)): a FastAPI app that serves the static
  frontend and mounts the relay API under `/api`, so a single process on a
  single port runs the whole thing.

## Run it

Requires Python 3.10+ with `fastapi`, `uvicorn`, and `pydantic` installed.

```bash
pip install fastapi uvicorn pydantic
uvicorn app:app --host 0.0.0.0 --port 7869
```

Then open <http://localhost:7869/>.

The relay API is reachable at `/api/*` (e.g. `POST /api/room`,
`GET /api/room/{code}/actions?since=N`). The frontend can point at any relay
URL via the in-game setup; pointing at `/api` uses the bundled relay on the
same origin.

## Multiplayer (remote, real-time-ish)

The setup screen has three modes: **Local Game** (hot-seat, one machine),
**Host Online**, and **Join Online**.

To play with someone on another machine:

1. **Host** picks "Host Online", fills in names + starting regions, and clicks
   *Host Game*. The setup screen shows a 6-character game code.
2. The host shares two things with the joiner: the **game code** and the
   **relay URL** (the URL where the joiner can reach the host's server). If
   both players are on the same LAN this can be `http://<host-ip>:7869/api`.
   For remote play you need to expose the host machine — Tailscale Funnel,
   ngrok, or any HTTPS tunnel works, e.g. `https://gx10-abd7.tailea39b3.ts.net/api`.
3. **Joiner** picks "Join Online", pastes the relay URL + game code, selects
   the player slot the host assigned them (Player 2 / Player 3 / …), and
   clicks *Join Game*.

Sync model: every client runs the full game engine locally. Worker placements,
undo, the round-execute trigger, and discards are broadcast as an action log
through the relay; each client applies remote actions to its own copy. The
engine is deterministic, so all clients converge. Polling interval is 2.5s.

Limitations in v1:
- Card play with target prompts (sabotage cards, region targets) and Recruit's
  sub-action picker aren't synced yet — the prompt only fires for the local
  player.
- Pending interactions (Corporate Espionage, Patent Troll, etc.) aren't synced.
- No reconnection: if you reload mid-game your local IndexedDB still has the
  state, but you'll need to rejoin via the code to resume action sync.

## Tests

Three Playwright suites:

```bash
pip install playwright
playwright install chromium

# Core single-player suite (68 tests)
python tests/playwright_test.py

# Multi-round exploration (97 assertions)
python tests/exploration_test.py

# Two-browser-context multiplayer (21 tests)
python tests/multiplayer_test.py
```

All three expect the server at <http://localhost:7869/>.

## License

MIT
