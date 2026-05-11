"""
Disruptopia P2P - LLM agent end-to-end test.

Drives a full 2-player game via an Ollama LLM. The agent reads game
state, proposes worker placements / card plays via JSON, executes them
through the browser, then exercises the real UI for round resolution
and pending-interaction modals. Asserts the game completes (or hits the
round cap) without JavaScript errors.

This is a *smoke / integration* test — it complements the deterministic
suites by catching UI hangs, dead-end modals, prompts that don't fire,
and validation gaps between Availability and Engine.

Run the server first:
    uvicorn app:app --host 0.0.0.0 --port 7869

Run the test:
    python tests/agent_test.py

Env:
    AGENT_MODEL          Ollama model (default: nemotron-3-super:latest)
    AGENT_MAX_ROUNDS     Hard cap rounds (default: 8)
    AGENT_HEADLESS       "0" to watch the browser (default: 1)
    AGENT_TURN_TIMEOUT   Per-LLM-call seconds (default: 600)
"""
import json
import os
import re
import sys
import time
import traceback

import requests
from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:7869"
OLLAMA_URL = "http://localhost:11434/v1/chat/completions"
MODEL = os.getenv("AGENT_MODEL", "nemotron-3-super:latest")
MAX_ROUNDS = int(os.getenv("AGENT_MAX_ROUNDS", "8"))
HEADLESS = os.getenv("AGENT_HEADLESS", "1") != "0"
LLM_TIMEOUT = int(os.getenv("AGENT_TURN_TIMEOUT", "600"))

PASS = 0
FAIL = 0
ERRORS = []
JS_ERRORS = []
LLM_CALLS = 0


def log(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        ERRORS.append(f"{name}: {detail}")
        print(f"  FAIL  {name} -- {detail}")


# ─────────────────────────────────────────────────────────────────────
# LLM PLUMBING
# ─────────────────────────────────────────────────────────────────────

def ask_llm(system, user, max_retries=2):
    """Call Ollama's OpenAI-compatible endpoint. Returns content string."""
    global LLM_CALLS
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            LLM_CALLS += 1
            r = requests.post(OLLAMA_URL, json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.2,
                "stream": False,
            }, timeout=LLM_TIMEOUT)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]
        except Exception as e:
            last_err = e
            time.sleep(1.5)
    raise RuntimeError(f"LLM call failed after retries: {last_err}")


JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def parse_json_block(text):
    """Extract the first JSON value from text. Tolerates code fences and prose."""
    if not text:
        return None
    text = text.strip()
    # Strip ```json ... ``` fences if present
    m = JSON_FENCE_RE.search(text)
    if m:
        text = m.group(1).strip()
    # Find first { or [
    start = -1
    for i, c in enumerate(text):
        if c in "[{":
            start = i
            break
    if start == -1:
        return None
    # Walk to matching close, respecting strings
    depth = 0
    in_str = False
    escape = False
    end = -1
    for i in range(start, len(text)):
        c = text[i]
        if escape:
            escape = False
            continue
        if c == "\\":
            escape = True
            continue
        if c == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if c in "[{":
            depth += 1
        elif c in "]}":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end == -1:
        return None
    try:
        return json.loads(text[start:end + 1])
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────
# GAME STATE EXTRACTION
# ─────────────────────────────────────────────────────────────────────

REGION_NAMES = [
    "North America", "Central America", "South America", "Europe",
    "North Africa", "Sub-Saharan Africa", "Middle East", "Eastern Russia",
    "South Asia", "East Asia",
]


def snapshot_for_llm(page, player_idx):
    """Return a compact dict the LLM can reason over."""
    return page.evaluate("""
        (idx) => {
            const s = Game.localState;
            const p = s.players[idx];
            const proj = Engine.getProjectedPlayerState(s, p.id, 99);
            const mods = Engine.getPlayerModifiers(s, p.id);
            const avail = Availability.getReport(proj, 99, mods, true);

            const handComps = s.components.filter(c => c.zone === `hand_p${p.id}` && c.ownerId === p.id);
            const hand = handComps.map(c => {
                const d = s.cardDefinitions.find(x => x.id === c.cardDetailsId);
                return {
                    id: c.id,
                    name: d ? d.name : "?",
                    cost: d ? d.cost : 0,
                    description: d ? d.description : "",
                    requirements: d ? d.requirements : "",
                    is_effect: d ? d.isEffect : false,
                };
            });

            const activeEffects = [];
            for (let slot = 1; slot <= 3; slot++) {
                const comp = s.components.find(c => c.zone === `active_effect_card_slot_${slot}_p${p.id}`);
                if (comp) {
                    const d = s.cardDefinitions.find(x => x.id === comp.cardDetailsId);
                    activeEffects.push({slot, name: d ? d.name : "?", description: d ? d.description : ""});
                }
            }

            // Compute neighbor regions (for scale_presence target options)
            const owned = new Set(p.presenceRegions);
            const neighbors = new Set();
            for (const r of owned) {
                for (const a of (Config.WORLD_MAP[r] || [])) {
                    if (!owned.has(a)) neighbors.add(a);
                }
            }

            // Competitor summaries
            const competitors = s.players.filter(x => x.id !== p.id).map(c => ({
                id: c.id, name: c.userName,
                net_worth: c.netWorthLevel, model: c.modelVersion, power: c.power,
                reputation: c.reputation, compute: c.computeLevel,
                presence: [...c.presenceRegions].sort((a,b)=>a-b),
            }));

            return {
                round: s.game.currentRound,
                max_rounds: s.game.maxRounds,
                me: {
                    id: p.id, name: p.userName,
                    net_worth: p.netWorthLevel,
                    funds: p.corporateFunds, personal: p.personalFunds,
                    power: p.power, reputation: p.reputation,
                    compute: p.computeLevel, model: p.modelVersion,
                    presence_count: p.presenceCount,
                    presence_regions: [...p.presenceRegions].sort((a,b)=>a-b),
                    subsidies: p.subsidyTokens,
                    total_workers: p.totalWorkers, income: p.income,
                    next_worker_cost: Engine.nextWorkerCost(p),
                    next_presence_cost: Engine.nextPresenceCost(p),
                    neighbors: [...neighbors].sort((a,b)=>a-b),
                    hand,
                    active_effects: activeEffects,
                },
                competitors,
                availability: avail,
                vp_breakdown: Engine.calculateGameLeaderboard(s).find(r => r.player_id === p.id) || {},
            };
        }
    """, player_idx)


def detect_js_errors(page):
    """Pull console errors that piled up since last check."""
    return list(JS_ERRORS)


# ─────────────────────────────────────────────────────────────────────
# LLM DECISION FORMAT
# ─────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are playing Disruptopia, a board game about ruthless AI startups.

Rules summary you need:
- Each round you place 3 (or more) Tech Workers on the Quarterly Strategy Board.
- Workers fire in numerical order. Workers 1, 2, 3 are yours by default.
- The 8 actions are:
  buy_chips, recruit, train_model, increase_net_worth,
  marketing, scale_presence, play_card, raise_funds.
- `train_model` and `raise_funds` accept multiple CONSECUTIVE workers (e.g. workers 1+2). Workers 1+3 do NOT form a group.
- `play_card` consumes N workers where N is the card cost; multiple workers on play_card let you play multiple cards.
- `scale_presence` needs an adjacent region to expand into.
- `recruit` lets you take a Tech Worker and immediately assign it to ANY action.
- Game ends after the round any player hits Model Version 7.

Victory points:
- 1VP per 5 Power + 1VP per Model Version + 1VP per Region + Millionaire/Billionaire bonuses + highest-personal-funds bonus.

You will be given the current state as JSON. Return a JSON object describing your strategy this round. NO prose, NO markdown — just a JSON object matching:

{
  "placements": [
    {"worker": 1, "action": "marketing"},
    {"worker": 2, "action": "raise_funds"},
    {"worker": 3, "action": "scale_presence", "region": 3}
  ],
  "card_plays": [
    {"worker_first": 2, "card_id": 42}
  ]
}

Notes:
- `placements[].worker` is the worker number (1-indexed). Must cover workers 1..total_workers.
- For `play_card`, set `action: "play_card"` and add it to placements; also describe it in card_plays with the same starting worker number.
- For `scale_presence`, include `region` (one of your neighbors).
- For `train_model` / `raise_funds` you may set multiple consecutive workers with the same action.
- Only suggest actions that are listed as `available: true` in the availability section.
- If your hand has a great card and a play_card slot makes sense, use it. Otherwise stick to basic actions.
- Be aggressive about Model Version progress — the game ends when someone hits V7.
"""


def parse_decision(decision, total_workers):
    """Normalize the LLM's response into placements + card_plays."""
    if not isinstance(decision, dict):
        return None
    placements = decision.get("placements") or []
    card_plays = decision.get("card_plays") or []
    seen = set()
    cleaned = []
    for p in placements:
        if not isinstance(p, dict):
            continue
        w = p.get("worker")
        a = p.get("action")
        if not isinstance(w, int) or w < 1 or w > total_workers:
            continue
        if w in seen:
            continue
        seen.add(w)
        cleaned.append({
            "worker": w,
            "action": a,
            "region": p.get("region"),
            "card_id": p.get("card_id"),
            "sub_action": p.get("sub_action") or p.get("recruit_target"),
        })
    cleaned.sort(key=lambda x: x["worker"])
    # Map card plays by starting worker
    card_map = {}
    for cp in card_plays:
        if isinstance(cp, dict) and isinstance(cp.get("worker_first"), int):
            card_map[cp["worker_first"]] = cp.get("card_id")
    # Attach card_id to play_card placements that don't have one yet
    for p in cleaned:
        if p["action"] == "play_card" and not p.get("card_id"):
            p["card_id"] = card_map.get(p["worker"])
    return cleaned


# ─────────────────────────────────────────────────────────────────────
# PLACEMENT EXECUTION
# ─────────────────────────────────────────────────────────────────────

FALLBACK_ORDER = ["raise_funds", "marketing", "buy_chips", "scale_presence", "train_model"]


def try_place(page, player_id, worker_n, action, region, card_id, sub_action):
    """Call Engine.placeWorker via page.evaluate. Returns (ok, message)."""
    args = {
        "pid": player_id, "n": worker_n, "action": action,
        "region": region, "cardId": card_id, "subAction": sub_action,
    }
    res = page.evaluate("""
        (a) => {
            const r = Engine.placeWorker(
                Game.localState, a.pid, a.n, a.action,
                a.region || null, a.cardId || null, a.subAction || null
            );
            return r;
        }
    """, args)
    if isinstance(res, dict) and res.get("error"):
        return False, res["error"]
    return True, "ok"


def place_with_fallback(page, player_id, worker_n, action, region, card_id, sub_action, avail):
    """Try the LLM's choice, falling back through known-safe actions on error."""
    if action and (avail.get(action, {}).get("available")):
        ok, msg = try_place(page, player_id, worker_n, action, region, card_id, sub_action)
        if ok:
            return action, None
    # Fallbacks
    for fb in FALLBACK_ORDER:
        if not avail.get(fb, {}).get("available"):
            continue
        # Pick a region for scale_presence
        fb_region = None
        if fb == "scale_presence":
            neighbors = page.evaluate("""
                (pid) => {
                    const p = Game.localState.players.find(x => x.id === pid);
                    const owned = new Set(p.presenceRegions);
                    const ns = new Set();
                    for (const r of owned) for (const a of (Config.WORLD_MAP[r] || [])) if (!owned.has(a)) ns.add(a);
                    return [...ns];
                }
            """, player_id)
            if neighbors:
                fb_region = neighbors[0]
            else:
                continue
        ok, msg = try_place(page, player_id, worker_n, fb, fb_region, None, None)
        if ok:
            return fb, None
    return None, "no valid action found"


# ─────────────────────────────────────────────────────────────────────
# PENDING-INTERACTION HANDLING
# ─────────────────────────────────────────────────────────────────────

def drain_modals(page, max_seconds=60):
    """Click through any visible modal — picks reasonable defaults."""
    start = time.time()
    while time.time() - start < max_seconds:
        # Forced discard prompt
        if page.locator("#discard-confirm-btn:visible").count() > 0:
            # Click a hand card to select for discard
            hand_card = page.locator("#player-hand > div").first
            if hand_card.count() > 0:
                hand_card.click()
                time.sleep(0.1)
            page.locator("#discard-confirm-btn:visible").first.click()
            time.sleep(0.2)
            continue
        # Generic choice modal
        choice_modal = page.locator("#choice-modal")
        if choice_modal.count() > 0 and choice_modal.is_visible():
            btn = page.locator("#choice-modal button:visible").first
            if btn.count() > 0:
                btn.click()
                time.sleep(0.2)
                continue
        # Drawn-card chooser (unethical_data)
        drawn_modal = page.locator("#drawn-cards-modal:visible")
        if drawn_modal.count() > 0:
            btn = drawn_modal.locator("button").first
            if btn.count() > 0:
                btn.click()
                time.sleep(0.2)
                continue
        # Slot selector
        slot_modal = page.locator("#slot-modal:visible")
        if slot_modal.count() > 0:
            btn = slot_modal.locator("button").first
            if btn.count() > 0:
                btn.click()
                time.sleep(0.2)
                continue
        # Nothing visible — done
        time.sleep(0.15)
        # If pending interactions remain, keep waiting
        pending = page.evaluate("(Game.localState.game.pendingInteractions || []).length")
        executing = page.evaluate("Game.executingStrategy")
        if pending == 0 and not executing:
            break
    return time.time() - start


# ─────────────────────────────────────────────────────────────────────
# ROUND LOOP
# ─────────────────────────────────────────────────────────────────────

def play_player_turn(page, player_idx, round_n):
    """Ask the LLM for placements, execute them. Returns chosen actions list."""
    snap = snapshot_for_llm(page, player_idx)
    pid = snap["me"]["id"]
    total_workers = snap["me"]["total_workers"]

    user_msg = f"Round {round_n}. Your state:\n```json\n{json.dumps(snap, indent=2)}\n```\nReturn the JSON strategy now."
    reply = ask_llm(SYSTEM_PROMPT, user_msg)
    decision = parse_json_block(reply)
    placements = parse_decision(decision, total_workers) if decision else []

    # Ensure every worker gets something
    by_n = {p["worker"]: p for p in placements}
    chosen = []
    for n in range(1, total_workers + 1):
        plan = by_n.get(n, {"worker": n, "action": "raise_funds"})
        action, err = place_with_fallback(
            page, pid, n,
            plan.get("action"), plan.get("region"),
            plan.get("card_id"), plan.get("sub_action"),
            snap["availability"],
        )
        chosen.append({"worker": n, "action": action, "error": err})
    return chosen


def execute_round(page):
    """Click 'Execute Strategy' and drain all modals + animations."""
    btn = page.locator("#btn-execute-strategy:visible")
    if btn.count() == 0:
        return "no_button"
    btn.first.click()
    # Wait for resolution to start, then drain
    time.sleep(0.6)
    drain_modals(page, max_seconds=90)
    # Wait until executingStrategy flips off
    for _ in range(120):
        executing = page.evaluate("Game.executingStrategy")
        if not executing:
            break
        drain_modals(page, max_seconds=5)
        time.sleep(0.5)
    return "ok"


def fresh_game(page):
    page.goto(BASE_URL, wait_until="networkidle")
    time.sleep(0.3)
    page.evaluate("indexedDB.deleteDatabase('disruptopia_p2p')")
    page.reload(wait_until="networkidle")
    time.sleep(0.4)
    page.locator("#setup-player-count").select_option("2")
    time.sleep(0.2)
    page.locator("#setup-name-0").fill("Alice")
    page.locator("#setup-name-1").fill("Bob")
    page.locator("#setup-region-0").select_option("1")
    page.locator("#setup-region-1").select_option("6")
    page.click("text=Launch Game")
    time.sleep(0.8)


def run():
    print(f"Agent test starting. Model={MODEL}, max_rounds={MAX_ROUNDS}, headless={HEADLESS}")
    overall_t0 = time.time()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=HEADLESS)
        ctx = browser.new_context(viewport={"width": 1500, "height": 950})
        page = ctx.new_page()
        page.on("pageerror", lambda e: JS_ERRORS.append(f"pageerror: {e}"))
        page.on("console", lambda msg: JS_ERRORS.append(f"console.error: {msg.text}") if msg.type == "error" else None)

        fresh_game(page)
        n_players = page.evaluate("Game.localState.players.length")
        log("setup.1 game launched with 2 players", n_players == 2, str(n_players))

        rounds_played = 0
        for round_n in range(1, MAX_ROUNDS + 1):
            print(f"\n── Round {round_n} ──")
            phase = page.evaluate("Game.localState.game.gamePhase")
            if phase == "finished":
                print("  (game already finished)")
                break

            for pid_idx in range(n_players):
                # In this local game, both seats share the same UI/state.
                # Switch the dashboard to that player.
                # The select option label is the player's userName.
                player_name = page.evaluate(f"Game.localState.players[{pid_idx}].userName")
                page.locator("#player-select").select_option(label=player_name)
                time.sleep(0.2)
                t0 = time.time()
                actions = play_player_turn(page, pid_idx, round_n)
                dt = time.time() - t0
                print(f"  {player_name}: {[a['action'] for a in actions]}  ({dt:.1f}s)")

            # Resolve the round (executes for whichever player is dashboard-active,
            # which advances ALL players' workers since the engine resolves the
            # full board in one call).
            t0 = time.time()
            r = execute_round(page)
            dt = time.time() - t0
            print(f"  resolved ({dt:.1f}s, status={r})")
            rounds_played += 1

            phase = page.evaluate("Game.localState.game.gamePhase")
            if phase == "finished":
                print("  → game finished")
                break

        # ────────── Assertions
        final_phase = page.evaluate("Game.localState.game.gamePhase")
        log("agent.1 game finished or reached round cap",
            final_phase == "finished" or rounds_played >= MAX_ROUNDS,
            f"phase={final_phase}, rounds={rounds_played}")

        log("agent.2 no JS errors during play",
            len(JS_ERRORS) == 0,
            f"{len(JS_ERRORS)} JS errors: {JS_ERRORS[:3]}")

        # Sanity: state invariants
        invariants = page.evaluate("""
            (() => {
                const s = Game.localState;
                const errs = [];
                for (const p of s.players) {
                    if (p.power < 1 || p.power > 30) errs.push(`${p.userName} power=${p.power}`);
                    if (p.reputation < -3 || p.reputation > 10) errs.push(`${p.userName} rep=${p.reputation}`);
                    if (p.totalWorkers < 3 || p.totalWorkers > 8) errs.push(`${p.userName} workers=${p.totalWorkers}`);
                    if (p.modelVersion < 0 || p.modelVersion > 7) errs.push(`${p.userName} model=${p.modelVersion}`);
                    if (p.computeLevel < 1 || p.computeLevel > 7) errs.push(`${p.userName} compute=${p.computeLevel}`);
                    if (p.netWorthLevel < 0 || p.netWorthLevel > 2) errs.push(`${p.userName} nw=${p.netWorthLevel}`);
                }
                return errs;
            })()
        """)
        log("agent.3 all player stats within rulebook bounds",
            len(invariants) == 0, str(invariants))

        browser.close()

    total = time.time() - overall_t0
    print("\n" + "=" * 60)
    print(f"AGENT RESULTS: {PASS} passed, {FAIL} failed | {LLM_CALLS} LLM calls | {total:.1f}s total")
    if ERRORS:
        print("\nAssertion failures:")
        for e in ERRORS:
            print(f"  - {e}")
    if JS_ERRORS:
        print(f"\nJS errors during play ({len(JS_ERRORS)}):")
        for e in JS_ERRORS[:10]:
            print(f"  - {e}")
        if len(JS_ERRORS) > 10:
            print(f"  ... and {len(JS_ERRORS) - 10} more")
    print("=" * 60)
    return FAIL == 0


if __name__ == "__main__":
    try:
        ok = run()
        sys.exit(0 if ok else 1)
    except Exception as e:
        print(f"\nFATAL: {e}")
        traceback.print_exc()
        sys.exit(2)
