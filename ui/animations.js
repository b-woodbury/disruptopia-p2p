// ── RESOLUTION ANIMATIONS ─────────────────────────────────
// Animates the step-by-step resolution of a round's actions.

const ACTION_ICONS = {
    raise_funds: "\ud83d\udcb0",
    buy_chips: "\ud83d\udd27",
    train_model: "\ud83e\udde0",
    marketing: "\ud83d\udce2",
    scale_presence: "\ud83c\udf0d",
    increase_net_worth: "\u2b50",
    recruit: "\ud83d\udc64",
    play_card: "\ud83c\udccf",
};

const STAT_LABELS = {
    corporate_funds: "Corp Funds",
    personal_funds: "Pers Funds",
    power: "Power",
    reputation: "Reputation",
    compute_level: "Compute",
    model_version: "Model",
    total_workers: "Workers",
    income: "Income",
    subsidy_tokens: "Subsidies",
    net_worth_level: "Net Worth",
    presence_count: "Presence",
    vp: "VP",
};

// Maps stat names to header element IDs for pulse effects
const STAT_ELEMENT_MAP = {
    corporate_funds: "stat-corp-funds",
    personal_funds: "stat-pers-funds",
    power: "stat-power",
    reputation: "stat-reputation",
    income: "stat-income",
    total_workers: "stat-total-workers",
    subsidy_tokens: "stat-subsidies",
};

let _animationSkipped = false;

/**
 * Main entry point -- called from startStrategyExecution after the resolve endpoint returns.
 * Steps through each action with visual animations, then refreshes the UI.
 */
async function animateResolution(actionLog) {
    if (!actionLog || actionLog.length === 0) return;

    _animationSkipped = false;

    // Create overlay
    const overlay = document.createElement("div");
    overlay.className = "resolution-overlay";
    overlay.id = "resolution-overlay";

    // Container for action cards
    const cardContainer = document.createElement("div");
    cardContainer.style.cssText = "display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; width:100%; padding:20px; pointer-events:none;";

    // Progress indicator
    const progressEl = document.createElement("div");
    progressEl.style.cssText = "color:rgba(255,255,255,0.6); font-size:0.75rem; font-family:'Space Grotesk',system-ui,sans-serif; margin-bottom:12px; pointer-events:none;";
    cardContainer.appendChild(progressEl);

    // The action card display
    const actionCard = document.createElement("div");
    actionCard.className = "action-card";
    actionCard.id = "resolution-action-card";
    cardContainer.appendChild(actionCard);

    // Skip button
    const skipBtn = document.createElement("button");
    skipBtn.innerText = "Skip Animations";
    skipBtn.style.cssText = "margin-top:20px; padding:8px 20px; background:rgba(255,255,255,0.15); color:#fff; border:1px solid rgba(255,255,255,0.3); border-radius:8px; cursor:pointer; font-family:'Space Grotesk',system-ui,sans-serif; font-size:0.75rem; font-weight:600; pointer-events:auto; transition:background 0.2s;";
    skipBtn.onmouseenter = () => skipBtn.style.background = "rgba(255,255,255,0.25)";
    skipBtn.onmouseleave = () => skipBtn.style.background = "rgba(255,255,255,0.15)";
    skipBtn.onclick = () => { _animationSkipped = true; };
    cardContainer.appendChild(skipBtn);

    overlay.appendChild(cardContainer);
    document.body.appendChild(overlay);

    // Fade in overlay
    requestAnimationFrame(() => {
        overlay.style.opacity = "1";
    });

    // Step through each action
    for (let i = 0; i < actionLog.length; i++) {
        if (_animationSkipped) break;

        const action = actionLog[i];
        progressEl.innerText = `Action ${i + 1} of ${actionLog.length}`;

        // Build and display the action card
        await showActionCard(actionCard, action, i);

        // Pulse stats in the header bar
        await pulseStatChanges(action.stat_changes);

        // If this action is a card play, animate the slot:
        //   action card  → "resolving-discard" (slide off-left, fades)
        //   effect card  → "resolving-keep"    (pulse + settle into ACTIVE)
        // The class is removed by the next refreshData() call, which re-renders
        // the slot in its post-resolution state (empty for action, ACTIVE for effect).
        if (action.action_type === 'play_card' && action.card_id != null && !_animationSkipped) {
            const slotEl = document.querySelector(`.play-card[data-card-id="${action.card_id}"]`);
            if (slotEl) {
                slotEl.classList.add(action.card_is_effect ? 'resolving-keep' : 'resolving-discard');
            }
        }

        // Wait for card display duration (or skip)
        if (!_animationSkipped) {
            await sleep(800);
        }

        // Exit animation
        if (!_animationSkipped) {
            actionCard.classList.remove("action-card-enter");
            actionCard.classList.add("action-card-exit");
            await sleep(200);
            actionCard.classList.remove("action-card-exit");
        }
    }

    // Round complete banner
    if (!_animationSkipped) {
        const round = Game.currentGameState?.current_round || "?";
        await showRoundCompleteBanner(actionCard, progressEl, round);
    }

    // Fade out and remove overlay
    overlay.style.opacity = "0";
    await sleep(300);
    overlay.remove();
}


/**
 * Builds and animates a single action card.
 */
async function showActionCard(cardEl, action, index) {
    const playerColor = PLAYER_COLORS[action.player_id] || "#818cf8";
    const icon = ACTION_ICONS[action.action_type] || "\u2699\ufe0f";
    // Determine text color for player name based on background brightness
    const nameTextColor = isLightColor(playerColor) ? "#1e1b18" : "#ffffff";

    let html = "";

    // Player name badge
    html += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
        <span style="background:${playerColor}; color:${nameTextColor}; padding:4px 12px; border-radius:6px; font-weight:700; font-size:0.85rem; font-family:'Space Grotesk',system-ui,sans-serif;">${action.player_name}</span>
        <span style="font-size:1.4rem;">${icon}</span>
    </div>`;

    // Action type label
    const actionLabel = action.action_type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    html += `<div style="font-size:0.7rem; color:#78716c; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; font-weight:600;">${actionLabel}</div>`;

    // Card image for play_card actions
    if (action.action_type === "play_card" && action.card_image) {
        html += `<div style="display:flex; align-items:flex-start; gap:12px; margin-bottom:8px;">
            <img src="assets/${action.card_image}" style="width:80px; height:auto; border-radius:6px; border:2px solid #d4c9b8; box-shadow:0 2px 8px rgba(0,0,0,0.15);" onerror="this.style.display='none'">
            <div style="flex:1;">
                <div style="font-weight:700; font-size:0.9rem; color:#1e1b18; margin-bottom:4px;">${action.card_name || "Unknown Card"}</div>
                <div style="font-size:0.75rem; color:#1e1b18;">${action.result_message}</div>
            </div>
        </div>`;
    } else {
        // Result message
        html += `<div style="font-size:0.85rem; color:#1e1b18; font-weight:500; margin-bottom:8px;">${action.result_message}</div>`;
    }

    // Targets
    if (action.targets && action.targets.length > 0) {
        action.targets.forEach(t => {
            if (t.player_name) {
                html += `<div style="background:#fef2f2; border:1px solid #fca5a5; border-radius:6px; padding:6px 10px; margin-bottom:6px;">
                    <span style="color:#f87171; font-weight:700; font-size:0.75rem;">TARGET:</span>
                    <span style="color:#f87171; font-weight:600; font-size:0.75rem;"> ${t.player_name}</span>
                </div>`;
            } else if (t.region_id) {
                html += `<div style="background:#fef2f2; border:1px solid #fca5a5; border-radius:6px; padding:6px 10px; margin-bottom:6px;">
                    <span style="color:#f87171; font-weight:700; font-size:0.75rem;">TARGET:</span>
                    <span style="color:#f87171; font-weight:600; font-size:0.75rem;"> Region ${t.region_id}</span>
                </div>`;
            }
        });
    }

    // Stat changes
    const myChanges = action.stat_changes.filter(c => c.player_id === action.player_id);
    const otherChanges = action.stat_changes.filter(c => c.player_id !== action.player_id);

    if (myChanges.length > 0) {
        html += `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:4px;">`;
        myChanges.forEach(c => {
            const label = STAT_LABELS[c.stat] || c.stat;
            const isPositive = c.delta > 0;
            const color = isPositive ? "#4ade80" : "#f87171";
            const sign = isPositive ? "+" : "";
            const prefix = c.stat.includes("funds") ? "$" : "";
            html += `<span class="stat-change-badge" style="color:${color}; background:${isPositive ? '#f0fdf4' : '#fef2f2'}; border:1px solid ${isPositive ? '#bbf7d0' : '#fca5a5'}; padding:3px 8px; border-radius:6px; font-size:0.7rem; font-weight:700;">${sign}${prefix}${c.delta} ${label}</span>`;
        });
        html += `</div>`;
    }

    // Other player changes (from sabotage, etc.)
    if (otherChanges.length > 0) {
        const byPlayer = {};
        otherChanges.forEach(c => {
            if (!byPlayer[c.player_id]) byPlayer[c.player_id] = [];
            byPlayer[c.player_id].push(c);
        });
        for (const [pid, changes] of Object.entries(byPlayer)) {
            const pName = Game.currentGameState?.players.find(p => p.id === parseInt(pid))?.name || `Player ${pid}`;
            html += `<div style="margin-top:6px; font-size:0.65rem; color:#78716c;">${pName}:</div>`;
            html += `<div style="display:flex; flex-wrap:wrap; gap:4px;">`;
            changes.forEach(c => {
                const label = STAT_LABELS[c.stat] || c.stat;
                const isPositive = c.delta > 0;
                const color = isPositive ? "#4ade80" : "#f87171";
                const sign = isPositive ? "+" : "";
                const prefix = c.stat.includes("funds") ? "$" : "";
                html += `<span style="color:${color}; font-size:0.65rem; font-weight:600;">${sign}${prefix}${c.delta} ${label}</span>`;
            });
            html += `</div>`;
        }
    }

    // Card destination indicator
    if (action.action_type === "play_card" && action.card_name) {
        if (action.card_is_effect) {
            html += `<div style="margin-top:8px; font-size:0.65rem; color:#fbbf24; font-weight:600;">&#8594; Active Effect Slot</div>`;
        } else {
            html += `<div style="margin-top:8px; font-size:0.65rem; color:#78716c; font-weight:600;">&#8594; Discarded</div>`;
        }
    }

    cardEl.innerHTML = html;

    // Trigger enter animation
    cardEl.classList.remove("action-card-exit");
    cardEl.classList.add("action-card-enter");

    await sleep(100); // let CSS animation start
}


/**
 * Pulse stat elements in the header bar for changes to the current player.
 */
async function pulseStatChanges(statChanges) {
    if (!statChanges || statChanges.length === 0) return;

    // Only pulse stats for the currently viewed player
    const relevantChanges = statChanges.filter(c => c.player_id === Game.PLAYER_ID);

    for (const change of relevantChanges) {
        const elId = STAT_ELEMENT_MAP[change.stat];
        if (!elId) continue;
        const el = document.getElementById(elId);
        if (!el) continue;

        const cls = change.delta > 0 ? "stat-pulse-up" : "stat-pulse-down";
        el.classList.add(cls);

        // Remove after animation completes
        setTimeout(() => el.classList.remove(cls), 800);
    }
}


/**
 * Show the "Round Complete" banner.
 */
async function showRoundCompleteBanner(cardEl, progressEl, round) {
    progressEl.innerText = "";

    cardEl.innerHTML = `
        <div style="text-align:center; padding:20px;">
            <div style="font-family:'Space Grotesk',system-ui,sans-serif; font-size:1.5rem; font-weight:600; color:#818cf8; margin-bottom:10px;">Round ${round} Complete!</div>
            <div style="font-size:0.8rem; color:#78716c;">Preparing next round...</div>
        </div>
    `;

    cardEl.classList.remove("action-card-exit");
    cardEl.classList.add("action-card-enter");

    await sleep(1500);
}


/**
 * Utility: determine if a hex color is light (for contrast decisions).
 */
function isLightColor(hex) {
    if (!hex || hex.length < 4) return false;
    const c = hex.replace("#", "");
    const r = parseInt(c.substr(0, 2), 16);
    const g = parseInt(c.substr(2, 2), 16);
    const b = parseInt(c.substr(4, 2), 16);
    // Perceived brightness formula
    return (r * 299 + g * 587 + b * 114) / 1000 > 155;
}


/**
 * Utility: sleep for ms milliseconds.
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
