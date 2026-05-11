"""
Disruptopia P2P - Rulebook compliance test.

Each test below exercises one specific rulebook rule by directly
manipulating engine state via page.evaluate, then asserts the engine
behaves the way the rulebook says it should.

Run the server first:
    uvicorn app:app --host 0.0.0.0 --port 7869
Then:
    python tests/rulebook_test.py
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
    default_regions = {2:[1,6], 3:[1,4,8], 4:[1,3,6,9], 5:[1,3,5,7,9]}[n_players]
    for i, r in enumerate(default_regions):
        page.locator(f"#setup-name-{i}").fill(f"P{i+1}")
        page.locator(f"#setup-region-{i}").select_option(str(r))
    page.click("text=Launch Game")
    time.sleep(0.6)


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1300, "height": 900}).new_page()

        # ────────────────────────────────────────────────────────
        print("\n=== POWER CAP (rulebook p.14: 1..30) ===")
        # ────────────────────────────────────────────────────────
        fresh_game(page, 2)
        r = page.evaluate("({lo: Engine.clampPower(-5), hi: Engine.clampPower(99), mid: Engine.clampPower(15)})")
        log("P.1 clampPower lower bound is 1", r["lo"] == 1, str(r))
        log("P.2 clampPower upper bound is 30", r["hi"] == 30, str(r))
        log("P.3 clampPower passes mid value through", r["mid"] == 15, str(r))

        # ────────────────────────────────────────────────────────
        print("\n=== GAME END: any player reaches Model V7 (rulebook p.14) ===")
        # ────────────────────────────────────────────────────────
        fresh_game(page, 2)
        r = page.evaluate("""
            (() => {
                const s = Game.localState;
                // Force player 1 to V7 and give both players some corp funds.
                s.players[0].modelVersion = 7;
                s.players[0].corporateFunds = 12;
                s.players[1].corporateFunds = 8;
                s.players[1].personalFunds = 4;
                const result = Engine.finishRound(s);
                return {
                    status: result.status,
                    phase: s.game.gamePhase,
                    p1Corp: s.players[0].corporateFunds, p1Personal: s.players[0].personalFunds,
                    p2Corp: s.players[1].corporateFunds, p2Personal: s.players[1].personalFunds,
                };
            })()
        """)
        log("E.1 finishRound returns 'game_over' when V7 reached", r["status"] == "game_over", str(r))
        log("E.2 game phase is 'finished'", r["phase"] == "finished", str(r))
        log("E.3 player 1 corp siphoned to personal (12 -> personal)", r["p1Corp"] == 0 and r["p1Personal"] >= 12, str(r))
        log("E.4 player 2 corp siphoned (8 added on top of existing 4)", r["p2Corp"] == 0 and r["p2Personal"] == 4 + 8, str(r))

        # ────────────────────────────────────────────────────────
        print("\n=== TIE-BREAK ORDER (rulebook p.14) ===")
        # ────────────────────────────────────────────────────────
        # Set up a 2-player game with identical VP totals, varying by tie-break key.
        # Order checked: model > power > personal funds > reputation.
        fresh_game(page, 2)
        r = page.evaluate("""
            (() => {
                const s = Game.localState;
                // Equalize everything that contributes to VP, vary only the tie-break stat.
                s.players[0].power = 10; s.players[1].power = 10;
                s.players[0].modelVersion = 3; s.players[1].modelVersion = 3;
                s.players[0].presenceCount = 2; s.players[1].presenceCount = 2;
                s.players[0].personalFunds = 5; s.players[1].personalFunds = 5;
                s.players[0].reputation = 0; s.players[1].reputation = 0;
                s.players[0].vp = 0; s.players[1].vp = 0;

                // Test 1: model breaks tie. P1 has higher model.
                s.players[0].modelVersion = 4;
                const byModel = Engine.calculateGameLeaderboard(s);
                s.players[1].modelVersion = 4;  // re-equalize
                s.players[0].modelVersion = 4;
                // Test 2: power breaks tie (model equal).
                s.players[0].power = 12;
                const byPower = Engine.calculateGameLeaderboard(s);
                s.players[1].power = 12;
                // Test 3: personal funds break tie.
                s.players[0].personalFunds = 11;
                const byFunds = Engine.calculateGameLeaderboard(s);
                s.players[1].personalFunds = 11;
                // Test 4: reputation breaks tie.
                s.players[0].reputation = 4;
                const byRep = Engine.calculateGameLeaderboard(s);
                // Test 5: dead tie -> shared_failure.
                // P1 will still receive the +3 personal-funds bonus on a funds
                // tie (sort is stable), so offset by giving P2 +3 race-bonus VP.
                s.players[1].reputation = 4;
                s.players[1].vp = 3;
                const tie = Engine.calculateGameLeaderboard(s);
                return {byModel, byPower, byFunds, byRep, tie};
            })()
        """)
        log("T.1 model breaks tie (P1 ahead)", r["byModel"][0]["player_id"] == 1, str(r["byModel"]))
        log("T.2 power breaks tie when model tied", r["byPower"][0]["player_id"] == 1, str(r["byPower"]))
        log("T.3 personal funds break tie when power tied", r["byFunds"][0]["player_id"] == 1, str(r["byFunds"]))
        log("T.4 reputation breaks tie when funds tied", r["byRep"][0]["player_id"] == 1, str(r["byRep"]))
        log("T.5 full tie flags shared_failure on both rows",
            all(row.get("shared_failure") for row in r["tie"]), str(r["tie"]))

        # ────────────────────────────────────────────────────────
        print("\n=== PRESENCE NW CAP (rulebook p.9: 2 / 6 / 10) ===")
        # ────────────────────────────────────────────────────────
        # Use a 2-player game; P1 starts in region 1, P2 in region 6.
        # P1 starts as Startup (NW=0) with cap 2 (initial 1 + 1 expansion).
        fresh_game(page, 2)
        r = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.corporateFunds = 99;  // remove $ as a constraint
                // Startup: 1 region (initial). Can scale to 1 more → 2 total.
                const e1 = Engine.executeScalePresence(s, p1.id, 2);  // 2 is adjacent to 1
                const after1 = p1.presenceCount;
                // Now at 2 regions, still Startup → should be blocked.
                const e2 = Engine.executeScalePresence(s, p1.id, 7);  // 7 is adjacent to 2
                // Promote to Millionaire and try again.
                p1.netWorthLevel = 1;
                const e3 = Engine.executeScalePresence(s, p1.id, 7);
                return {e1, e2, e3, presenceAfter: p1.presenceCount};
            })()
        """)
        log("S.1 Startup can scale to 2 regions", r["e1"].get("action") == "presence_scaled", str(r["e1"]))
        log("S.2 Startup blocked from 3rd region", "Startup" in (r["e2"].get("error") or ""), str(r["e2"]))
        log("S.3 Millionaire can scale past Startup cap", r["e3"].get("action") == "presence_scaled", str(r["e3"]))

        # ────────────────────────────────────────────────────────
        print("\n=== REPUTATION TILES (rulebook p.13) ===")
        # ────────────────────────────────────────────────────────
        # Test 1: in a 2p game, only the player with the highest rep can claim level-1 tile.
        fresh_game(page, 2)
        r = page.evaluate("""
            (() => {
                const s = Game.localState;
                // Wipe ownership and force known reps.
                for (const t of s.reputationTiles) t.ownerId = null;
                s.players[0].reputation = 3;
                s.players[1].reputation = 7;
                Engine.rebalanceReputationTiles(s);
                const tiles = s.reputationTiles.filter(t => t.level === 1).map(t => ({eff: t.effectCode, owner: t.ownerId}));
                return tiles;
            })()
        """)
        log("R.1 higher-rep player (id=2) holds level-1 tile",
            all(t["owner"] == 2 for t in r) and len(r) == 1, str(r))

        # Test 2: rep flip — when P1's rep exceeds P2's, P1 steals it.
        r = page.evaluate("""
            (() => {
                const s = Game.localState;
                s.players[0].reputation = 9;  // now higher than P2's 7
                Engine.rebalanceReputationTiles(s);
                return s.reputationTiles.filter(t => t.level === 1).map(t => ({owner: t.ownerId}));
            })()
        """)
        log("R.2 rep flip transfers tile to new highest-rep player",
            all(t["owner"] == 1 for t in r), str(r))

        # Test 3: tile 3 sticky — once P1 has it, dropping P1's rep below 10 doesn't lose it
        # IF nobody else exceeds P1.
        r = page.evaluate("""
            (() => {
                const s = Game.localState;
                // Set up: P1 Billionaire with rep 10, P2 Startup with rep 0.
                s.players[0].netWorthLevel = 2; s.players[0].reputation = 10;
                s.players[1].netWorthLevel = 0; s.players[1].reputation = 0;
                for (const t of s.reputationTiles) t.ownerId = null;
                Engine.rebalanceReputationTiles(s);
                const tile3OwnerInitially = s.reputationTiles.filter(t => t.level === 3).map(t => t.ownerId);
                // Drop P1's rep to 4; should still hold tile 3 (sticky + still highest).
                s.players[0].reputation = 4;
                Engine.rebalanceReputationTiles(s);
                const tile3OwnerAfterDrop = s.reputationTiles.filter(t => t.level === 3).map(t => t.ownerId);
                return {tile3OwnerInitially, tile3OwnerAfterDrop};
            })()
        """)
        log("R.3 tile 3 claimed by P1 (Billionaire, rep 10)", r["tile3OwnerInitially"] == [1], str(r))
        log("R.4 tile 3 sticky: stays with P1 even after rep drops below 10",
            r["tile3OwnerAfterDrop"] == [1], str(r))

        # Test 4: forced give-back — if another Billionaire's rep exceeds P1's,
        # the tile transfers despite being below original threshold.
        r = page.evaluate("""
            (() => {
                const s = Game.localState;
                s.players[1].netWorthLevel = 2; s.players[1].reputation = 6;
                Engine.rebalanceReputationTiles(s);
                return s.reputationTiles.filter(t => t.level === 3).map(t => t.ownerId);
            })()
        """)
        log("R.5 tile 3 transfers when another Billionaire's rep exceeds P1's (both below 10)",
            r == [2], str(r))

        # Test 5: 4-player game — top 2 reputations each get a tile.
        fresh_game(page, 4)
        r = page.evaluate("""
            (() => {
                const s = Game.localState;
                for (const t of s.reputationTiles) t.ownerId = null;
                s.players[0].reputation = 8;
                s.players[1].reputation = 5;
                s.players[2].reputation = 3;
                s.players[3].reputation = 1;
                Engine.rebalanceReputationTiles(s);
                const tile1Owners = s.reputationTiles.filter(t => t.level === 1).map(t => t.ownerId).sort();
                return tile1Owners;
            })()
        """)
        # 4p game has 2 tile-1 tiles. Top 2 reps are players 1 and 2.
        log("R.6 4-player: top 2 reps both hold a level-1 tile",
            r == [1, 2], str(r))

        browser.close()

    print("\n" + "=" * 60)
    print(f"RESULTS: {PASS} passed, {FAIL} failed out of {PASS+FAIL}")
    if ERRORS:
        print("\nFailures:")
        for e in ERRORS:
            print(f"  - {e}")
    print("=" * 60)
    return FAIL == 0


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
