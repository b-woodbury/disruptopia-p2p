"""
Disruptopia P2P - Projection consistency test.

For every card registered in CardProjections, this test:
  1. Sets a known player state.
  2. Manually adds a play_card placement at worker 1 for the card.
  3. Reads Engine.getProjectedPlayerState at worker 2.
  4. Asserts the projected state matches the expected delta.

This proves that a follow-up worker placed AFTER a stat-granting card
sees the post-card state — which is the rulebook-required behavior
("You must meet all card requirements at the time that you play it.")
and what was broken before the systematic fix.

For a subset of cards that grant power, the test ALSO places the
power-gated sabotage card (Patent Troll, Phishing Scam) at worker 2
and asserts the placement is accepted — the full end-to-end combo
chain that motivated this fix.

Run the server first:
    uvicorn app:app --host 0.0.0.0 --port 7869
Then:
    .venv/bin/python tests/projection_test.py
"""

import sys
import time
from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:7869"
PASS = 0
FAIL = 0
ERRORS = []


def log(name, passed, detail=""):
    global PASS, FAIL
    if passed:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        ERRORS.append(f"{name}: {detail}")
        print(f"  FAIL  {name} -- {detail}")


def fresh_game(page, n_players=2):
    page.goto(BASE_URL, wait_until="networkidle"); time.sleep(0.3)
    page.evaluate("indexedDB.deleteDatabase('disruptopia_p2p')")
    page.reload(wait_until="networkidle"); time.sleep(0.3)
    page.locator("#setup-player-count").select_option(str(n_players))
    time.sleep(0.2)
    default_regions = {2: [1, 6]}[n_players]
    for i, r in enumerate(default_regions):
        page.locator(f"#setup-name-{i}").fill(f"P{i+1}")
        page.locator(f"#setup-region-{i}").select_option(str(r))
    page.click("text=Launch Game")
    time.sleep(0.6)


def setup_player(page, player_state):
    """Mutate player 1 (id=1) and zero out worker placements, leaving the
    game in a clean 'start of round' state ready for placements."""
    page.evaluate(
        """(state) => {
            const s = Game.localState;
            const p = s.players.find(x => x.id === 1);
            for (const [k, v] of Object.entries(state)) {
                p[k] = v;
            }
            s.workerPlacements = [];
            // Reset per-round flags that could perturb projections.
            p.tempComputeGainPowerBonus = 0;
            p.tempTrainModelPerRegionPowerBonus = false;
            p.tempCardCostWorkerReduction = 0;
            p.tempModelCostWorkerReduction = 0;
            p.tempActionCostIncrease = 0;
            p.tempRecruitCostIncrease = 0;
            p.tempPresenceMonetaryDiscount = 0;
            p.tempComputeMonetaryDiscount = 0;
            p.workersSpentOnCards = 0;
        }""",
        player_state,
    )


def hand_card(page, slug, **overrides):
    """Find a card definition by effectSlug, find or create an owned
    component for player 1, place it in hand_p1. Returns the card_id.

    Overrides let you patch the card def (e.g. cost). Mostly unused.
    """
    return page.evaluate(
        """([slug, overrides]) => {
            const s = Game.localState;
            const def = s.cardDefinitions.find(d => d.effectSlug === slug);
            if (!def) throw new Error(`No card definition for slug=${slug}`);
            for (const [k, v] of Object.entries(overrides || {})) def[k] = v;
            // Find an existing component for this card def that isn't already
            // bound to another player, OR create one.
            let comp = s.components.find(c => c.cardDetailsId === def.id && (c.ownerId == null || c.ownerId === 1));
            if (!comp) {
                const newId = (s.components.reduce((m, c) => Math.max(m, c.id), 0) || 0) + 1;
                comp = { id: newId, cardDetailsId: def.id, subType: def.deck || "influence", zone: "hand_p1", ownerId: 1 };
                s.components.push(comp);
            } else {
                comp.zone = "hand_p1";
                comp.ownerId = 1;
            }
            return comp.id;
        }""",
        [slug, overrides],
    )


def place_play_card(page, worker, card_id):
    return page.evaluate(
        """([w, cid]) => {
            const r = Engine.placeWorker(Game.localState, 1, w, "play_card", null, cid, null);
            return r;
        }""",
        [worker, card_id],
    )


def project(page, up_to_worker):
    return page.evaluate(
        """(w) => Engine.getProjectedPlayerState(Game.localState, 1, w)""",
        up_to_worker,
    )


# ─────────────────────────────────────────────────────────────────────
# REGISTRY-OF-EXPECTATIONS
#
# Each entry: (slug, hand-cost, initial-state-overrides, expected-deltas-on-proj)
# Initial state is layered on top of a clean start: NW=0, corp=$10, power=3,
# rep=0, compute=1, model=0, presence_count=2, presence_regions=[1, 2],
# subsidy_tokens=0, total_workers=3, workerBoardSlots=[4,5,6,7,8].
# ─────────────────────────────────────────────────────────────────────

BASE_STATE = {
    "netWorthLevel": 0,
    "corporateFunds": 10,
    "power": 3,
    "reputation": 0,
    "computeLevel": 1,
    "modelVersion": 0,
    "presenceCount": 2,
    "presenceRegions": [1, 2],
    "subsidyTokens": 0,
    "totalWorkers": 3,
    "workerBoardSlots": [4, 5, 6, 7, 8],
    "presenceBoardSlots": [3, 4, 5, 6, 7, 8, 9, 10],
}


def merge(*states):
    out = dict(BASE_STATE)
    for s in states:
        out.update(s)
    return out


EXPECTATIONS = [
    # ── INFLUENCE ─────────────────────────────────────────────────
    ("build_hq", merge(), {"reputation": +2, "power": +2}),
    ("intern_program", merge(), {"reputation": +2}),
    ("influencer_marketing", merge({"netWorthLevel": 0}), {"corporate_funds": +6}),
    ("influencer_marketing", merge({"netWorthLevel": 1}), {"corporate_funds": +8}),
    ("influencer_marketing", merge({"netWorthLevel": 2}), {"corporate_funds": +10}),
    ("carbon_offsets", merge({"subsidyTokens": 3}), {"reputation": +3}),
    ("free_wifi", merge({"netWorthLevel": 0, "corporateFunds": 5}), {"reputation": +3, "corporate_funds": -1}),
    ("free_wifi", merge({"netWorthLevel": 1}), {"reputation": +2, "corporate_funds": -1}),
    ("free_wifi", merge({"netWorthLevel": 2}), {"reputation": +1, "corporate_funds": -1}),
    ("free_wifi", merge({"corporateFunds": 0}), {}),  # can't afford → no effect
    ("bribe_un", merge({"presenceCount": 3, "presenceRegions": [1, 2, 6]}), {"power": +3}),
    ("podcast_tour", merge({"corporateFunds": 10}), {"power": +3, "corporate_funds": -3}),
    ("podcast_tour", merge({"corporateFunds": 1}), {"power": +1, "corporate_funds": -1}),
    ("podcast_tour", merge({"corporateFunds": 0}), {}),
    ("community_ads", merge({"presenceCount": 4, "presenceRegions": [1, 2, 6, 7]}), {"reputation": +4}),
    ("hire_lobbyist", merge({"netWorthLevel": 0}), {"power": +1}),
    ("hire_lobbyist", merge({"netWorthLevel": 1}), {"power": +2}),
    ("hire_lobbyist", merge({"netWorthLevel": 2}), {"power": +3}),
    ("court_autocrat", merge({"reputation": 5, "presenceCount": 3, "presenceRegions": [1, 2, 6]}), {"power": +3, "reputation": -3}),
    ("layoffs", merge({"totalWorkers": 5}), {"corporate_funds": +15, "total_workers": -1}),
    ("vc_investor", merge({"netWorthLevel": 1, "corporateFunds": 5}), {"corporate_funds": +6}),
    ("vc_investor", merge({"netWorthLevel": 2, "corporateFunds": 5}), {"corporate_funds": +8}),
    ("university_collab", merge(), {"reputation": +2, "power": +1, "corporate_funds": +5}),

    # ── RESEARCH ──────────────────────────────────────────────────
    ("nerdy_optimization", merge(), {"compute_level": +1}),
    ("powerpoint", merge(), {"compute_level": +1, "reputation": -1}),
    ("sweatshop", merge({"reputation": 2}), {"reputation": -2}),
    ("whitepaper", merge(), {"total_workers": +1}),
    ("spaghetti_code", merge(), {"total_workers": +1}),
    ("open_source", merge({"presenceCount": 4, "presenceRegions": [1, 2, 6, 7]}), {"power": +2}),

    # ── SABOTAGE (self-stat) ──────────────────────────────────────
    ("private_jet", merge(), {"reputation": -1, "subsidy_tokens": +1}),
    ("phishing_scam", merge({"power": 10}), {"reputation": -3}),
    ("spin_media", merge(), {"reputation": +1}),
    ("freemium_infrastructure", merge(), {"power": +1}),
    ("poach_engineers", merge({"power": 6}), {"total_workers": +1, "reputation": -1}),
]


# ─────────────────────────────────────────────────────────────────────
# DRIVER
# ─────────────────────────────────────────────────────────────────────


def baseline_proj(page):
    """Snapshot the projected state at worker 2 with no placements."""
    return project(page, 2)


def check_one(page, slug, initial, deltas):
    setup_player(page, initial)
    base = baseline_proj(page)
    card_id = hand_card(page, slug)
    r = place_play_card(page, 1, card_id)
    if r.get("error"):
        return False, f"placeWorker failed: {r['error']}"
    proj = project(page, 2)
    issues = []
    # Verify EVERY expected delta is reflected
    for field, delta in deltas.items():
        before = base[field]
        after = proj[field]
        if after - before != delta:
            issues.append(f"{field}: expected delta {delta:+d}, got {after - before:+d} (before={before}, after={after})")
    # Verify NO unexpected drift on the basic stat fields
    for field in ("reputation", "power", "compute_level", "model_version", "net_worth_level", "total_workers", "subsidy_tokens"):
        if field in deltas:
            continue
        if base[field] != proj[field]:
            issues.append(f"{field}: unexpected drift {base[field]} → {proj[field]} (no projection for this card should touch it)")
    return (len(issues) == 0), "; ".join(issues)


def check_power_combo(page, power_card_slug, expected_power_after, sabotage_slug, sabotage_min_power):
    """End-to-end: place a power-granting card at W1, then a power-gated
    sabotage card at W2. Confirm placement of W2 is ACCEPTED. This is the
    exact failure mode that motivated the systematic fix."""
    setup_player(page, BASE_STATE)
    pc = hand_card(page, power_card_slug)
    r1 = place_play_card(page, 1, pc)
    if r1.get("error"):
        return False, f"W1 ({power_card_slug}) placement failed: {r1['error']}"
    sc = hand_card(page, sabotage_slug)
    r2 = place_play_card(page, 2, sc)
    # Patent Troll / Phishing has additional shared-presence resolution-time
    # checks, but VALIDATION at placement time should pass once projected
    # power ≥ requirement.
    if r2.get("error"):
        return False, f"W2 ({sabotage_slug}) placement REJECTED despite projected power: {r2['error']}"
    proj = project(page, 3)
    if proj["power"] < sabotage_min_power:
        return False, f"projected power {proj['power']} < required {sabotage_min_power}"
    return True, ""


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        fresh_game(page, n_players=2)
        time.sleep(0.5)

        print("\n── Per-card projection deltas ──")
        for slug, init, deltas in EXPECTATIONS:
            ok, msg = check_one(page, slug, init, deltas)
            label = ", ".join(f"{k}{v:+d}" for k, v in deltas.items()) or "(no-op)"
            log(f"projection.{slug:24s}  Δ {label}", ok, msg)

        print("\n── End-to-end power-gate combo chains ──")
        # Bob's original failure: Manosphere (+3 pwr) then Phishing (req ≥10)
        ok, msg = check_power_combo(page, "podcast_tour", 6, "phishing_scam", 10)
        # Default base power is 3; podcast_tour gives +3 → 6, still < 10 for Phishing.
        # Adjust: pre-set base power = 7 so podcast pushes to 10.
        # We re-do with a stronger base.
        setup_player(page, merge({"power": 7, "corporateFunds": 10}))
        pc = hand_card(page, "podcast_tour")
        r1 = place_play_card(page, 1, pc)
        manosphere_ok = not r1.get("error")
        sc = hand_card(page, "phishing_scam")
        r2 = place_play_card(page, 2, sc)
        phishing_ok = not r2.get("error")
        log("combo.manosphere_unlocks_phishing  power 7 + podcast(+3) → phishing(≥10) accepted",
            manosphere_ok and phishing_ok,
            f"manosphere_placed={manosphere_ok}, phishing_placed={phishing_ok}, phishing_err={r2.get('error')}")

        # Fancy HQ (+2 pwr) at power 3 → 5 unlocks Patent Troll (req ≥5)
        setup_player(page, merge({"power": 3, "corporateFunds": 10}))
        pc = hand_card(page, "build_hq")
        r1 = place_play_card(page, 1, pc)
        hq_ok = not r1.get("error")
        sc = hand_card(page, "patent_troll")
        r2 = place_play_card(page, 2, sc)
        troll_ok = not r2.get("error")
        log("combo.fancy_hq_unlocks_patent_troll  power 3 + HQ(+2) → patent_troll(≥5) accepted",
            hq_ok and troll_ok,
            f"hq_placed={hq_ok}, troll_placed={troll_ok}, troll_err={r2.get('error')}")

        # Hire a Lobbyist at NW1 (+2 pwr) at power 3 → 5 unlocks Patent Troll
        setup_player(page, merge({"power": 3, "netWorthLevel": 1, "corporateFunds": 10}))
        pc = hand_card(page, "hire_lobbyist")
        r1 = place_play_card(page, 1, pc)
        lob_ok = not r1.get("error")
        sc = hand_card(page, "patent_troll")
        r2 = place_play_card(page, 2, sc)
        troll_ok = not r2.get("error")
        log("combo.lobbyist_nw1_unlocks_patent_troll  power 3 + lobbyist(+2 at NW1) → troll(≥5) accepted",
            lob_ok and troll_ok,
            f"lobbyist={lob_ok}, troll={troll_ok}, troll_err={r2.get('error')}")

        # Open Source (+pwr per 2 regions) at presence 4 → +2 pwr unlocks Patent Troll
        setup_player(page, merge({"power": 3, "presenceCount": 4, "presenceRegions": [1, 2, 6, 7], "corporateFunds": 10}))
        pc = hand_card(page, "open_source")
        r1 = place_play_card(page, 1, pc)
        os_ok = not r1.get("error")
        sc = hand_card(page, "patent_troll")
        r2 = place_play_card(page, 2, sc)
        troll_ok = not r2.get("error")
        log("combo.open_source_unlocks_patent_troll  power 3 + open_source(+2 at 4 regions) → troll(≥5) accepted",
            os_ok and troll_ok,
            f"open_source={os_ok}, troll={troll_ok}, troll_err={r2.get('error')}")

        # NEGATIVE TEST: ensure projection doesn't unlock when card is NOT played.
        setup_player(page, merge({"power": 3, "corporateFunds": 10}))
        sc = hand_card(page, "patent_troll")
        r = place_play_card(page, 1, sc)
        log("negative.patent_troll_blocked_at_low_power  power 3 alone → troll(≥5) REJECTED",
            bool(r.get("error")), f"unexpected acceptance: {r}")

        # NEGATIVE TEST: card with no projection entry leaves stats alone.
        setup_player(page, merge({"power": 5, "corporateFunds": 10}))
        try:
            cid = hand_card(page, "back_to_office")
            r1 = place_play_card(page, 1, cid)
            # back_to_office is sabotage targeting opponents; no self-stat
            # projection registered → projected stats should be unchanged.
            proj = project(page, 2)
            log("negative.no_projection_for_target_only_card  back_to_office leaves self stats unchanged",
                proj["power"] == 5 and proj["reputation"] == 0,
                f"got pwr={proj['power']} rep={proj['reputation']}")
        except Exception as e:
            log("negative.no_projection_for_target_only_card", False, str(e))

        browser.close()

    print("\n" + "=" * 60)
    print(f"PROJECTION RESULTS: {PASS} passed, {FAIL} failed")
    print("=" * 60)
    if ERRORS:
        for e in ERRORS:
            print(f"  - {e}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    run()
