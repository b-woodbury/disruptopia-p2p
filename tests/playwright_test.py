"""
Disruptopia P2P - Comprehensive Playwright Tests
Tests game initialization, UI rendering, worker placement, strategy execution,
card display, and state persistence.
"""

import sys
import json
import time
from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:7869"
PASS = 0
FAIL = 0
ERRORS = []

def log_result(name, passed, detail=""):
    global PASS, FAIL
    if passed:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        ERRORS.append(f"{name}: {detail}")
        print(f"  FAIL  {name} -- {detail}")


def run_tests():
    global PASS, FAIL, ERRORS

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        page = context.new_page()

        # Collect JS console errors
        js_errors = []
        page.on("console", lambda msg: js_errors.append(f"[{msg.type}] {msg.text}") if msg.type == "error" else None)
        page.on("pageerror", lambda err: js_errors.append(f"[pageerror] {err.message}"))

        # ════════════════════════════════════════════
        # TEST GROUP 1: PAGE LOAD & SETUP SCREEN
        # ════════════════════════════════════════════
        print("\n=== GROUP 1: Page Load & Setup Screen ===")

        page.goto(BASE_URL, wait_until="networkidle")
        time.sleep(1)

        # Clear any saved state from previous runs
        page.evaluate("indexedDB.deleteDatabase('disruptopia_p2p')")
        page.reload(wait_until="networkidle")
        time.sleep(1)

        # T1.1: Page loads without JS errors
        critical_errors = [e for e in js_errors if "pageerror" in e or "Uncaught" in e.lower() or "ReferenceError" in e or "TypeError" in e]
        log_result("T1.1 Page loads without critical JS errors", len(critical_errors) == 0,
                   f"{len(critical_errors)} errors: {critical_errors[:3]}")

        # T1.2: Setup screen visible
        setup = page.locator("#setup-screen")
        log_result("T1.2 Setup screen visible", setup.is_visible())

        # T1.3: Game screen hidden
        game = page.locator("#game-screen")
        log_result("T1.3 Game screen hidden", not game.is_visible())

        # T1.4: Player count selector present
        count_sel = page.locator("#setup-player-count")
        log_result("T1.4 Player count selector present", count_sel.is_visible())

        # T1.5: Player name inputs generated
        name0 = page.locator("#setup-name-0")
        name1 = page.locator("#setup-name-1")
        log_result("T1.5 Player name inputs generated", name0.is_visible() and name1.is_visible())

        # T1.6: Region selectors generated
        region0 = page.locator("#setup-region-0")
        region1 = page.locator("#setup-region-1")
        log_result("T1.6 Region selectors generated", region0.is_visible() and region1.is_visible())

        # T1.7: Changing player count updates form
        count_sel.select_option("3")
        time.sleep(0.3)
        name2 = page.locator("#setup-name-2")
        log_result("T1.7 Changing to 3 players creates 3rd input", name2.is_visible())

        # Reset to 2 players for remaining tests
        count_sel.select_option("2")
        time.sleep(0.3)

        # ════════════════════════════════════════════
        # TEST GROUP 2: GAME CREATION
        # ════════════════════════════════════════════
        print("\n=== GROUP 2: Game Creation ===")

        js_errors.clear()

        # Set player names
        page.locator("#setup-name-0").fill("Alice")
        page.locator("#setup-name-1").fill("Bob")

        # Set starting regions (1 and 6)
        page.locator("#setup-region-0").select_option("1")
        page.locator("#setup-region-1").select_option("6")

        # Click Launch
        page.click("text=Launch Game")
        time.sleep(1)

        # T2.1: No JS errors during creation
        critical_errors = [e for e in js_errors if "pageerror" in e or "ReferenceError" in e or "TypeError" in e]
        log_result("T2.1 No JS errors during game creation", len(critical_errors) == 0,
                   f"{critical_errors[:3]}")

        # T2.2: Game screen now visible
        log_result("T2.2 Game screen visible after creation", page.locator("#game-screen").is_visible())

        # T2.3: Setup screen hidden
        log_result("T2.3 Setup screen hidden after creation", not page.locator("#setup-screen").is_visible())

        # T2.4: Round display shows Round 1
        round_text = page.locator("#round-display").inner_text()
        log_result("T2.4 Round display shows 'Round 1'", "Round 1" in round_text, round_text)

        # T2.5: Player name displayed
        user_name = page.locator("#user-name").inner_text()
        log_result("T2.5 Player name displayed", user_name == "Alice", user_name)

        # T2.6: Opponent switcher has 2 swatches (one per player)
        options = page.locator("#opponent-switcher .opp-switch").count()
        log_result("T2.6 Opponent switcher has 2 players", options == 2, f"Got {options}")

        # ════════════════════════════════════════════
        # TEST GROUP 3: INITIAL UI STATE
        # ════════════════════════════════════════════
        print("\n=== GROUP 3: Initial UI State ===")

        # T3.1: Stats display
        power = page.locator("#stat-power").inner_text()
        log_result("T3.1 Power shows '3/40'", power == "3/40", power)

        corp_funds = page.locator("#stat-corp-funds").inner_text()
        log_result("T3.2 Corp Funds shows '$3'", "$3" in corp_funds, corp_funds)

        workers = page.locator("#stat-total-workers").inner_text()
        log_result("T3.3 Workers shows '3'", "3" in workers, workers)

        reputation = page.locator("#stat-reputation").inner_text()
        log_result("T3.4 Reputation shows '0/10'", "0" in reputation, reputation)

        # T3.5: Strategy board has 8 action rows
        rows = page.locator("#strategy-grid .strategy-tile").count()
        log_result("T3.5 Strategy board has 8 action tiles", rows == 8, f"Got {rows}")

        # T3.6: Hand has cards (should have 3 from initial draw)
        hand_cards = page.locator("#player-hand > div").count()
        log_result("T3.6 Hand has initial cards", hand_cards >= 3, f"Got {hand_cards}")

        # T3.7: World map renders with presence overlay
        overlay = page.locator("#presence-overlay")
        log_result("T3.7 Presence overlay exists", overlay.is_visible())

        markers = page.locator(".region-marker").count()
        log_result("T3.8 Region markers rendered (10)", markers == 10, f"Got {markers}")

        # T3.9: Dashboard renders
        dashboard = page.locator("#player-dashboard").inner_html()
        log_result("T3.9 Dashboard renders content", len(dashboard) > 50, f"HTML len: {len(dashboard)}")

        # ════════════════════════════════════════════
        # TEST GROUP 4: ENGINE STATE INTEGRITY
        # ════════════════════════════════════════════
        print("\n=== GROUP 4: Engine State Integrity ===")

        # Read engine state directly
        state = page.evaluate("JSON.parse(JSON.stringify(Game.localState))")

        # T4.1: Game state exists
        log_result("T4.1 Game.localState exists", state is not None)

        # T4.2: Has 2 players
        log_result("T4.2 State has 2 players", len(state["players"]) == 2,
                   f"Got {len(state['players'])}")

        # T4.3: Player names correct
        names = [p["userName"] for p in state["players"]]
        log_result("T4.3 Player names correct", names == ["Alice", "Bob"], str(names))

        # T4.4: Starting funds
        funds = [p["corporateFunds"] for p in state["players"]]
        log_result("T4.4 Starting funds = $3 each", funds == [3, 3], str(funds))

        # T4.5: Starting regions
        regions = [p["presenceRegions"] for p in state["players"]]
        log_result("T4.5 Starting regions correct", regions == [[1], [6]], str(regions))

        # T4.6: Card definitions loaded
        card_defs = len(state["cardDefinitions"])
        log_result("T4.6 Card definitions loaded (55 unique)", card_defs == 55, f"Got {card_defs}")

        # T4.7: Components (card instances) in decks
        deck_cards = len([c for c in state["components"] if "deck" in c["zone"]])
        hand_cards_engine = len([c for c in state["components"] if "hand" in c["zone"]])
        log_result("T4.7 Cards dealt (6 in hands, rest in decks)",
                   hand_cards_engine == 6, f"In hands: {hand_cards_engine}, in decks: {deck_cards}")

        # T4.8: Region states initialized
        log_result("T4.8 Region states initialized (10)", len(state["regionStates"]) == 10)

        # T4.9: Reputation tiles seeded
        log_result("T4.9 Reputation tiles seeded", len(state["reputationTiles"]) > 0,
                   f"Got {len(state['reputationTiles'])}")

        # T4.10: Game phase is 'playing'
        log_result("T4.10 Game phase is 'playing'", state["game"]["gamePhase"] == "playing")

        # ════════════════════════════════════════════
        # TEST GROUP 5: WORKER PLACEMENT
        # ════════════════════════════════════════════
        print("\n=== GROUP 5: Worker Placement ===")
        js_errors.clear()

        # T5.1: Place worker on Marketing (should always be available)
        marketing_btn = page.locator(".strategy-tile").nth(4)  # Marketing is 5th action
        log_result("T5.1 Marketing '+' button visible", marketing_btn.is_visible())

        marketing_btn.click()
        time.sleep(0.5)

        # T5.2: Verify placement registered in engine
        placements = page.evaluate("Game.localState.workerPlacements.length")
        log_result("T5.2 Worker placement registered", placements == 1, f"Got {placements}")

        # T5.3: Verify placement shows in UI (worker badge)
        badge_cell = page.locator("#count-marketing").inner_html()
        log_result("T5.3 Worker badge appears in Marketing row", "1" in badge_cell, badge_cell[:50])

        # T5.4: Place another worker on Raise Funds
        raise_btn = page.locator(".strategy-tile").nth(7)  # Raise Funds is 8th
        raise_btn.click()
        time.sleep(0.5)
        placements = page.evaluate("Game.localState.workerPlacements.length")
        log_result("T5.4 Second placement registered", placements == 2, f"Got {placements}")

        # T5.5: Place 3rd worker on Buy Chips
        buy_btn = page.locator(".strategy-tile").nth(0)
        buy_btn.click()
        time.sleep(0.5)
        placements = page.evaluate("Game.localState.workerPlacements.length")
        log_result("T5.5 Third placement registered", placements == 3, f"Got {placements}")

        # T5.6: No more workers should be available (3 workers, 3 placed)
        # The '+' buttons should be hidden
        visible_btns = page.locator(".strategy-tile:not(.unavailable)").count()
        log_result("T5.6 No more '+' buttons visible (all workers placed)", visible_btns == 0,
                   f"Still visible: {visible_btns}")

        # T5.7: Undo works
        page.click("#btn-undo-placement")
        time.sleep(0.5)
        placements = page.evaluate("Game.localState.workerPlacements.length")
        log_result("T5.7 Undo removes last placement", placements == 2, f"Got {placements}")

        # T5.8: No JS errors during placement
        critical_errors = [e for e in js_errors if "pageerror" in e or "ReferenceError" in e or "TypeError" in e]
        log_result("T5.8 No JS errors during placement", len(critical_errors) == 0,
                   f"{critical_errors[:3]}")

        # Re-place the 3rd worker for execution test
        buy_btn = page.locator(".strategy-tile").nth(0)
        buy_btn.click()
        time.sleep(0.5)

        # ════════════════════════════════════════════
        # TEST GROUP 6: PLAYER SWITCHING
        # ════════════════════════════════════════════
        print("\n=== GROUP 6: Player Switching ===")

        # T6.1: Switch to Bob
        page.evaluate("switchPlayerByName(\"Bob\")")
        time.sleep(0.5)
        user_name = page.locator("#user-name").inner_text()
        log_result("T6.1 Switched to Bob", user_name == "Bob", user_name)

        # T6.2: Bob has his own hand (different cards)
        bob_hand = page.evaluate("Game.currentGameState.players.find(p => p.name === 'Bob').hand.length")
        log_result("T6.2 Bob has 3 cards in hand", bob_hand == 3, f"Got {bob_hand}")

        # T6.3: Place workers for Bob
        page.locator(".strategy-tile").nth(4).click()  # Marketing
        time.sleep(0.3)
        page.locator(".strategy-tile").nth(7).click()  # Raise Funds
        time.sleep(0.3)
        page.locator(".strategy-tile").nth(0).click()  # Buy Chips
        time.sleep(0.5)

        bob_placements = page.evaluate("""
            Game.localState.workerPlacements.filter(p => p.playerId === Game.PLAYER_ID).length
        """)
        log_result("T6.3 Bob has 3 placements", bob_placements == 3, f"Got {bob_placements}")

        # ════════════════════════════════════════════
        # TEST GROUP 7: STRATEGY EXECUTION
        # ════════════════════════════════════════════
        print("\n=== GROUP 7: Strategy Execution ===")
        js_errors.clear()

        # Get pre-execution state
        pre_state = page.evaluate("""({
            aliceFunds: Game.localState.players[0].corporateFunds,
            bobFunds: Game.localState.players[1].corporateFunds,
            aliceRep: Game.localState.players[0].reputation,
            bobRep: Game.localState.players[1].reputation,
            round: Game.localState.game.currentRound,
        })""")

        # Click Execute Strategy
        page.click("#btn-execute-strategy")

        # Wait for resolution overlay to appear, then skip
        time.sleep(1)
        skip_btn = page.locator("text=Skip Animations")
        if skip_btn.is_visible():
            skip_btn.click()

        # Wait for finishRound + discard prompts to complete
        time.sleep(5)

        # Handle any discard modal(s) that appeared. With the per-player
        # hand-limit fix every over-limit player is prompted in turn, so we
        # may see several modals back-to-back and several discards per modal.
        for _ in range(12):
            modal = page.locator("#choice-modal")
            if not modal.is_visible():
                time.sleep(0.4)
                if not modal.is_visible():
                    break
            # Pick the first unprotected card in this modal.
            # Note the space: browsers normalize inline styles as "cursor: pointer".
            card = page.locator("#modal-options > div[style*='cursor: pointer']").first
            if card.count() == 0:
                break
            card.click()
            time.sleep(0.4)
            confirm = page.locator("#discard-confirm-btn:visible")
            if confirm.count() == 0:
                break
            confirm.click()
            time.sleep(0.6)

        time.sleep(2)

        # T7.1: No JS errors during execution
        critical_errors = [e for e in js_errors if "pageerror" in e or "ReferenceError" in e or "TypeError" in e]
        log_result("T7.1 No JS errors during execution", len(critical_errors) == 0,
                   f"{critical_errors[:3]}")

        # T7.2: Round advanced
        post_round = page.evaluate("Game.localState.game.currentRound")
        log_result("T7.2 Round advanced to 2", post_round == 2, f"Got {post_round}")

        # T7.3: Placements cleared
        post_placements = page.evaluate("Game.localState.workerPlacements.length")
        log_result("T7.3 Placements cleared after round", post_placements == 0, f"Got {post_placements}")

        # T7.4: Marketing gave reputation (both players started at 0 rep, Startup marketing = +3)
        alice_rep = page.evaluate("Game.localState.players[0].reputation")
        bob_rep = page.evaluate("Game.localState.players[1].reputation")
        log_result("T7.4 Marketing gave +3 rep to both", alice_rep == 3 and bob_rep == 3,
                   f"Alice={alice_rep}, Bob={bob_rep}")

        # T7.5: Buy Chips upgraded compute (both started at level 1, cost $2)
        alice_compute = page.evaluate("Game.localState.players[0].computeLevel")
        bob_compute = page.evaluate("Game.localState.players[1].computeLevel")
        log_result("T7.5 Buy Chips upgraded compute to 2", alice_compute == 2 and bob_compute == 2,
                   f"Alice={alice_compute}, Bob={bob_compute}")

        # T7.6: Raise Funds processed (siphon corp -> personal, draw income)
        alice_personal = page.evaluate("Game.localState.players[0].personalFunds")
        log_result("T7.6 Raise Funds moved funds to personal", alice_personal > 0,
                   f"Personal funds: {alice_personal}")

        # T7.7: New cards drawn for round 2 (should have 3 more)
        alice_hand = page.evaluate("""
            Game.localState.components.filter(c => c.zone === 'hand_p' + Game.localState.players[0].id).length
        """)
        log_result("T7.7 New cards drawn for round 2", alice_hand >= 3, f"Hand size: {alice_hand}")

        # T7.8: Round display updated
        round_text = page.locator("#round-display").inner_text()
        log_result("T7.8 UI shows Round 2", "Round 2" in round_text, round_text)

        # T7.9: REGRESSION — after round 1 ended, every player's hand must be
        # at or under the hand limit. Bug: only the first player was prompted
        # to discard, letting other players keep 6+ cards.
        over_limit = page.evaluate("""
            Game.currentGameState.players
              .filter(p => (p.hand?.length || 0) > (p.hand_limit || 5))
              .map(p => ({name: p.name, hand: p.hand.length, limit: p.hand_limit || 5}))
        """)
        log_result(
            "T7.9 No player over hand limit after round advance",
            len(over_limit) == 0,
            f"Over-limit players: {over_limit}",
        )

        # ════════════════════════════════════════════
        # TEST GROUP 8: PERSISTENCE
        # ════════════════════════════════════════════
        print("\n=== GROUP 8: Persistence ===")

        # T8.1: State saved to IndexedDB
        saved = page.evaluate("""
            (async () => {
                const db = await new Promise((res, rej) => {
                    const req = indexedDB.open('disruptopia_p2p', 1);
                    req.onsuccess = e => res(e.target.result);
                    req.onerror = e => rej(e);
                });
                const tx = db.transaction('game_states', 'readonly');
                const store = tx.objectStore('game_states');
                const record = await new Promise(res => {
                    const req = store.get(1);
                    req.onsuccess = () => res(req.result);
                });
                return record !== null && record !== undefined;
            })()
        """)
        log_result("T8.1 State saved to IndexedDB", saved)

        # T8.2: Reload page — game should restore
        pre_reload_round = page.evaluate("Game.localState.game.currentRound")
        page.reload(wait_until="networkidle")
        time.sleep(1.5)

        post_reload_round = page.evaluate("Game.localState ? Game.localState.game.currentRound : -1")
        log_result("T8.2 State restored after reload", post_reload_round == pre_reload_round,
                   f"Before: {pre_reload_round}, After: {post_reload_round}")

        # T8.3: Game screen visible after reload (not setup screen)
        log_result("T8.3 Game screen visible after reload",
                   page.locator("#game-screen").is_visible() and not page.locator("#setup-screen").is_visible())

        # ════════════════════════════════════════════
        # TEST GROUP 9: VISUAL RENDERING
        # ════════════════════════════════════════════
        print("\n=== GROUP 9: Visual Rendering ===")

        # T9.1: Take screenshot for visual review
        page.screenshot(path="/home/bais/Downloads/disruptopiaP2P/tests/screenshot_game.png", full_page=False)
        log_result("T9.1 Screenshot saved", True)

        # T9.2: Header bar is not overflowing
        header_height = page.evaluate("document.getElementById('header-bar').offsetHeight")
        log_result("T9.2 Header bar reasonable height", 20 < header_height < 140,
                   f"Height: {header_height}px")

        # T9.3: Strategy panel is visible and has content
        strat_visible = page.locator("#strategy-panel").is_visible()
        strat_rows = page.locator("#strategy-grid .strategy-tile").count()
        log_result("T9.3 Strategy panel visible with tiles", strat_visible and strat_rows == 8,
                   f"Visible: {strat_visible}, Tiles: {strat_rows}")

        # T9.4: Map wrapper points at world-map.svg
        src = page.evaluate("document.getElementById('world-map-svg').getAttribute('src') || ''")
        log_result("T9.4 Map img loads world-map.svg", "world-map.svg" in src, src[:80])

        # T9.5: Presence tokens visible on map (one per player's starting region)
        tokens = page.locator(".presence-token").count()
        log_result("T9.5 Presence tokens on map", tokens >= 2, f"Got {tokens}")

        # T9.6: Hand panel shows cards
        hand_items = page.locator("#player-hand > div").count()
        log_result("T9.6 Hand panel shows cards", hand_items > 0, f"Got {hand_items}")

        # ════════════════════════════════════════════
        # TEST GROUP 10: LEADERBOARD
        # ════════════════════════════════════════════
        print("\n=== GROUP 10: Leaderboard ===")

        leaderboard = page.evaluate("Engine.calculateGameLeaderboard(Game.localState)")
        log_result("T10.1 Leaderboard calculates", leaderboard is not None and len(leaderboard) == 2)

        vp_values = [e["total_vp"] for e in leaderboard]
        log_result("T10.2 VP values are non-negative integers",
                   all(isinstance(v, int) and v >= 0 for v in vp_values), str(vp_values))

        # Both players should have VP from presence (1 region each = 1 VP) + compute/model/etc
        log_result("T10.3 Both players have at least 1 VP (from presence)",
                   all(v >= 1 for v in vp_values), str(vp_values))

        # ════════════════════════════════════════════
        # TEST GROUP 10.5: PENALTY REPUTATION TILES
        # Regression for tiles defined in config but never executed:
        # Power Drain (lose_2_power_round) and Information Leak (discard_per_round).
        # ════════════════════════════════════════════
        print("\n=== GROUP 10.5: Penalty Reputation Tiles ===")

        # Force Alice (id=1) to own a Power Drain tile at level 0, set her
        # power to 5, and put a non-intern card in her hand. Then call
        # finishRound and check that power dropped by 2 and one card moved
        # from hand to discard.
        setup = page.evaluate("""
            (() => {
                const s = Game.localState;
                const alice = s.players[0];
                alice.power = 5;
                alice.reputation = -3;
                // Wipe ALL tile ownership so only the synthetic tiles below
                // affect Alice's modifiers (otherwise Rapid Intel etc. would
                // skew the draw count).
                for (const t of s.reputationTiles) t.ownerId = null;
                // Inject two synthetic level-0 tiles owned by Alice
                s.reputationTiles.push({
                    id: 99001, level: 0, name: "Power Drain",
                    effectCode: "lose_2_power_round", ownerId: alice.id,
                });
                s.reputationTiles.push({
                    id: 99002, level: 0, name: "Information Leak",
                    effectCode: "discard_per_round", ownerId: alice.id,
                });
                // Hand pre-check: count Alice's non-intern hand cards
                const handBefore = s.components.filter(
                    c => c.zone === `hand_p${alice.id}` && c.ownerId === alice.id
                ).length;
                const result = Engine.finishRound(s);
                const handAfter = s.components.filter(
                    c => c.zone === `hand_p${alice.id}` && c.ownerId === alice.id
                ).length;
                return {
                    aliceFinalPower: alice.power,
                    handBefore, handAfter,
                    status: result.status,
                };
            })()
        """)
        log_result(
            "T10.5.1 Power Drain reduced Alice's power by 2",
            setup["aliceFinalPower"] == 3,
            f"power={setup['aliceFinalPower']} (started 5)",
        )
        # Information Leak discards 1 from old hand, then round-start draws 3
        # new cards. Net effect: hand should be (before - 1 + 3).
        expected_hand = setup["handBefore"] - 1 + 3
        log_result(
            "T10.5.2 Information Leak discarded one card before round-start draw",
            setup["handAfter"] == expected_hand,
            f"before={setup['handBefore']} after={setup['handAfter']} expected={expected_hand}",
        )

        # ════════════════════════════════════════════
        # TEST GROUP 11: RESET
        # ════════════════════════════════════════════
        print("\n=== GROUP 11: Reset ===")

        # Accept the confirm dialog
        page.on("dialog", lambda d: d.accept())
        page.click("#btn-reset-game")
        time.sleep(1)

        # T11.1: Back to setup screen
        log_result("T11.1 Reset returns to setup screen", page.locator("#setup-screen").is_visible())

        # T11.2: IndexedDB cleared
        saved_after = page.evaluate("""
            (async () => {
                try {
                    const db = await new Promise((res, rej) => {
                        const req = indexedDB.open('disruptopia_p2p', 1);
                        req.onsuccess = e => res(e.target.result);
                        req.onerror = e => rej(e);
                    });
                    const tx = db.transaction('game_states', 'readonly');
                    const store = tx.objectStore('game_states');
                    const record = await new Promise(res => {
                        const req = store.get(1);
                        req.onsuccess = () => res(req.result);
                    });
                    return record !== null && record !== undefined;
                } catch(e) { return false; }
            })()
        """)
        log_result("T11.2 IndexedDB cleared after reset", not saved_after)

        browser.close()

    # ════════════════════════════════════════════
    # SUMMARY
    # ════════════════════════════════════════════
    print(f"\n{'='*50}")
    print(f"RESULTS: {PASS} passed, {FAIL} failed out of {PASS+FAIL} tests")
    if ERRORS:
        print(f"\nFailed tests:")
        for e in ERRORS:
            print(f"  - {e}")
    print(f"{'='*50}")

    return FAIL == 0


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
