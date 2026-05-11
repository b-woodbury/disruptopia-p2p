"""
Disruptopia P2P - Multiplayer test.

Spins up two browser contexts (Host + Joiner) against the same server,
hosts a game on one, joins from the other, and verifies that worker
placements and the round-resolution trigger sync across both.

Run the server first:
    uvicorn app:app --host 0.0.0.0 --port 7869
Then:
    python tests/multiplayer_test.py
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


def fresh_context(p, label):
    """New isolated browser context (own IndexedDB, own localStorage)."""
    ctx = p.chromium.launch(headless=True).new_context(viewport={"width": 1300, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: print(f"[{label} pageerror] {e.message}"))
    return ctx, page


def open_fresh(page):
    page.goto(BASE_URL, wait_until="networkidle")
    time.sleep(0.4)
    page.evaluate("indexedDB.deleteDatabase('disruptopia_p2p')")
    page.reload(wait_until="networkidle")
    time.sleep(0.4)


def host_game(page):
    page.click("#setup-tab-host")
    time.sleep(0.2)
    # Default 2-player config is fine
    page.locator("#setup-name-0").fill("Alice")
    page.locator("#setup-name-1").fill("Bob")
    page.locator("#setup-region-0").select_option("1")
    page.locator("#setup-region-1").select_option("6")
    # Click "Host Game"
    page.click("#setup-launch-btn")
    # Wait for the relay round-trip
    time.sleep(2.5)
    code = page.locator("#setup-host-code-value").inner_text().strip()
    return code


def join_game(page, code, slot=2):
    page.click("#setup-tab-join")
    time.sleep(0.2)
    page.locator("#setup-join-code").fill(code)
    page.locator("#setup-join-slot").select_option(str(slot))
    page.click("text=Join Game")
    time.sleep(2.5)


def run():
    with sync_playwright() as p:
        # Two isolated contexts
        host_ctx, host_page = fresh_context(p, "host")
        join_ctx, join_page = fresh_context(p, "join")

        open_fresh(host_page)
        open_fresh(join_page)

        print("\n=== 1. Host creates room ===")
        code = host_game(host_page)
        log("1.1 game code looks valid (6 chars)", len(code) == 6 and code.isalnum(), f"code={code!r}")
        host_screen_visible = host_page.locator("#game-screen").is_visible()
        log("1.2 host advanced to game screen", host_screen_visible)
        host_mp = host_page.evaluate("Game.mp")
        log("1.3 host is in 'host' mode + connected", host_mp["mode"] == "host" and host_mp["connected"], str(host_mp))

        print("\n=== 2. Joiner connects ===")
        join_game(join_page, code, slot=2)
        join_visible = join_page.locator("#game-screen").is_visible()
        log("2.1 joiner advanced to game screen", join_visible)
        join_mp = join_page.evaluate("Game.mp")
        log("2.2 joiner is in 'join' mode + connected", join_mp["mode"] == "join" and join_mp["connected"], str(join_mp))
        join_pid = join_page.evaluate("Game.PLAYER_ID")
        log("2.3 joiner's player id is 2", join_pid == 2, f"pid={join_pid}")
        join_state = join_page.evaluate("({names: Game.localState.players.map(p=>p.userName), rounds: Game.localState.game.currentRound})")
        log("2.4 joiner received host's player list", join_state["names"] == ["Alice", "Bob"], str(join_state))

        print("\n=== 3. Host places a worker — joiner sees it ===")
        host_page.locator("button.btn-worker").nth(4).click()  # Marketing
        time.sleep(3.5)  # > polling interval (2.5s)
        host_placements = host_page.evaluate("Game.localState.workerPlacements")
        join_placements = join_page.evaluate("Game.localState.workerPlacements")
        log("3.1 host registered 1 placement", len(host_placements) == 1)
        log("3.2 joiner received host's placement", len(join_placements) == 1, f"join_placements={join_placements}")
        if len(join_placements) == 1:
            log("3.3 joiner placement actionType=marketing", join_placements[0]["actionType"] == "marketing")
            log("3.4 joiner placement playerId=1 (host)", join_placements[0]["playerId"] == 1)

        print("\n=== 4. Joiner places a worker — host sees it ===")
        join_page.locator("button.btn-worker").nth(4).click()  # Marketing for player 2
        time.sleep(3.5)
        host_placements = host_page.evaluate("Game.localState.workerPlacements")
        log("4.1 host now sees 2 placements", len(host_placements) == 2, f"host_placements={host_placements}")
        if len(host_placements) == 2:
            host_pids = sorted(p["playerId"] for p in host_placements)
            log("4.2 host sees one placement from each player", host_pids == [1, 2], f"pids={host_pids}")

        print("\n=== 5. Both place all 3 workers then host clicks Execute Strategy ===")
        # Host: 2 more workers
        host_page.locator("button.btn-worker").nth(7).click(); time.sleep(0.5)  # Raise Funds
        host_page.locator("button.btn-worker").nth(0).click(); time.sleep(0.5)  # Buy Chips
        # Joiner: 2 more workers
        join_page.locator("button.btn-worker").nth(7).click(); time.sleep(0.5)
        join_page.locator("button.btn-worker").nth(0).click(); time.sleep(0.5)

        # Wait for actions to round-trip
        time.sleep(4)
        host_count = len(host_page.evaluate("Game.localState.workerPlacements"))
        join_count = len(join_page.evaluate("Game.localState.workerPlacements"))
        log("5.1 host has all 6 placements", host_count == 6, f"host={host_count}")
        log("5.2 joiner has all 6 placements", join_count == 6, f"join={join_count}")

        # Host hits Execute Strategy
        host_page.click("#btn-execute-strategy")

        def handle_one_side(pg, label):
            skipped = False
            for _ in range(60):
                if not skipped:
                    try:
                        skip = pg.locator("text=Skip Animations")
                        if skip.is_visible():
                            skip.click(timeout=1500)
                            skipped = True
                    except Exception:
                        pass  # detached / animation churn; ignore
                modal = pg.locator("#choice-modal")
                round_n = pg.evaluate("Game.localState ? Game.localState.game.currentRound : 0")
                if modal.is_visible():
                    card = pg.locator("#modal-options > div[style*='cursor: pointer']").first
                    if card.count() > 0:
                        try:
                            card.click(timeout=1500); time.sleep(0.3)
                            confirm = pg.locator("#discard-confirm-btn:visible")
                            if confirm.count() > 0:
                                confirm.click(timeout=1500); time.sleep(0.5)
                                continue
                        except Exception:
                            pass
                if round_n >= 2 and not modal.is_visible():
                    return True
                time.sleep(0.5)
            return False

        host_ok = handle_one_side(host_page, "host")
        join_ok = handle_one_side(join_page, "join")
        log("5.3 host finished round resolution", host_ok)
        log("5.4 joiner finished round resolution", join_ok)
        # Final settling wait so any in-flight discard broadcasts cross-apply
        time.sleep(3)

        print("\n=== 6. Both sides see round advanced + hand limit respected ===")
        host_round = host_page.evaluate("Game.localState.game.currentRound")
        join_round = join_page.evaluate("Game.localState.game.currentRound")
        log("6.1 host round advanced to 2", host_round == 2, f"round={host_round}")
        log("6.2 joiner round advanced to 2", join_round == 2, f"round={join_round}")

        for pg, label, pid in [(host_page, "host", 1), (join_page, "join", 2)]:
            hand = pg.evaluate(f"Game.localState.components.filter(c => c.zone==='hand_p{pid}' && c.ownerId==={pid}).length")
            log(f"6.3 {label}: own hand within limit (<=5)", hand <= 5, f"hand={hand}")

        host_ctx.close()
        join_ctx.close()

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
