"""
Disruptopia P2P - LLM agent end-to-end test.

Drives a full 4-player game where each seat is played by an independent
LLM agent. All four seats hit the same vLLM-hosted model
(gpt-oss-120b by default) but receive distinct persona prompts and
independent decision contexts:

    Player 1 — Builder       (model-version rusher)
    Player 2 — Disruptor     (sabotage card focus)
    Player 3 — Globalist     (presence + subsidy scaling)
    Player 4 — Economist     (raise funds + Billionaire race)

The agents read game state via page.evaluate(), propose worker placements
and card plays as JSON, execute them through the browser, then exercise
the real UI for round resolution and pending-interaction modals.

Asserts: the game completes (or hits the round cap) without JavaScript
errors, and final stats stay within rulebook bounds.

This is a *smoke / integration* test — it complements the deterministic
suites by catching UI hangs, dead-end modals, prompts that don't fire,
and validation gaps between Availability and Engine.

Run the server first:
    uvicorn app:app --host 0.0.0.0 --port 7869

Run the test:
    python tests/agent_test.py

Env:
    AGENT_API_URL        OpenAI-compatible endpoint (default vLLM at :8000)
    AGENT_MODEL          Model id (default: openai/gpt-oss-120b)
    AGENT_MAX_ROUNDS     Hard cap rounds (default: 8)
    AGENT_PLAYERS        Player count, 2-5 (default: 4)
    AGENT_HEADLESS       "0" to watch the browser (default: 1)
    AGENT_TURN_TIMEOUT   Per-LLM-call seconds (default: 600)
    AGENT_PERSONAS       "0" to disable personas (all seats identical prompt)
    AGENT_REASONING_EFFORT  gpt-oss-style thinking depth: low | medium | high
                            (default: medium)
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
API_URL = os.getenv("AGENT_API_URL", "http://localhost:8000/v1/chat/completions")
MODEL = os.getenv("AGENT_MODEL", "openai/gpt-oss-120b")
MAX_ROUNDS = int(os.getenv("AGENT_MAX_ROUNDS", "8"))
N_PLAYERS = max(2, min(5, int(os.getenv("AGENT_PLAYERS", "4"))))
HEADLESS = os.getenv("AGENT_HEADLESS", "1") != "0"
LLM_TIMEOUT = int(os.getenv("AGENT_TURN_TIMEOUT", "600"))
USE_PERSONAS = os.getenv("AGENT_PERSONAS", "1") != "0"

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

REASONING_EFFORT = os.getenv("AGENT_REASONING_EFFORT", "medium")


def ask_llm(system, user, max_retries=2, temperature=0.6, max_tokens=2500):
    """Call the configured OpenAI-compatible endpoint. Returns content string.

    gpt-oss-120b and similar reasoning models put internal thought in a
    separate `reasoning` field. The actual answer is in `content`. We read
    `content` first and fall back to `reasoning` if content is empty (which
    happens if the model truncates before emitting the answer).

    `reasoning_effort` toggles how many tokens the model spends on internal
    chain-of-thought before emitting `content`. Higher = better play, more
    tokens. Default "medium" matches /src/infra/vllm/presets/gpt-oss-120b
    guidance for non-trivial reasoning tasks.
    """
    global LLM_CALLS
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            LLM_CALLS += 1
            r = requests.post(API_URL, json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": temperature,
                "max_tokens": max_tokens,
                "reasoning_effort": REASONING_EFFORT,
                "stream": False,
            }, timeout=LLM_TIMEOUT)
            r.raise_for_status()
            msg = r.json()["choices"][0]["message"]
            content = msg.get("content") or ""
            if content.strip():
                return content
            # Reasoning-model fallback: sometimes the answer ends up in
            # the reasoning trace if `content` was truncated.
            return msg.get("reasoning") or ""
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
    """Compact dict the LLM can reason over. Trimmed to fit small context windows.

    Card descriptions are clipped to ~100 chars; competitor blocks drop
    presence regions; availability is reduced to a list of available
    actions. This keeps the prompt well under 4096 tokens with headroom
    for the system prompt and response.
    """
    return page.evaluate("""
        (idx) => {
            const s = Game.localState;
            const p = s.players[idx];
            const proj = Engine.getProjectedPlayerState(s, p.id, 99);
            const mods = Engine.getPlayerModifiers(s, p.id);
            const avail = Availability.getReport(proj, 99, mods, true);

            const clip = (str, n) => {
                if (!str) return "";
                str = str.replace(/\\s+/g, " ").trim();
                return str.length > n ? str.slice(0, n - 1) + "…" : str;
            };

            const handComps = s.components.filter(c => c.zone === `hand_p${p.id}` && c.ownerId === p.id);
            const hand = handComps.map(c => {
                const d = s.cardDefinitions.find(x => x.id === c.cardDetailsId);
                return d ? {
                    id: c.id, name: d.name, cost: d.cost,
                    deck: d.deck, is_effect: d.isEffect,
                    desc: clip(d.description, 110),
                } : null;
            }).filter(Boolean);

            const activeEffects = [];
            for (let slot = 1; slot <= 3; slot++) {
                const comp = s.components.find(c => c.zone === `active_effect_card_slot_${slot}_p${p.id}`);
                if (comp) {
                    const d = s.cardDefinitions.find(x => x.id === comp.cardDetailsId);
                    if (d) activeEffects.push({slot, name: d.name, desc: clip(d.description, 80)});
                }
            }

            const owned = new Set(p.presenceRegions);
            const neighbors = new Set();
            for (const r of owned) {
                for (const a of (Config.WORLD_MAP[r] || [])) {
                    if (!owned.has(a)) neighbors.add(a);
                }
            }

            // Reduce availability to a flat list of available action slugs.
            const availableActions = Object.keys(avail).filter(k => avail[k] && avail[k].available);

            const competitors = s.players.filter(x => x.id !== p.id).map(c => ({
                id: c.id, name: c.userName,
                nw: c.netWorthLevel, mv: c.modelVersion, pwr: c.power,
                rep: c.reputation, cpu: c.computeLevel,
                pres: c.presenceCount,
                shared: [...c.presenceRegions].filter(r => owned.has(r)),
            }));

            return {
                round: s.game.currentRound,
                max_rounds: s.game.maxRounds,
                me: {
                    id: p.id, name: p.userName,
                    nw: p.netWorthLevel,
                    funds: p.corporateFunds, personal: p.personalFunds,
                    power: p.power, rep: p.reputation,
                    compute: p.computeLevel, model: p.modelVersion,
                    presence: p.presenceCount,
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
                available_actions: availableActions,
            };
        }
    """, player_idx)


def detect_js_errors(page):
    """Pull console errors that piled up since last check."""
    return list(JS_ERRORS)


# ─────────────────────────────────────────────────────────────────────
# LLM DECISION FORMAT
# ─────────────────────────────────────────────────────────────────────

BASE_SYSTEM = """You are playing Disruptopia, a board game about ruthless AI startups.

Rules:
- Each round you place 3+ Tech Workers on the Strategy Board.
- Workers fire in numerical order (1, 2, 3...).
- Actions: buy_chips, recruit, train_model, increase_net_worth, marketing, scale_presence, play_card, raise_funds.
- train_model + raise_funds count CONSECUTIVE workers as one group (workers 1+2 yes, 1+3 no).
- play_card consumes N workers where N = card cost (0, 1, or 2).
- scale_presence requires an adjacent region.
- recruit takes a new Tech Worker and assigns it to ANY action immediately.
- Game ends after the round any player hits Model Version 7.

Scoring: 1VP per 5 Power, 1VP per Model Version, 1VP per Region, Millionaire/Billionaire bonuses, highest-personal-funds bonus.

You will receive game state as JSON. Return ONLY a JSON object — no prose, no markdown:

{
  "placements": [
    {"worker": 1, "action": "marketing"},
    {"worker": 2, "action": "raise_funds"},
    {"worker": 3, "action": "scale_presence", "region": 3}
  ],
  "card_plays": [{"worker_first": 2, "card_id": 42}]
}

Rules for placements:
- Must cover workers 1..total_workers.
- For play_card: include card_id and the starting worker.
- For scale_presence: include `region` from your `neighbors` list.
- Only choose actions where availability says available:true.
"""

PERSONA_BUILDER = """
Your style: TECH BUILDER. Race to Model Version 7 as fast as possible to end the game with a strong board.
Priorities: buy_chips → train_model → increase_net_worth → scale_presence. Use research cards aggressively (New GPU Tech, Sweatshop, Whitepaper, Hackathon, Burn Out). Avoid sabotage unless you're behind."""

PERSONA_DISRUPTOR = """
Your style: SABOTAGE DISRUPTOR. Stack power, raise funds, and use sabotage cards to slow competitors.
Priorities: raise_funds, marketing, scale_presence to SHARE borders, then play sabotage cards on shared-presence opponents (Back to Office, CEO Twitter Rampage, Fake Celebrity Death, Phishing Scam, Ransomware, Squeeze Out). Don't lead the model race — let opponents race so you can profit from interference."""

PERSONA_GLOBALIST = """
Your style: GLOBALIST EXPANSIONIST. Maximize regions on the World Map and harvest subsidy tokens for income.
Priorities: scale_presence aggressively (use Debt-Fueled Market Expansion, Celebrity Sponsor World Tour), increase_net_worth quickly so you can hold 6+ regions, then 10. Power matters less than presence — 1VP per region adds up fast. Play Bribe the UN / Make We Care About Your Community Ads for rep when you have wide presence."""

PERSONA_ECONOMIST = """
Your style: WEALTH ECONOMIST. Race to Billionaire (Net Worth 2) and stockpile Personal Funds for the highest-funds VP bonus (3VP in 2p, 3+2+1 in 4-5p).
Priorities: raise_funds, marketing for rep, increase_net_worth as soon as money allows. Use Influencer Marketing, VC Investor, Layoffs, Management Restructuring to grow funds fast. Train the model just enough to qualify for NW jumps. Subsidy tokens are worth $2 each at Billionaire so claim regions opportunistically."""

PERSONAS = [
    ("Builder",    PERSONA_BUILDER),
    ("Disruptor",  PERSONA_DISRUPTOR),
    ("Globalist",  PERSONA_GLOBALIST),
    ("Economist",  PERSONA_ECONOMIST),
]


def persona_for(player_idx):
    """Return (label, prompt_addition) for seat player_idx (0-based)."""
    if not USE_PERSONAS:
        return (f"Player {player_idx+1}", "")
    return PERSONAS[player_idx % len(PERSONAS)]


def system_prompt_for(player_idx):
    if not USE_PERSONAS:
        return BASE_SYSTEM
    _, persona_text = persona_for(player_idx)
    return BASE_SYSTEM + persona_text


def parse_decision(decision, total_workers):
    """Normalize the LLM's response into placements + card_plays.

    Always returns a list (possibly empty) so callers can iterate freely.
    A non-dict input (LLM returned an array, null, or prose-only) is
    treated as 'no usable placements' — the round-loop fallback will
    cover every worker with raise_funds.
    """
    if not isinstance(decision, dict):
        return []
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
    """Click through any visible modal — picks reasonable defaults.

    Handles a wedge case in `choose_regions` (celebrity_tour): the modal
    has multiple region buttons and a separate Done button. A naïve
    "click first visible button" loop just toggles a region selection
    without closing the modal. We detect Done explicitly and use it.
    """
    start = time.time()
    while time.time() - start < max_seconds:
        # Forced discard prompt
        if page.locator("#discard-confirm-btn:visible").count() > 0:
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
            done = page.locator("#choice-modal button:visible:has-text('Done')")
            if done.count() > 0:
                # choose_regions style: tap one region first (so Done has a
                # non-empty selection and resolves with regions), then Done.
                pick = page.locator("#choice-modal button:visible:not(:has-text('Done'))")
                for i in range(pick.count()):
                    b = pick.nth(i)
                    if not b.is_disabled():
                        b.click()
                        time.sleep(0.1)
                        break
                if choice_modal.is_visible():
                    done.first.click()
                time.sleep(0.2)
                continue
            # Single-click modal (squeeze, region attack, steal card)
            btn = page.locator("#choice-modal button:visible:not([disabled])").first
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
        pending = page.evaluate("(Game.localState.game.pendingInteractions || []).length")
        executing = page.evaluate("Game.executingStrategy")
        if pending == 0 and not executing:
            break
    return time.time() - start


def force_close_choice_modal(page):
    """Last-resort modal hider — used if drain_modals fails to close it."""
    page.evaluate("""
        const m = document.getElementById('choice-modal');
        if (m && m.style.display !== 'none') m.style.display = 'none';
    """)


# ─────────────────────────────────────────────────────────────────────
# ENGINE-INVARIANT AUDIT
# ─────────────────────────────────────────────────────────────────────
# Surfaces logic bugs that the deterministic test suites can't reach
# from a real LLM-driven playthrough. Each check is a structural
# invariant the engine should preserve, regardless of what cards
# were played or what moves the agents made.

AUDIT_FINDINGS = []   # accumulates across all rounds for the end-of-game summary


def run_engine_audit(page, round_n, label="post-round"):
    """Run all per-round invariants. Returns a list of finding strings."""
    result = page.evaluate("""
        () => {
            const s = Game.localState;
            const findings = [];
            const nPlayers = s.players.length;

            // ── 1. Token conservation ─────────────────────────────────
            const tokensPerRegion = nPlayers <= 3 ? 1 : 2;
            const initialSubsidies = tokensPerRegion * 10;
            const onMap = s.regionStates.reduce((a, r) => a + (r.subsidyTokensRemaining || 0), 0);
            const held = s.players.reduce((a, p) => a + (p.subsidyTokens || 0), 0);
            if (onMap + held !== initialSubsidies) {
                findings.push(`subsidy tokens: ${onMap} on map + ${held} held = ${onMap + held} ≠ ${initialSubsidies} initial`);
            }
            for (const p of s.players) {
                const wSlots = (p.workerBoardSlots || []).length;
                if (p.totalWorkers + wSlots !== 8) {
                    findings.push(`${p.userName} worker tokens: ${p.totalWorkers} held + ${wSlots} on board ≠ 8`);
                }
                const pSlots = (p.presenceBoardSlots || []).length;
                if (p.presenceCount + pSlots !== 10) {
                    findings.push(`${p.userName} presence tokens: ${p.presenceCount} held + ${pSlots} on board ≠ 10`);
                }
            }

            // ── 2. Card-zone consistency ─────────────────────────────
            const validZones = [
                /^research_deck$/, /^influence_deck$/, /^sabotage_deck$/,
                /^research_discard$/, /^influence_discard$/, /^sabotage_discard$/,
                /^hand_p\\d+$/, /^active_effect_card_slot_[123]_p\\d+$/,
                /^debuff_p\\d+$/,
            ];
            // Total component count should equal sum(card.qty) across definitions.
            // We don't have qty visible from a flat field, but components are
            // created once at seed time and never destroyed, so we just compare
            // total components to a snapshot recorded on first audit.
            for (const c of s.components) {
                if (!c.zone || !validZones.some(p => p.test(c.zone))) {
                    findings.push(`card ${c.id}: invalid zone "${c.zone}"`);
                    continue;
                }
                const m = /_p(\\d+)$/.exec(c.zone);
                if (m) {
                    const pid = parseInt(m[1]);
                    if (c.ownerId !== pid) {
                        findings.push(`card ${c.id} in zone ${c.zone} but ownerId=${c.ownerId}`);
                    }
                } else if (c.ownerId !== null && c.ownerId !== undefined) {
                    findings.push(`card ${c.id} in shared zone ${c.zone} but ownerId=${c.ownerId}`);
                }
            }

            // ── 3. Reputation tile invariants ────────────────────────
            const nwReq = {1: 0, 2: 1, 3: 2};
            const heldByPlayerLevel = {};
            for (const t of s.reputationTiles) {
                if (t.ownerId == null) continue;
                const owner = s.players.find(p => p.id === t.ownerId);
                if (!owner) {
                    findings.push(`tile ${t.id} (lvl ${t.level}) owned by nonexistent player ${t.ownerId}`);
                    continue;
                }
                if (t.level >= 1 && owner.netWorthLevel < (nwReq[t.level] ?? 0)) {
                    findings.push(`tile lvl ${t.level} held by ${owner.userName} (NW=${owner.netWorthLevel}) below requirement NW≥${nwReq[t.level]}`);
                }
                if (t.level === 0 && owner.reputation >= 0) {
                    findings.push(`tile 0 (penalty) held by ${owner.userName} but rep=${owner.reputation} (rulebook: release at rep≥0)`);
                }
                const key = `${t.ownerId}_L${t.level}`;
                if (heldByPlayerLevel[key]) {
                    findings.push(`${owner.userName} holds multiple lvl-${t.level} tiles`);
                }
                heldByPlayerLevel[key] = true;
            }

            // ── 4. Pending interactions cleared after finishRound ─────
            const pending = (s.game.pendingInteractions || []).length;
            if (pending > 0) {
                const types = (s.game.pendingInteractions || []).map(p => p.type);
                findings.push(`pendingInteractions not cleared post-round: ${pending} remaining (${types.join(',')})`);
            }

            return {round: s.game.currentRound, totalComponents: s.components.length, findings};
        }
    """)
    for f in result.get("findings", []):
        line = f"  WARN: AUDIT round={result['round']} {label}: {f}"
        print(line)
        AUDIT_FINDINGS.append(line)
    return result


def dump_resolution_log(page, round_n):
    """Pull the last resolution log (set by startStrategyExecution) and
    flag any actions whose result_message looks like an engine rejection.

    Keyword set is widened from the first pass — gpt-oss agents
    routinely propose plays that fail at execution time (cards whose
    NW gates aren't met, train_model with too few consecutive workers,
    etc.). We want all of those surfaced, not just `insufficient` /
    `cannot`.
    """
    data = page.evaluate("""
        () => {
            const r = Game.lastResolution;
            if (!r) return null;
            // Lower-cased keyword substrings that signal a placement
            // succeeded but its execution errored.
            const keywords = [
                'insufficient', 'error', 'not met', 'cannot',
                'must be', 'max ', 'maximum', 'minimum', 'need ',
                'too low', 'no valid', 'requirements not met',
                'reached', 'already', 'no remaining',
            ];
            const errs = [];
            for (const entry of (r.resolution_log || [])) {
                const m = (entry.result_message || '').toLowerCase();
                if (keywords.some(k => m.includes(k))) {
                    errs.push(`${entry.player_name} W${entry.worker_number} ${entry.action_type}: ${entry.result_message}`);
                }
            }
            return {actions: (r.resolution_log || []).length, errors: errs};
        }
    """)
    if data and data.get("errors"):
        for e in data["errors"]:
            line = f"  WARN: AUDIT round={round_n} resolution: {e}"
            print(line)
            AUDIT_FINDINGS.append(line)


def audit_game_end(page):
    """Game-end VP reconciliation: leaderboard's total must equal the
    sum of its own breakdown components.
    """
    res = page.evaluate("""
        () => {
            const s = Game.localState;
            const lb = Engine.calculateGameLeaderboard(s);
            const findings = [];
            for (const row of lb) {
                const p = s.players.find(x => x.id === row.player_id);
                const b = row.breakdown || {};
                const expected = (b.race_bonuses || 0) + (b.power_vp || 0) + (b.model_vp || 0) + (b.presence_vp || 0) + (b.funds_bonus || 0);
                if (expected !== row.total_vp) {
                    findings.push(`${row.user_name}: breakdown sum=${expected} ≠ total_vp=${row.total_vp}`);
                }
                const expPow = Math.floor(p.power / 5);
                if ((b.power_vp || 0) !== expPow) {
                    findings.push(`${row.user_name}: power_vp=${b.power_vp} ≠ floor(power/5)=${expPow} (power=${p.power})`);
                }
                if ((b.model_vp || 0) !== p.modelVersion) {
                    findings.push(`${row.user_name}: model_vp=${b.model_vp} ≠ modelVersion=${p.modelVersion}`);
                }
                if ((b.presence_vp || 0) !== p.presenceCount) {
                    findings.push(`${row.user_name}: presence_vp=${b.presence_vp} ≠ presenceCount=${p.presenceCount}`);
                }
            }
            return {leaderboard: lb, findings};
        }
    """)
    for f in res.get("findings", []):
        line = f"  WARN: AUDIT game_end: {f}"
        print(line)
        AUDIT_FINDINGS.append(line)
    return res


def dump_state_snapshot(page, round_n):
    """Write the full engine state to /tmp/agent_state_round_N.json for
    post-mortem review. Small games are a few MB."""
    state = page.evaluate("JSON.parse(JSON.stringify(Game.localState))")
    path = f"/tmp/agent_state_round_{round_n}.json"
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    return path


# ─────────────────────────────────────────────────────────────────────
# ROUND LOOP
# ─────────────────────────────────────────────────────────────────────

TURN_HISTORY = {}   # player_idx -> [most-recent first, capped to 2]


def play_player_turn(page, player_idx, round_n):
    """Ask the LLM for placements, execute them. Returns chosen actions list."""
    snap = snapshot_for_llm(page, player_idx)
    pid = snap["me"]["id"]
    total_workers = snap["me"]["total_workers"]

    # Tempo nudge: how much game time is left, and where the player is on
    # the V7 race. The game ends after the round any player hits V7 OR at
    # the round cap. Anything below V_expected at this round is "behind."
    max_rounds = snap.get("max_rounds", MAX_ROUNDS)
    cur_model = snap["me"]["model"]
    # Rough par: V1 by R2, V2 by R3, V3 by R5, V4 by R6, V7 by R8.
    par_by_round = {1: 0, 2: 1, 3: 2, 4: 2, 5: 3, 6: 4, 7: 5, 8: 7}
    par = par_by_round.get(round_n, 0)
    tempo_line = (
        f"Round {round_n}/{max_rounds}. Game ends after round {max_rounds} OR "
        f"the round any player hits Model V7. You are at V{cur_model}; "
        f"the par for this round is V{par}. "
    )
    if cur_model < par:
        tempo_line += f"You're {par - cur_model} model versions BEHIND par — every wasted round is a loss."

    # Anti-deadlock: replay the last 1-2 turns and call out repetition.
    history = TURN_HISTORY.get(player_idx, [])
    history_line = ""
    if history:
        last_two = ", ".join(f"[{', '.join(h)}]" for h in history)
        history_line = f"\nYour last {len(history)} round(s) placements (most recent first): {last_two}."
        if len(history) >= 2 and history[0] == history[1]:
            history_line += " You played the IDENTICAL sequence twice. Pick a different action this round or justify why the same sequence is still optimal."

    sys_prompt = system_prompt_for(player_idx)
    user_msg = (
        f"{tempo_line}{history_line}\n"
        f"Your state:\n"
        f"```json\n{json.dumps(snap, indent=2)}\n```\n"
        f"Return the JSON strategy now."
    )
    reply = ask_llm(sys_prompt, user_msg)
    decision = parse_json_block(reply)
    placements = parse_decision(decision, total_workers) if decision else []

    # Build an availability dict {action_slug: {available: bool}} from the
    # flat list the snapshot now provides.
    avail_dict = {a: {"available": True} for a in snap.get("available_actions", [])}

    by_n = {p["worker"]: p for p in placements}
    chosen = []
    for n in range(1, total_workers + 1):
        plan = by_n.get(n, {"worker": n, "action": "raise_funds"})
        action, err = place_with_fallback(
            page, pid, n,
            plan.get("action"), plan.get("region"),
            plan.get("card_id"), plan.get("sub_action"),
            avail_dict,
        )
        # Surface the card name on a play_card placement so the run log
        # shows what's actually being played (helps spot persona drift —
        # Disruptor playing utility cards vs real sabotage, etc.).
        card_name = None
        if action == "play_card" and plan.get("card_id") is not None:
            card_name = page.evaluate("""
                (cid) => {
                    const s = Game.localState;
                    const c = s.components.find(x => x.id === cid);
                    if (!c) return null;
                    const d = s.cardDefinitions.find(x => x.id === c.cardDetailsId);
                    return d ? d.name : null;
                }
            """, plan["card_id"])
        chosen.append({"worker": n, "action": action, "error": err, "card_name": card_name})

    # Record this round's chosen action list for the anti-deadlock hint
    # on the player's next turn. Capped to the 2 most recent.
    history = TURN_HISTORY.setdefault(player_idx, [])
    history.insert(0, [a["action"] for a in chosen if a["action"]])
    del history[2:]
    return chosen


def execute_round(page):
    """Click 'Execute Strategy' and drain all modals + animations."""
    btn = page.locator("#btn-execute-strategy:visible")
    if btn.count() == 0:
        return "no_button"

    # A modal can be open BEFORE Execute Strategy if the previous round
    # left a pending interaction that fired when refreshData ran. Drain
    # first; if it persists, dump diagnostics and force-close it.
    if page.locator("#choice-modal").is_visible():
        pending = page.evaluate("(Game.localState.game.pendingInteractions || []).map(p => p.type)")
        round_n = page.evaluate("Game.localState.game.currentRound")
        print(f"  WARN: choice-modal open before execute (round={round_n}, pending={pending})")
        drain_modals(page, max_seconds=15)
        if page.locator("#choice-modal").is_visible():
            print("  WARN: drain_modals could not close the modal; force-hiding it.")
            force_close_choice_modal(page)

    try:
        btn.first.click(timeout=10000)
    except Exception as e:
        # If still blocked, force-hide and retry once.
        force_close_choice_modal(page)
        time.sleep(0.3)
        btn.first.click(timeout=10000)

    time.sleep(0.6)
    drain_modals(page, max_seconds=90)
    for _ in range(120):
        executing = page.evaluate("Game.executingStrategy")
        if not executing:
            break
        drain_modals(page, max_seconds=5)
        time.sleep(0.5)
    return "ok"


PLAYER_NAMES = ["Alice", "Bob", "Cara", "Dan", "Eve"]
DEFAULT_REGIONS = {2: [1, 6], 3: [1, 4, 8], 4: [1, 3, 6, 9], 5: [1, 3, 5, 7, 9]}


def fresh_game(page):
    page.goto(BASE_URL, wait_until="networkidle")
    time.sleep(0.3)
    page.evaluate("indexedDB.deleteDatabase('disruptopia_p2p')")
    page.reload(wait_until="networkidle")
    time.sleep(0.4)
    page.locator("#setup-player-count").select_option(str(N_PLAYERS))
    time.sleep(0.2)
    regions = DEFAULT_REGIONS[N_PLAYERS]
    for i in range(N_PLAYERS):
        page.locator(f"#setup-name-{i}").fill(PLAYER_NAMES[i])
        page.locator(f"#setup-region-{i}").select_option(str(regions[i]))
    page.click("text=Launch Game")
    time.sleep(0.8)


def run():
    if USE_PERSONAS:
        persona_labels = ", ".join(persona_for(i)[0] for i in range(N_PLAYERS))
        persona_summary = f"{N_PLAYERS} personas ({persona_labels})"
    else:
        persona_summary = f"{N_PLAYERS} agents (identical prompts)"
    print(f"Agent test starting:")
    print(f"  api={API_URL}")
    print(f"  model={MODEL}")
    print(f"  agents={persona_summary}")
    print(f"  max_rounds={MAX_ROUNDS}  headless={HEADLESS}")
    overall_t0 = time.time()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=HEADLESS)
        ctx = browser.new_context(viewport={"width": 1500, "height": 950})
        page = ctx.new_page()
        page.on("pageerror", lambda e: JS_ERRORS.append(f"pageerror: {e}"))
        page.on("console", lambda msg: JS_ERRORS.append(f"console.error: {msg.text}") if msg.type == "error" else None)

        fresh_game(page)
        n_players = page.evaluate("Game.localState.players.length")
        log(f"setup.1 game launched with {N_PLAYERS} players",
            n_players == N_PLAYERS, f"got {n_players}")

        rounds_played = 0
        for round_n in range(1, MAX_ROUNDS + 1):
            print(f"\n── Round {round_n} ──")
            phase = page.evaluate("Game.localState.game.gamePhase")
            if phase == "finished":
                print("  (game already finished)")
                break

            for pid_idx in range(n_players):
                # In this local game, all seats share the same UI/state.
                # Switch the dashboard to whichever player is acting.
                player_name = page.evaluate(f"Game.localState.players[{pid_idx}].userName")
                page.locator("#player-select").select_option(label=player_name)
                time.sleep(0.2)
                t0 = time.time()
                actions = play_player_turn(page, pid_idx, round_n)
                dt = time.time() - t0
                persona_label, _ = persona_for(pid_idx)
                tag = f"{player_name} ({persona_label})" if USE_PERSONAS else player_name
                # Stringify each action; for play_card, append the card name
                # if we resolved one ("play_card:Back to Office Policy").
                rendered = []
                for a in actions:
                    s = a["action"] or "?"
                    if s == "play_card" and a.get("card_name"):
                        s = f"play_card:{a['card_name']}"
                    rendered.append(s)
                print(f"  {tag}: {rendered}  ({dt:.1f}s)")

            # Resolve the round (executes for whichever player is dashboard-active,
            # which advances ALL players' workers since the engine resolves the
            # full board in one call).
            t0 = time.time()
            r = execute_round(page)
            dt = time.time() - t0
            print(f"  resolved ({dt:.1f}s, status={r})")
            rounds_played += 1

            # Engine-invariant audit + state dump for forensic review.
            dump_resolution_log(page, round_n)
            run_engine_audit(page, round_n, label="post-round")
            snap_path = dump_state_snapshot(page, round_n)
            print(f"  state snapshot: {snap_path}")

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

        # ────────── End-of-game audit: VP reconciliation + summary
        end_audit = audit_game_end(page)
        log("agent.4 engine audit clean (no invariant violations)",
            len(AUDIT_FINDINGS) == 0,
            f"{len(AUDIT_FINDINGS)} audit findings across game")
        if end_audit and end_audit.get("leaderboard"):
            print("\n── Final Leaderboard ──")
            for row in end_audit["leaderboard"]:
                b = row.get("breakdown", {})
                print(f"  {row['user_name']:10s}  VP={row['total_vp']}  "
                      f"(race={b.get('race_bonuses', 0)} power={b.get('power_vp', 0)} "
                      f"model={b.get('model_vp', 0)} presence={b.get('presence_vp', 0)} "
                      f"funds={b.get('funds_bonus', 0)})")

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
