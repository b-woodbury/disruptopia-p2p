"""
Disruptopia P2P - Exploration test.
Plays multiple rounds exercising under-tested actions
(Train Model, Scale Presence, Increase Net Worth, Buy Chips, Marketing)
and asserts no JS errors and no obviously broken state across rounds.

Run the server first:
    uvicorn app:app --host 0.0.0.0 --port 7869
Then:
    python tests/exploration_test.py
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


# Action button index in the strategy table (0-based row order):
# 0 Buy Chips, 1 Recruit, 2 Train New Model, 3 Increase Net Worth,
# 4 Marketing,  5 Scale Presence, 6 Play Card, 7 Raise Funds
ACTION_INDEX = {
    "buy_chips": 0, "recruit": 1, "train_model": 2, "increase_net_worth": 3,
    "marketing": 4, "scale_presence": 5, "play_card": 6, "raise_funds": 7,
}


def click_action(page, slug):
    """Click the action button for the given slug. Returns True if visible/clickable."""
    btn = page.locator("button.btn-worker").nth(ACTION_INDEX[slug])
    if not btn.is_visible():
        return False
    btn.click()
    return True


def handle_region_picker(page, fallback_click_first=True):
    """If a region picker modal is up, click the first valid (clickable) region."""
    time.sleep(0.3)
    modal = page.locator("#choice-modal")
    if not modal.is_visible():
        return False
    region = page.locator("#modal-options div[style*='cursor: pointer']").first
    if region.count() > 0:
        region.click()
        time.sleep(0.3)
        return True
    return False


def discard_through_modals(page):
    """Click through any back-to-back discard modals."""
    for _ in range(12):
        modal = page.locator("#choice-modal")
        if not modal.is_visible():
            time.sleep(0.3)
            if not modal.is_visible():
                return
        card = page.locator("#modal-options > div[style*='cursor: pointer']").first
        if card.count() == 0:
            return
        card.click()
        time.sleep(0.3)
        confirm = page.locator("#discard-confirm-btn:visible")
        if confirm.count() == 0:
            return
        confirm.click()
        time.sleep(0.5)


def execute_round(page, js_errors):
    """Press Execute Strategy, skip animations, handle all discard modals."""
    js_errors.clear()
    page.click("#btn-execute-strategy")
    time.sleep(1)
    skip = page.locator("text=Skip Animations")
    if skip.is_visible():
        skip.click()
    time.sleep(4)
    discard_through_modals(page)
    time.sleep(1)


def assert_state_sane(page, label):
    """Generic sanity assertions on the engine state after a round."""
    state = page.evaluate("""
        ({
            players: Game.localState.players.map(p => ({
                name: p.userName,
                power: p.power,
                corp: p.corporateFunds,
                personal: p.personalFunds,
                rep: p.reputation,
                compute: p.computeLevel,
                model: p.modelVersion,
                nw: p.netWorthLevel,
                presence: p.presenceCount,
                workers: p.totalWorkers,
                handCount: Game.localState.components.filter(c => c.zone === `hand_p${p.id}` && c.ownerId === p.id).length,
            })),
            round: Game.localState.game.currentRound,
            phase: Game.localState.game.gamePhase,
        })
    """)

    for p in state["players"]:
        log(f"[{label}] {p['name']} power valid", isinstance(p["power"], int) and 0 <= p["power"] <= 40, str(p))
        log(f"[{label}] {p['name']} corp funds non-negative", p["corp"] >= 0, f"corp={p['corp']}")
        log(f"[{label}] {p['name']} personal funds non-negative", p["personal"] >= 0, f"personal={p['personal']}")
        log(f"[{label}] {p['name']} reputation in [-3,10]", -3 <= p["rep"] <= 10, f"rep={p['rep']}")
        log(f"[{label}] {p['name']} compute in [1,7]", 1 <= p["compute"] <= 7, f"compute={p['compute']}")
        log(f"[{label}] {p['name']} model in [0,7]", 0 <= p["model"] <= 7, f"model={p['model']}")
        log(f"[{label}] {p['name']} net worth in [0,2]", 0 <= p["nw"] <= 2, f"nw={p['nw']}")
        log(f"[{label}] {p['name']} presence in [1,10]", 1 <= p["presence"] <= 10, f"presence={p['presence']}")
        log(f"[{label}] {p['name']} workers in [3,8]", 3 <= p["workers"] <= 8, f"workers={p['workers']}")
        log(f"[{label}] {p['name']} hand <= limit",
            p["handCount"] <= 5,  # default limit
            f"hand={p['handCount']}")

    log(f"[{label}] game phase is playing or finished",
        state["phase"] in ("playing", "finished"), state["phase"])

    return state


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        js_errors = []
        page.on("console", lambda m: js_errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: js_errors.append(f"[pageerror] {e.message}"))

        page.goto(BASE_URL, wait_until="networkidle")
        time.sleep(0.5)
        page.evaluate("indexedDB.deleteDatabase('disruptopia_p2p')")
        page.reload(wait_until="networkidle")
        time.sleep(0.5)

        # Setup
        page.locator("#setup-player-count").select_option("2")
        page.locator("#setup-name-0").fill("Alice")
        page.locator("#setup-name-1").fill("Bob")
        page.locator("#setup-region-0").select_option("1")
        page.locator("#setup-region-1").select_option("6")
        page.click("text=Launch Game")
        time.sleep(0.8)

        print("\n=== ROUND 1: Buy Chips, Marketing, Raise Funds ===")
        # Alice
        click_action(page, "buy_chips");   time.sleep(0.2)
        click_action(page, "marketing");   time.sleep(0.2)
        click_action(page, "raise_funds"); time.sleep(0.2)
        # Bob
        page.locator("#player-select").select_option(label="Bob"); time.sleep(0.4)
        click_action(page, "buy_chips");   time.sleep(0.2)
        click_action(page, "marketing");   time.sleep(0.2)
        click_action(page, "raise_funds"); time.sleep(0.2)

        execute_round(page, js_errors)
        log("R1: no JS errors", len(js_errors) == 0, str(js_errors[:3]))
        s1 = assert_state_sane(page, "R1-end")
        log("R1: round advanced to 2", s1["round"] == 2, f"round={s1['round']}")
        log("R1: Alice compute is 2", s1["players"][0]["compute"] == 2)
        log("R1: Alice reputation is 3", s1["players"][0]["rep"] == 3)

        print("\n=== ROUND 2: Train Model, Marketing, Scale Presence ===")
        # Active player is now whoever is first (rotated). Make sure to act for both.
        for pname in ("Alice", "Bob"):
            page.locator("#player-select").select_option(label=pname); time.sleep(0.4)
            click_action(page, "train_model");    time.sleep(0.2)
            click_action(page, "marketing");      time.sleep(0.2)
            # Scale Presence: opens region picker; click first valid region.
            if click_action(page, "scale_presence"):
                handle_region_picker(page)

        execute_round(page, js_errors)
        log("R2: no JS errors", len(js_errors) == 0, str(js_errors[:3]))
        s2 = assert_state_sane(page, "R2-end")
        log("R2: round advanced to 3", s2["round"] == 3, f"round={s2['round']}")
        for p in s2["players"]:
            log(f"R2: {p['name']} model trained to >=1", p["model"] >= 1, f"model={p['model']}")
            log(f"R2: {p['name']} presence expanded to 2", p["presence"] == 2, f"presence={p['presence']}")

        print("\n=== ROUND 3: Increase Net Worth, Buy Chips, Train Model ===")
        for pname in ("Alice", "Bob"):
            page.locator("#player-select").select_option(label=pname); time.sleep(0.4)
            # First, make some funds: 1 raise_funds + 1 marketing + 1 increase_net_worth
            click_action(page, "increase_net_worth"); time.sleep(0.2)
            click_action(page, "buy_chips");          time.sleep(0.2)
            click_action(page, "raise_funds");        time.sleep(0.2)

        execute_round(page, js_errors)
        log("R3: no JS errors", len(js_errors) == 0, str(js_errors[:3]))
        s3 = assert_state_sane(page, "R3-end")
        log("R3: round advanced to 4", s3["round"] == 4, f"round={s3['round']}")

        print("\n=== ROUND 4: Try all-different mix ===")
        for pname in ("Alice", "Bob"):
            page.locator("#player-select").select_option(label=pname); time.sleep(0.4)
            click_action(page, "marketing");   time.sleep(0.2)
            click_action(page, "marketing");   time.sleep(0.2)
            click_action(page, "raise_funds"); time.sleep(0.2)

        execute_round(page, js_errors)
        log("R4: no JS errors", len(js_errors) == 0, str(js_errors[:3]))
        s4 = assert_state_sane(page, "R4-end")

        # Take final screenshot
        page.screenshot(path="/home/bais/Downloads/disruptopiaP2P/tests/screenshot_round4.png")
        print(f"\nFinal screenshot saved to tests/screenshot_round4.png")

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
