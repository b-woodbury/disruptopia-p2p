# Disruptopia P2P

A static-frontend version of Disruptopia — an AI board game where you build a
rogue AI company and race competitors to take over the world. Game state lives
in the browser (IndexedDB); remote multiplayer is true browser-to-browser P2P
over WebRTC.

## Quickstart: play with a friend across the internet

**Both players** (one-time setup on each machine):

```bash
git clone https://github.com/b-woodbury/disruptopia-p2p.git
cd disruptopia-p2p
pip install fastapi uvicorn
uvicorn app:app --port 7869
```

Then open <http://localhost:7869/> in your browser.

**Host:** click *Host Online*, fill in player names + starting regions, click
*Host Game*. You'll see a 10-character room code on the setup screen.

**Joiner:** click *Join Online*, paste the room code, pick the player slot
the host assigned you, click *Join Game*.

That's it — no port forwarding, no shared server URL, no Tailscale. The
browsers find each other via [PeerJS](https://peerjs.com/)'s free public
broker, then talk directly over an encrypted WebRTC data channel. Works
through typical home NATs.

**Sanity check before your first cross-internet game:** run
`python tests/multiplayer_test.py` on your machine — if the 31 assertions
pass, your local PeerJS path works, which almost always means the
cross-internet path will too.

## Architecture

- **Frontend**: plain HTML/CSS/JS, no build step. The full game engine runs
  client-side from [`engine/`](engine/), with UI in [`ui/`](ui/) and rendering
  via the world map in [`assets/`](assets/).
- **Networking** ([`network/peer.js`](network/peer.js) +
  [`network/relay-client.js`](network/relay-client.js)): WebRTC data channels
  via [PeerJS](https://peerjs.com/). The public PeerJS broker (free) mediates
  the initial handshake; once peers are connected, *all* game traffic flows
  browser-to-browser, end-to-end encrypted via DTLS. No game state ever
  touches a server.
- **Static server** ([`app.py`](app.py)): a tiny FastAPI app that serves the
  frontend bundle. Nothing more — there is no relay, no shared backend.

## Run it

Requires Python 3.10+ with `fastapi` and `uvicorn` installed.

```bash
pip install fastapi uvicorn
uvicorn app:app --host 0.0.0.0 --port 7869
```

Then open <http://localhost:7869/>.

Each player runs their *own* copy of this server (or any static-file server)
to load the page. There is no shared host machine.

## Multiplayer (true peer-to-peer over WebRTC)

The setup screen has three modes: **Local Game** (hot-seat, one machine),
**Host Online**, and **Join Online**.

To play with someone in another city:

1. Each player starts their own copy of the server (`uvicorn app:app …`) and
   opens <http://localhost:7869/> on their own machine.
2. **Host** picks "Host Online", fills in names + starting regions, and clicks
   *Host Game*. The setup screen shows a 10-character room code.
3. The host shares **just the room code** (10 chars, ~50 bits of entropy) by
   whatever channel — DM, Discord, voice, whatever.
4. **Joiner** picks "Join Online", pastes the room code, selects the player
   slot the host assigned them (Player 2 / Player 3 / …), and clicks
   *Join Game*.

No port forwarding, no shared server URL, no Tailscale — the browsers find
each other through PeerJS's free public signaling broker, then negotiate a
direct WebRTC connection. Works through typical home NATs.

**Sync model**: every client runs the full game engine locally. Worker
placements, undo, round-execute, discards, and pending-interaction
resolutions are broadcast as small action messages over the data channel;
each client applies remote actions to its own copy. The engine is
deterministic, so all clients converge.

**Desync detection**: after every `finishRound`, each client broadcasts a
FNV-1a hash of its canonical game state. If a peer's hash differs from yours
for the same round, a `DESYNC @ round N` badge appears in the multiplayer
banner. This catches tampering, engine bugs, and dropped-action races.

**Mid-game reconnect**: the multiplayer context (mode, room code, player
slot) is persisted to IndexedDB alongside the engine state. If you reload
the page, `init()` re-establishes the WebRTC connection — host re-registers
the same peer ID, joiner reconnects to the host and pulls a fresh state
snapshot. Falls back to local-only mode if the host is unreachable.

**Privacy**: WebRTC data channels are encrypted end-to-end via DTLS. The
PeerJS broker only sees the initial handshake (peer IDs + ICE candidates),
not game traffic. The room code is the only thing protecting your room from
unwanted joiners — 10 random chars from a 31-letter alphabet (`O`, `0`, `1`,
`I`, `L` excluded for share-by-voice friendliness) ≈ 50 bits of entropy.

## Tests

Five Playwright suites:

```bash
pip install playwright
playwright install chromium

# Core single-player suite (68 tests)
python tests/playwright_test.py

# Multi-round exploration (97 assertions)
python tests/exploration_test.py

# Rulebook-compliance checks (74 assertions)
python tests/rulebook_test.py

# Two-browser-context multiplayer over real WebRTC (31 assertions)
python tests/multiplayer_test.py

# LLM agent plays a full game via Ollama (smoke / integration)
python tests/agent_test.py
```

All five expect the server at <http://localhost:7869/>. The multiplayer
suite needs an active internet connection (the PeerJS public broker is
reached via `wss://0.peerjs.com`).

## License

MIT
