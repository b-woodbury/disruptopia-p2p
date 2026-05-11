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

        # ────────────────────────────────────────────────────────
        print("\n=== TILE EFFECTS: previously inert (level 2/3) ===")
        # ────────────────────────────────────────────────────────
        # Streamlined Ops (play_card_worker_minus_1): every Play Card costs 1
        # fewer worker. (The seed only picks 1 of 4 tiles per non-zero level
        # in 2-player games, so we inject the tile directly to make the test
        # deterministic.)
        fresh_game(page, 2)
        streamlined = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                for (const t of s.reputationTiles) t.ownerId = null;
                s.reputationTiles.push({
                    id: 88001, level: 2, name: "Streamlined Ops",
                    effectCode: "play_card_worker_minus_1", ownerId: p1.id,
                });
                const mods = Engine.getPlayerModifiers(s, p1.id);
                return {reduction: mods.card_cost_worker_reduction};
            })()
        """)
        log("E.1 Streamlined Ops surfaces card_cost_worker_reduction=1",
            streamlined.get("reduction") == 1, str(streamlined))

        # Venture Mogul (free_hand_card): first hand-card play of the round
        # is free; flag flips, second play pays normal cost.
        fresh_game(page, 2)
        venture = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                for (const t of s.reputationTiles) t.ownerId = null;
                s.reputationTiles.push({
                    id: 88002, level: 3, name: "Venture Mogul",
                    effectCode: "free_hand_card", ownerId: p1.id,
                });
                // Find a 1-cost ACTION card (Effect cards need a target slot).
                const hand = s.components.filter(c => c.zone === `hand_p${p1.id}` && c.ownerId === p1.id);
                let target = null;
                for (const h of hand) {
                    const def = s.cardDefinitions.find(d => d.id === h.cardDetailsId);
                    if (def && def.cost === 1 && !def.isEffect) { target = h; break; }
                }
                if (!target) {
                    // None in hand — promote one. Pick any 1-cost non-effect
                    // card from a deck and move it to p1's hand.
                    const all = s.components.filter(c => c.zone && c.zone.endsWith("_deck"));
                    for (const h of all) {
                        const def = s.cardDefinitions.find(d => d.id === h.cardDetailsId);
                        if (def && def.cost === 1 && !def.isEffect) {
                            h.zone = `hand_p${p1.id}`;
                            h.ownerId = p1.id;
                            target = h;
                            break;
                        }
                    }
                }
                if (!target) return {error: "no 1-cost action card available anywhere"};
                // Sanity: with no workers placed on play_card, normal cost would fail.
                // But Venture Mogul should make this work for free.
                const before = {usedFlag: p1.tempFreeHandCardUsed, workersSpent: p1.workersSpentOnCards};
                const result = Engine.playCard(s, p1.id, target.id, null, null);
                const after = {usedFlag: p1.tempFreeHandCardUsed, workersSpent: p1.workersSpentOnCards};
                return {before, after, result};
            })()
        """)
        log("V.1 Venture Mogul plays a 1-cost card with no workers placed",
            venture.get("result", {}).get("action") == "card_played", str(venture))
        log("V.2 Venture Mogul flag flips to used after first play",
            venture.get("after", {}).get("usedFlag") is True, str(venture.get("after")))
        log("V.3 No workers were consumed (Venture Mogul made it free)",
            venture.get("after", {}).get("workersSpent") == 0, str(venture.get("after")))

        # Infinite Loop (free_active_effect): can replay an active-effect card
        # for free once per round; flag flips; second call rejected.
        fresh_game(page, 2)
        infinite = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                // Tile 3 requires Billionaire to hold (rulebook p.13); without
                // this, any rep-changing card-effect rebalance would strip the
                // tile from a Startup-NW p1.
                p1.netWorthLevel = 2;
                for (const t of s.reputationTiles) t.ownerId = null;
                s.reputationTiles.push({
                    id: 88003, level: 3, name: "Infinite Loop",
                    effectCode: "free_active_effect", ownerId: p1.id,
                });
                // Move an effect card from hand into slot 1 so we have something to replay.
                const hand = s.components.filter(c => c.zone === `hand_p${p1.id}` && c.ownerId === p1.id);
                let effectCard = null;
                for (const h of hand) {
                    const def = s.cardDefinitions.find(d => d.id === h.cardDetailsId);
                    if (def && def.isEffect) { effectCard = h; break; }
                }
                if (!effectCard) return {error: "no effect card in hand"};
                effectCard.zone = `active_effect_card_slot_1_p${p1.id}`;
                // Try replay #1 — should succeed and consume the flag.
                const r1 = Engine.replayActiveEffect(s, p1.id, effectCard.id, null);
                const after1 = {usedFlag: p1.tempFreeActiveEffectUsed};
                // Try replay #2 — should fail with "Already used".
                const r2 = Engine.replayActiveEffect(s, p1.id, effectCard.id, null);
                return {r1, r2, after1};
            })()
        """)
        log("I.1 Infinite Loop replays an active effect once",
            infinite.get("r1", {}).get("action") == "active_effect_replayed", str(infinite))
        log("I.2 Infinite Loop flag flips after first replay",
            infinite.get("after1", {}).get("usedFlag") is True, str(infinite))
        log("I.3 Second replay in the same round rejected",
            "Already used" in (infinite.get("r2", {}).get("error") or ""), str(infinite.get("r2")))

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

        # ────────────────────────────────────────────────────────
        print("\n=== Sabotage drop of Compute does NOT drop Model (rulebook p.14) ===")
        # ────────────────────────────────────────────────────────
        fresh_game(page, 2)
        cooling = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                const p2 = s.players[1];
                p1.netWorthLevel = 1;
                p2.computeLevel = 5;
                p2.modelVersion = 5;
                const beforeModel = p2.modelVersion;
                const r = CardEffects.cooling_failure(s, p1.id, 0, {target_player_id: p2.id});
                return {result: r, beforeModel, afterModel: p2.modelVersion, afterCompute: p2.computeLevel};
            })()
        """)
        log("CF.1 cooling_failure decreased target's Compute by 1",
            cooling.get("afterCompute") == 4, str(cooling))
        log("CF.2 cooling_failure did NOT drop Model below Compute (rulebook p.14)",
            cooling.get("afterModel") == cooling.get("beforeModel"), str(cooling))

        # ────────────────────────────────────────────────────────
        print("\n=== Power floor of 1 (rulebook p.14) ===")
        # ────────────────────────────────────────────────────────
        fresh_game(page, 2)
        floors = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                const p2 = s.players[1];
                // Force p2 (defender) to power 2 then have p1 attack with
                // Fake Celebrity Death (-3 power) — should clamp to 1, not 0.
                p2.power = 2;
                // Ensure shared presence so the attack lands.
                p2.presenceRegions = [...p1.presenceRegions];
                const r1 = CardEffects.fake_celebrity_death(s, p1.id, 0, {target_player_id: p2.id});
                const afterFCD = p2.power;
                // Reset and test Management Restructuring (sell power for $).
                p2.power = 2;
                // Caller is p2 selling 3 power (more than available - 1).
                const r2 = CardEffects.management_restructuring(s, p2.id, 0, {amount: 3});
                return {r1, r2, afterFCD, afterRestructure: p2.power};
            })()
        """)
        log("F.1 fake_celebrity_death clamps target power at 1, not 0",
            floors.get("afterFCD") == 1, str(floors))
        log("F.2 management_restructuring never sells power below 1",
            floors.get("afterRestructure") >= 1, str(floors))

        # ────────────────────────────────────────────────────────
        print("\n=== Worker minimum 3 (rulebook p.14) ===")
        # ────────────────────────────────────────────────────────
        fresh_game(page, 2)
        wmin = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                // burn_out at 3 workers must be rejected.
                p1.totalWorkers = 3;
                const burn = CardEffects.burn_out(s, p1.id, 0, null);
                // layoffs at 3 workers must be rejected.
                const lay = CardEffects.layoffs(s, p1.id, 0, null);
                return {burn, lay, workers: p1.totalWorkers};
            })()
        """)
        log("W.1 burn_out blocked at 3 workers",
            "3 Tech Workers" in (wmin.get("burn", {}).get("error") or ""), str(wmin))
        log("W.2 layoffs blocked at 3 workers",
            "3 Tech Workers" in (wmin.get("lay", {}).get("error") or ""), str(wmin))
        log("W.3 totalWorkers unchanged (still 3)",
            wmin.get("workers") == 3, str(wmin))

        # ────────────────────────────────────────────────────────
        print("\n=== Train Model multi-upgrade in one round (rulebook p.8 example) ===")
        # ────────────────────────────────────────────────────────
        fresh_game(page, 2)
        multi = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                // Set state so 2 workers should take V0 → V2: cost V0→V1 is
                // 1 worker, V1→V2 is 1 worker (total 2). Compute must be ≥ 2.
                p1.modelVersion = 0;
                p1.computeLevel = 2;
                p1.netWorthLevel = 0;
                const r = Engine.executeTrainModel(s, p1.id, 2);
                return {r, finalVersion: p1.modelVersion};
            })()
        """)
        log("M.1 Train Model with 2 workers from V0 jumps to V2",
            multi.get("finalVersion") == 2, str(multi))
        log("M.2 executeTrainModel reports 2 upgrades applied",
            multi.get("r", {}).get("upgrades_applied") == 2, str(multi))

        # ────────────────────────────────────────────────────────
        print("\n=== Token returns to most expensive empty slot (rulebook p.14) ===")
        # ────────────────────────────────────────────────────────
        # Scenario: recruit slots 4 & 5, lose 2, re-buy 2. Per rulebook
        # p.14, lost tokens refill the *most-expensive empty board slot*,
        # so the board ends up fully refilled and the next recruits take
        # slots 4 ($2) then 5 ($3) — the same cost-pattern as starting
        # from scratch. (This is mathematically equivalent to the prior
        # "next-sequential" formula; the test is here to LOCK IN that
        # the engine now models the board explicitly and the board-slot
        # tracking stays in sync with totalWorkers across loss/refill.)
        fresh_game(page, 2)
        slots = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.corporateFunds = 99;
                p1.netWorthLevel = 2;  // unblock slot 5+ recruits
                // Recruit slot 4 ($2) then slot 5 ($3) — total $5.
                Engine.executeRecruitWorker(s, p1.id, "marketing", null, null);
                Engine.executeRecruitWorker(s, p1.id, "marketing", null, null);
                const boardAfterRecruit = [...p1.workerBoardSlots];
                const fundsAfterRecruit = p1.corporateFunds;
                // Lose 2 workers — rulebook: each lost token refills most expensive empty.
                Engine.returnWorkerToBoard(p1);
                const boardAfterLoss1 = [...p1.workerBoardSlots];
                Engine.returnWorkerToBoard(p1);
                const boardAfterLoss2 = [...p1.workerBoardSlots];
                // Re-buy 2 workers.
                Engine.executeRecruitWorker(s, p1.id, "marketing", null, null);
                const fundsAfterFirstRebuy = p1.corporateFunds;
                Engine.executeRecruitWorker(s, p1.id, "marketing", null, null);
                const fundsAfterSecondRebuy = p1.corporateFunds;
                return {boardAfterRecruit, boardAfterLoss1, boardAfterLoss2, fundsAfterRecruit, fundsAfterFirstRebuy, fundsAfterSecondRebuy};
            })()
        """)
        log("Slot.1 first loss returns token to slot 5 (most expensive empty)",
            5 in slots["boardAfterLoss1"] and 4 not in slots["boardAfterLoss1"], str(slots["boardAfterLoss1"]))
        log("Slot.2 second loss fills slot 4 — board is now full again",
            sorted(slots["boardAfterLoss2"]) == [4, 5, 6, 7, 8], str(slots["boardAfterLoss2"]))
        log("Slot.3 first re-buy charges slot 4 ($2) — lowest on the refilled board",
            slots["fundsAfterRecruit"] - slots["fundsAfterFirstRebuy"] == 2, str(slots))
        log("Slot.4 second re-buy charges slot 5 ($3)",
            slots["fundsAfterFirstRebuy"] - slots["fundsAfterSecondRebuy"] == 3, str(slots))

        # ────────────────────────────────────────────────────────
        print("\n=== Consecutive Tech Workers for Train Model (rulebook p.5/p.8) ===")
        # ────────────────────────────────────────────────────────
        # If workers 1 and 3 are on Train Model with worker 2 on Marketing,
        # they should NOT form a 2-worker group. The two TM workers fire
        # as two separate 1-worker groups.
        fresh_game(page, 2)
        consec = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.modelVersion = 0;
                p1.computeLevel = 7;  // doesn't gate
                p1.netWorthLevel = 2;
                p1.corporateFunds = 99;
                // Place workers 1, 3 on Train Model; worker 2 on Marketing.
                Engine.placeWorker(s, p1.id, 1, "train_model", null, null, null);
                Engine.placeWorker(s, p1.id, 2, "marketing", null, null, null);
                Engine.placeWorker(s, p1.id, 3, "train_model", null, null, null);
                const r = Engine.resolveEntireRound(s);
                // Each TM with 1 worker upgrades once. So V0→V1, then V1→V2.
                // (V2→V3 would need 2 consecutive workers; we don't have any.)
                return {finalVersion: p1.modelVersion, log: (r.resolution_log||[]).map(e => e.action_type||e.action||e)};
            })()
        """)
        log("CW.1 workers 1+3 on Train Model (gap) → 2 separate single-worker upgrades, V0→V2",
            consec.get("finalVersion") == 2, str(consec))

        # Contrast: workers 1+2 on Train Model (consecutive) with worker 3
        # elsewhere → 1 group of 2, multi-upgrade V0→V2 in ONE execution.
        fresh_game(page, 2)
        contig = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.modelVersion = 0;
                p1.computeLevel = 7;
                p1.netWorthLevel = 2;
                Engine.placeWorker(s, p1.id, 1, "train_model", null, null, null);
                Engine.placeWorker(s, p1.id, 2, "train_model", null, null, null);
                Engine.placeWorker(s, p1.id, 3, "marketing", null, null, null);
                const r = Engine.resolveEntireRound(s);
                return {finalVersion: p1.modelVersion};
            })()
        """)
        log("CW.2 consecutive workers 1+2 on Train Model multi-upgrade V0→V2",
            contig.get("finalVersion") == 2, str(contig))

        # ────────────────────────────────────────────────────────
        print("\n=== Presence: lost token returns to most expensive empty slot ===")
        # ────────────────────────────────────────────────────────
        fresh_game(page, 2)
        pslots = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.netWorthLevel = 2;  // unblock Millionaire/Billionaire cap
                p1.corporateFunds = 99;
                // Scale to 3 presence (cost $1, $3 = $4 total).
                // Find adjacent regions to p1's starting region 1.
                Engine.executeScalePresence(s, p1.id, 2);  // adj to 1
                Engine.executeScalePresence(s, p1.id, 7);  // adj to 2
                const fundsBefore = p1.corporateFunds;
                // Lose 2 presence (squeeze x2 via helper).
                Engine.returnPresenceToBoard(p1, 7);
                Engine.returnPresenceToBoard(p1, 2);
                // Re-scale into adjacent regions twice.
                Engine.executeScalePresence(s, p1.id, 2);
                const fundsAfterFirst = p1.corporateFunds;
                Engine.executeScalePresence(s, p1.id, 7);
                const fundsAfterSecond = p1.corporateFunds;
                return {fundsBefore, fundsAfterFirst, fundsAfterSecond};
            })()
        """)
        # Lost presence tokens refill the most-expensive empty board slot.
        # After 2 scales + 2 losses the board is back to full, and the
        # next two re-scales charge $1 (slot 2) then $3 (slot 3) — same
        # as starting fresh.
        log("PSlot.1 first presence re-buy charges $1 (slot 2, lowest on refilled board)",
            pslots["fundsBefore"] - pslots["fundsAfterFirst"] == 1, str(pslots))
        log("PSlot.2 second presence re-buy charges $3 (slot 3)",
            pslots["fundsAfterFirst"] - pslots["fundsAfterSecond"] == 3, str(pslots))

        # ────────────────────────────────────────────────────────
        print("\n=== RECRUIT sub-action: rulebook p.7-8 ===")
        # ────────────────────────────────────────────────────────
        # Rulebook: "The new Tech Worker is placed on any action of your
        # choice on your Quarterly Strategy Board and can be played this
        # round." The engine reads kwargs.targetSubAction to decide where
        # the recruited worker goes.
        fresh_game(page, 2)
        recruit = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.corporateFunds = 99;
                // Place a recruit worker that says "the new worker does Marketing".
                Engine.placeWorker(s, p1.id, 1, "recruit", null, null, "marketing");
                Engine.placeWorker(s, p1.id, 2, "marketing", null, null, null);
                Engine.placeWorker(s, p1.id, 3, "buy_chips", null, null, null);
                const beforeRep = p1.reputation;
                const result = Engine.resolveEntireRound(s);
                // Worker 4 should exist (recruited) on Marketing.
                const recruitedWorker = s.workerPlacements.find(w => w.workerNumber === 4 && w.actionType === "marketing");
                const afterRep = p1.reputation;
                return {
                    beforeRep, afterRep,
                    recruitedWorkerExists: !!recruitedWorker,
                    workerActionType: recruitedWorker ? recruitedWorker.actionType : null,
                    totalWorkers: p1.totalWorkers,
                };
            })()
        """)
        log("Re.1 Recruit creates a new worker placement targeting the chosen action",
            recruit["recruitedWorkerExists"] and recruit["workerActionType"] == "marketing",
            str(recruit))
        log("Re.2 totalWorkers incremented to 4 after recruit",
            recruit["totalWorkers"] == 4, str(recruit))
        # Each Marketing fires +3 rep at Startup. With 2 marketing workers
        # (one direct, one recruited) the rep should bump twice (0 → 6).
        log("Re.3 The recruited worker actually executed (rep bumped twice)",
            recruit["afterRep"] >= 6,
            f"before={recruit['beforeRep']} after={recruit['afterRep']}")

        # ────────────────────────────────────────────────────────
        print("\n=== Pending interactions are produced + surface to responder ===")
        # ────────────────────────────────────────────────────────
        # celebrity_tour with no `regions` payload should push a
        # `choose_regions` interaction whose responder is the player who
        # invoked it. This is the queue that the UI must drain BEFORE
        # finishRound clears it.
        fresh_game(page, 2)
        pendings = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                const fn = CardEffects.celebrity_tour;
                if (!fn) return {error: "celebrity_tour effect not found"};
                const result = fn(s, p1.id, 0, null);
                return {
                    result,
                    pendingCount: (s.game.pendingInteractions || []).length,
                    topType: (s.game.pendingInteractions || [])[0]?.type,
                    responder: (s.game.pendingInteractions || [])[0]?.responding_player_id,
                };
            })()
        """)
        log("P.1 celebrity_tour pushed a choose_regions interaction",
            pendings.get("pendingCount", 0) >= 1 and pendings.get("topType") == "choose_regions",
            str(pendings))
        log("P.2 The interaction's responder is the invoking player",
            pendings.get("responder") == 1, str(pendings))

        # ════════════════════════════════════════════════════════
        # CARD-EFFECT AUDIT (deep card-by-card pass)
        # ════════════════════════════════════════════════════════

        # ────────────────────────────────────────────────────────
        print("\n=== Consulting Fees — triggers $1/power-gain on shared opps ===")
        # ────────────────────────────────────────────────────────
        # Card text: "Shared-presence opponents pay $1 per Power gain this
        # round." Owner of consulting_fees collects $1 from the gainer for
        # each +1 power, capped by gainer's funds.
        fresh_game(page, 2)
        cf = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0], p2 = s.players[1];
                // Force shared presence
                p2.presenceRegions = [...p2.presenceRegions, ...p1.presenceRegions];
                p2.presenceCount = p2.presenceRegions.length;
                // P2 holds an active consulting_fees card
                const def = s.cardDefinitions.find(d => d.effectSlug === "consulting_fees");
                const card = s.components.find(c => c.cardDetailsId === def.id);
                card.zone = "active_effect_card_slot_1_p" + p2.id;
                card.ownerId = p2.id;
                p1.corporateFunds = 10;
                p2.corporateFunds = 0;
                Engine.gainPower(s, p1, 3);
                return {p1Funds: p1.corporateFunds, p2Funds: p2.corporateFunds};
            })()
        """)
        log("CF.1 Gainer loses $3 (1 per power)", cf["p1Funds"] == 7, str(cf))
        log("CF.2 Card owner collects the $3", cf["p2Funds"] == 3, str(cf))

        # Charge is capped by gainer's funds
        cf2 = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0], p2 = s.players[1];
                p2.presenceRegions = [...p2.presenceRegions, ...p1.presenceRegions];
                p2.presenceCount = p2.presenceRegions.length;
                const def = s.cardDefinitions.find(d => d.effectSlug === "consulting_fees");
                const card = s.components.find(c => c.cardDetailsId === def.id);
                card.zone = "active_effect_card_slot_1_p" + p2.id;
                card.ownerId = p2.id;
                p1.corporateFunds = 1;
                p2.corporateFunds = 5;
                Engine.gainPower(s, p1, 4);
                return {p1Funds: p1.corporateFunds, p2Funds: p2.corporateFunds};
            })()
        """)
        log("CF.3 Charge capped by gainer's available funds", cf2["p1Funds"] == 0 and cf2["p2Funds"] == 6, str(cf2))

        # ────────────────────────────────────────────────────────
        print("\n=== GPU Price Hike — triggers $1/compute-gain on shared opps ===")
        # ────────────────────────────────────────────────────────
        fresh_game(page, 2)
        gph = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0], p2 = s.players[1];
                p2.presenceRegions = [...p2.presenceRegions, ...p1.presenceRegions];
                p2.presenceCount = p2.presenceRegions.length;
                const def = s.cardDefinitions.find(d => d.effectSlug === "gpu_price_hike");
                const card = s.components.find(c => c.cardDetailsId === def.id);
                card.zone = "active_effect_card_slot_1_p" + p2.id;
                card.ownerId = p2.id;
                p1.corporateFunds = 20; p2.corporateFunds = 0;
                Engine.gainCompute(s, p1, 2);
                return {p1Funds: p1.corporateFunds, p2Funds: p2.corporateFunds, p1Compute: p1.computeLevel};
            })()
        """)
        log("GPH.1 P1 paid $2 for 2 compute increases", gph["p1Funds"] == 18 and gph["p1Compute"] == 3, str(gph))
        log("GPH.2 Card owner received $2", gph["p2Funds"] == 2, str(gph))

        # ────────────────────────────────────────────────────────
        print("\n=== Big Compute Energy fires on card-driven compute ===")
        # ────────────────────────────────────────────────────────
        # Card text: "Every time you increase Compute this round, +2 Power."
        # Should fire on Buy Chips AND on cards (nerdy_optimization, burn_out).
        fresh_game(page, 2)
        bce = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.tempComputeGainPowerBonus = 2;
                const before = p1.power;
                // Card-driven compute increase
                CardEffects.nerdy_optimization(s, p1.id, 0, null);
                const after = p1.power;
                return {before, after, compute: p1.computeLevel};
            })()
        """)
        log("BCE.1 nerdy_optimization fires Big Compute Energy (+2 power)",
            bce["after"] - bce["before"] == 2 and bce["compute"] == 2, str(bce))

        # Burn Out is +2 compute → should give +4 power if BCE active
        bce2 = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.netWorthLevel = 1;
                p1.tempComputeGainPowerBonus = 2;
                p1.totalWorkers = 5;
                p1.computeLevel = 1;
                const before = p1.power;
                CardEffects.burn_out(s, p1.id, 0, null);
                return {before, after: p1.power, compute: p1.computeLevel};
            })()
        """)
        log("BCE.2 burn_out (+2 compute) fires BCE twice (+4 power)",
            bce2["after"] - bce2["before"] == 4 and bce2["compute"] == 3, str(bce2))

        # ────────────────────────────────────────────────────────
        print("\n=== Reputation Tile auto-rebalance on card rep change ===")
        # ────────────────────────────────────────────────────────
        # Rulebook p.13: tiles transfer when rep ordering changes. Card
        # effects mutating rep MUST rebalance — otherwise a player keeps a
        # tile they no longer deserve.
        fresh_game(page, 2)
        rb = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0], p2 = s.players[1];
                // Strip existing tiles, inject a fresh level-1
                s.reputationTiles = [];
                s.reputationTiles.push({id: 999, level: 1, name: "Test L1", effectCode: "income_plus_1", ownerId: p1.id});
                p1.reputation = 5; p2.reputation = 3;
                // Now P2 plays Build a Fancy Schmancy HQ to spike rep
                p2.presenceCount = 3;
                CardEffects.build_hq(s, p2.id, 0, null);
                // P2's rep should now be 5; tied with P1 — P1 keeps it (sticky-to-holder)
                const ownerAfterTie = s.reputationTiles[0].ownerId;
                // Now P2 plays university_collab (+2 rep) → P2 at 7, exceeds P1
                CardEffects.university_collab(s, p2.id, 0, null);
                const ownerAfterLead = s.reputationTiles[0].ownerId;
                return {p1Rep: p1.reputation, p2Rep: p2.reputation, ownerAfterTie, ownerAfterLead};
            })()
        """)
        log("RB.1 Tie keeps existing holder (sticky-to-current)", rb["ownerAfterTie"] == 1, str(rb))
        log("RB.2 Rep change via card transfers tile to new leader", rb["ownerAfterLead"] == 2, str(rb))

        # ────────────────────────────────────────────────────────
        print("\n=== Sweatshop / Powerpoint — rep limit cap (not threshold) ===")
        # ────────────────────────────────────────────────────────
        # Card text: "Reputation Limits apply." Should allow play if rep
        # change fits the [-3, 10] cap.
        fresh_game(page, 2)
        rl = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.reputation = -1;
                const before = p1.tempModelCostWorkerReduction;
                const r = CardEffects.sweatshop(s, p1.id, 0, null);
                return {ok: !r.error, err: r.error, mcr: p1.tempModelCostWorkerReduction, rep: p1.reputation, before};
            })()
        """)
        log("RL.1 Sweatshop plays at rep -1 (would clamp to -3)",
            rl["ok"] and rl["mcr"] == rl["before"] + 2 and rl["rep"] == -3, str(rl))

        rl2 = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.reputation = -2;
                const r = CardEffects.powerpoint(s, p1.id, 0, null);
                return {ok: !r.error, err: r.error, rep: p1.reputation, compute: p1.computeLevel};
            })()
        """)
        log("RL.2 Powerpoint plays at rep -2 (would clamp to -3)",
            rl2["ok"] and rl2["rep"] == -3, str(rl2))

        rl3 = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.reputation = -3;
                const r = CardEffects.powerpoint(s, p1.id, 0, null);
                return {ok: !r.error, err: r.error};
            })()
        """)
        log("RL.3 Powerpoint rejected at rep -3 (already at floor)",
            not rl3["ok"], str(rl3))

        # ────────────────────────────────────────────────────────
        print("\n=== Spaghetti Code / Recruiting Pipeline are immediate ===")
        # ────────────────────────────────────────────────────────
        # Rulebook p.14 clarification: Spaghetti Code is a one-shot action
        # that recruits a worker without using a Recruit slot. It should
        # NOT occupy an active effect slot.
        fresh_game(page, 2)
        imm = page.evaluate("""
            (() => {
                const defs = state => state.cardDefinitions;
                const s = Game.localState;
                const sp = defs(s).find(d => d.effectSlug === "spaghetti_code");
                const rp = defs(s).find(d => d.effectSlug === "recruiting_pipeline");
                return {spIsEffect: sp.isEffect, rpIsEffect: rp.isEffect};
            })()
        """)
        log("Imm.1 spaghetti_code marked isEffect:false", imm["spIsEffect"] == False, str(imm))
        log("Imm.2 recruiting_pipeline marked isEffect:false", imm["rpIsEffect"] == False, str(imm))

        # ────────────────────────────────────────────────────────
        print("\n=== Hack Competitor Model — fires espionage / model_hype ===")
        # ────────────────────────────────────────────────────────
        # Card text: "Pay $4 to take the Train Model action." Should fire
        # the same triggers as a regular Train Model.
        fresh_game(page, 2)
        hcm = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0], p2 = s.players[1];
                p2.modelVersion = 3;
                p2.netWorthLevel = 1;
                p1.netWorthLevel = 1;
                p1.computeLevel = 4;
                p1.modelVersion = 0;
                p1.corporateFunds = 20;
                p1.presenceCount = 4;
                p2.presenceRegions = [...p2.presenceRegions, ...p1.presenceRegions];
                p2.presenceCount = p2.presenceRegions.length;
                // Give P2 corporate_espionage active
                const espDef = s.cardDefinitions.find(d => d.effectSlug === "corporate_espionage");
                const espCard = s.components.find(c => c.cardDetailsId === espDef.id);
                espCard.zone = "active_effect_card_slot_1_p" + p2.id;
                espCard.ownerId = p2.id;
                const p2PowerBefore = p2.power;
                const p1PowerBefore = p1.power;
                const r = CardEffects.hack_competitor_model(s, p1.id, 0, null);
                return {
                    err: r.error,
                    p1Model: p1.modelVersion, p1Funds: p1.corporateFunds,
                    p1PowerGain: p1.power - p1PowerBefore,
                    p2PowerGain: p2.power - p2PowerBefore,
                };
            })()
        """)
        log("HCM.1 Hack upgrades model and charges $4",
            hcm.get("p1Model") == 1 and hcm.get("p1Funds") == 16, str(hcm))
        log("HCM.2 Hack fires espionage on shared-presence owner of espionage",
            hcm.get("p2PowerGain", 0) >= 1, str(hcm))

        # Model Hype trigger via Hack
        hcm2 = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0], p2 = s.players[1];
                p2.modelVersion = 1;
                p1.netWorthLevel = 1;
                p1.computeLevel = 4;
                p1.modelVersion = 0;
                p1.corporateFunds = 20;
                p1.presenceCount = 5;
                p1.tempTrainModelPerRegionPowerBonus = true;
                const p1Power = p1.power;
                CardEffects.hack_competitor_model(s, p1.id, 0, null);
                return {gain: p1.power - p1Power, hypeAfter: p1.tempTrainModelPerRegionPowerBonus};
            })()
        """)
        log("HCM.3 Hack consumes Model Hype (+1 power per region instead of /2)",
            hcm2.get("gain", 0) >= 5 and hcm2.get("hypeAfter") == False, str(hcm2))

        # ────────────────────────────────────────────────────────
        print("\n=== Penalty Tile 0 sticky at rep -2/-1 (rulebook p.13) ===")
        # ────────────────────────────────────────────────────────
        fresh_game(page, 2)
        pt = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.reputation = -3;
                Engine.checkReputationTiles(s, p1.id);
                const tilesAtMinus3 = s.reputationTiles.filter(t => t.level === 0 && t.ownerId === p1.id).length;
                p1.reputation = -2;
                Engine.checkReputationTiles(s, p1.id);
                const tilesAtMinus2 = s.reputationTiles.filter(t => t.level === 0 && t.ownerId === p1.id).length;
                p1.reputation = -1;
                Engine.checkReputationTiles(s, p1.id);
                const tilesAtMinus1 = s.reputationTiles.filter(t => t.level === 0 && t.ownerId === p1.id).length;
                p1.reputation = 0;
                Engine.checkReputationTiles(s, p1.id);
                const tilesAtZero = s.reputationTiles.filter(t => t.level === 0 && t.ownerId === p1.id).length;
                return {tilesAtMinus3, tilesAtMinus2, tilesAtMinus1, tilesAtZero};
            })()
        """)
        log("PT.1 Tile 0 assigned at rep -3", pt["tilesAtMinus3"] == 1, str(pt))
        log("PT.2 Tile 0 sticky at rep -2", pt["tilesAtMinus2"] == 1, str(pt))
        log("PT.3 Tile 0 sticky at rep -1", pt["tilesAtMinus1"] == 1, str(pt))
        log("PT.4 Tile 0 returns at rep 0", pt["tilesAtZero"] == 0, str(pt))

        # ────────────────────────────────────────────────────────
        print("\n=== Squeeze Out — does NOT strip subsidy ===")
        # ────────────────────────────────────────────────────────
        fresh_game(page, 2)
        sq = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0], p2 = s.players[1];
                // Force shared region & target advantage
                p1.presenceRegions = [1];
                p1.presenceCount = 1;
                p2.presenceRegions = [1, 2, 3];
                p2.presenceCount = 3;
                // Sync the board so tokens for regions 1/2/3 are OFF the board
                p2.presenceBoardSlots = [5, 6, 7, 8, 9, 10];
                p2.subsidyTokens = 2;
                const res = CardEffects.squeeze_competition(s, p1.id, 0, {target_player_id: p2.id, region_id: 1});
                return {err: res && res.error, p2Subsidy: p2.subsidyTokens, p2Presence: p2.presenceCount, p2HasRegion1: p2.presenceRegions.includes(1)};
            })()
        """)
        log("Sq.1 Squeeze removed presence", sq["p2Presence"] == 2 and not sq["p2HasRegion1"], str(sq))
        log("Sq.2 Squeeze preserved subsidy tokens", sq["p2Subsidy"] == 2, str(sq))

        # ────────────────────────────────────────────────────────
        print("\n=== Intern Volunteer Program slot protection ===")
        # ────────────────────────────────────────────────────────
        # Card text: "Once played, this card cannot be discarded."
        # Slot overwrite must NOT silently discard intern.
        fresh_game(page, 2)
        intern = page.evaluate("""
            (() => {
                const s = Game.localState;
                const p1 = s.players[0];
                p1.presenceCount = 2;
                // Place intern in slot 1
                const internDef = s.cardDefinitions.find(d => d.effectSlug === "intern_program");
                const internCard = s.components.find(c => c.cardDetailsId === internDef.id);
                internCard.zone = "active_effect_card_slot_1_p" + p1.id;
                internCard.ownerId = p1.id;
                // Try to play HQ (another isEffect card) into slot 1
                const hqDef = s.cardDefinitions.find(d => d.effectSlug === "build_hq");
                const hqCard = s.components.find(c => c.cardDetailsId === hqDef.id && (c.ownerId === p1.id || c.zone === "influence_deck"));
                hqCard.zone = "hand_p" + p1.id;
                hqCard.ownerId = p1.id;
                p1.workersSpentOnCards = 0;
                // Need a play_card worker placement for the workersSpentOnCards check
                Engine.placeWorker(s, p1.id, 1, "play_card", null, hqCard.id, null);
                const r = Engine.playCard(s, p1.id, hqCard.id, 1, null);
                // Intern should still be in its slot
                const internStillThere = internCard.zone === "active_effect_card_slot_1_p" + p1.id;
                return {err: r.error, internStillThere};
            })()
        """)
        log("Int.1 playCard rejects overwriting intern slot",
            intern["err"] is not None and intern["internStillThere"], str(intern))

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
