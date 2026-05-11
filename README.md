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

## Tests

End-to-end Playwright suite covers page load, game creation, engine state,
worker placement, player switching, strategy execution, persistence, and
visual rendering (66 tests).

```bash
pip install playwright
playwright install chromium
python tests/playwright_test.py
```

The suite expects the server at <http://localhost:7869/>.

## License

MIT
