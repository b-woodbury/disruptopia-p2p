// ── OPPONENT SWITCHER ─────────────────────────────────────
// Renders a row of worker-token swatches in the header — one per player.
// Clicking a swatch switches the displayed player. The turn player (whose
// strategy is currently being planned) is highlighted; peeking at an opponent
// flips their hand to card backs and disables click handlers (see
// renderPlayerHand and placeWorker).
function updatePlayerSelector(players) {
    // Initialise turnPlayerId on first call.
    if (Game.turnPlayerId == null && players.length > 0) {
        Game.turnPlayerId = Game.PLAYER_ID || players[0].id;
        Game.PLAYER_ID = Game.turnPlayerId;
        localStorage.setItem('active_player_id', Game.PLAYER_ID);
    }

    const switcher = document.getElementById('opponent-switcher');
    if (switcher) {
        // In multiplayer, only the local slot is shown — peeking would leak hands.
        const isMP = Game.mp && (Game.mp.mode === 'host' || Game.mp.mode === 'join');
        switcher.innerHTML = '';
        if (!isMP) {
            players.forEach(p => {
                const isActive = p.id === Game.PLAYER_ID;
                const isTurn = p.id === Game.turnPlayerId;
                const sw = document.createElement('div');
                sw.className = 'opp-switch' + (isActive ? ' active' : '');
                sw.style.color = PLAYER_COLORS[p.id] || '#888';
                sw.title = isTurn ? `${p.name} (current turn)` : `View ${p.name}'s board`;
                sw.innerHTML = WORKER_TOKEN_SVG;
                sw.onclick = () => switchPlayer(p.id);
                switcher.appendChild(sw);
            });
        }
    }

    // Update "peeking" banner.
    const banner = document.getElementById('viewing-banner');
    if (banner) {
        if (Game.turnPlayerId && Game.PLAYER_ID !== Game.turnPlayerId) {
            const me = players.find(p => p.id === Game.PLAYER_ID);
            const turnPlayer = players.find(p => p.id === Game.turnPlayerId);
            banner.innerText = `Viewing ${me ? me.name : '?'} — ${turnPlayer ? turnPlayer.name : '?'}'s turn`;
            banner.style.display = 'inline-block';
        } else {
            banner.style.display = 'none';
        }
    }
}

// ── UI UPDATE ─────────────────────────────────────────────
function updateUI(me) {
    document.getElementById('user-name').innerText = me.name;
    const proj = getProjectedState(me);
    const projLabel = (current, projected, prefix='') => {
        if (projected !== current) return `${prefix}${current} -> ${prefix}${projected}`;
        return `${prefix}${current}`;
    };
    document.getElementById('stat-power').innerText = `${me.power}/40`;
    document.getElementById('stat-income').innerText = `$${me.income}`;
    document.getElementById('stat-subsidies').innerText = me.subsidy_tokens;
    document.getElementById('stat-corp-funds').innerText = projLabel(me.corporate_funds, proj.corporate_funds, '$');
    document.getElementById('stat-pers-funds').innerText = `$${me.personal_funds}`;
    document.getElementById('stat-total-workers').innerText = projLabel(me.total_worker_count, proj.total_worker_count);
    document.getElementById('stat-reputation').innerText = projLabel(me.reputation, proj.reputation) + '/10';

    // Ransomware lock banner
    const existingBanner = document.getElementById('ransomware-banner');
    if (existingBanner) existingBanner.remove();
    if (me.ransomware_locked >= 2) {
        const banner = document.createElement('div');
        banner.id = 'ransomware-banner';
        banner.style.cssText = "background:#fef2f2; color:#f87171; padding:8px 12px; text-align:center; font-weight:bold; font-size:0.85rem; border:1px solid #fca5a5; margin:4px 0; border-radius:8px;";
        banner.innerHTML = "RANSOMWARE: Cannot play cards this round";
        const nameEl = document.getElementById('user-name');
        if (nameEl && nameEl.parentNode) nameEl.parentNode.insertBefore(banner, nameEl.nextSibling);
    }

    // Worker chips for each tile are rendered inside renderStrategyBoard().
    renderPlayerHand(me);
}

function updateStatsTable(players) {
    const container = document.getElementById('player-dashboard');
    if (!container) return;
    const me = players.find(p => p.id === Game.PLAYER_ID) || players[0];
    if (!me) return;
    renderPlayerDashboard(me, container);
}

// ── DASHBOARD ─────────────────────────────────────────────
function renderPlayerDashboard(player, container) {
    const genCells = (type, section) => {
        let values = [];
        if (section === 'startup') {
            if (type === 'compute') values = [1, 2];
            if (type === 'model') values = [1, 2];
            if (type === 'presence') values = [2];
            if (type === 'workers') values = [3, 4];
        } else if (section === 'millionaire') {
            if (type === 'compute') values = [3, 4];
            if (type === 'model') values = [3, 4];
            if (type === 'presence') values = [3, 4];
            if (type === 'workers') values = [5, 6];
        } else if (section === 'billionaire') {
            if (type === 'compute') values = [5, 6, 7];
            if (type === 'model') values = [5, 6, 7];
            if (type === 'presence') values = [5, 6, 7];
            if (type === 'workers') values = [7, 8];
        }

        return values.map(val => {
            let content = "", isOwned = false;
            if (type === 'compute') {
                isOwned = player.compute_level >= val;
                content = isOwned ? "X" : COMPUTE_COSTS[val] || "-";
            } else if (type === 'model') {
                isOwned = player.model_version >= val;
                content = isOwned ? "X" : MODEL_COSTS[val] || "-";
            } else if (type === 'workers') {
                isOwned = player.total_worker_count >= val;
                content = isOwned ? "X" : (val <= 3 ? "X" : WORKER_COSTS[val] || "-");
            } else if (type === 'presence') {
                isOwned = (player.presence_count || 0) >= val;
                const costIdx = val - 2;
                const cost = PRESENCE_COSTS_LIST[costIdx];
                content = isOwned ? "X" : (cost !== undefined ? `$${cost}` : "-");
            }
            const bg = isOwned ? "#eef2ff" : "#faf7f2";
            const cl = isOwned ? "var(--player-color)" : "#78716c";
            return `<div style="background:${bg}; color:${cl}; border:1px solid #e5ddd0; padding:3px 4px; text-align:center; min-width:24px; font-weight:bold; font-size:0.65rem; border-radius:4px;">${content}</div>`;
        }).join('');
    };

    const ss = "border:1px solid #e5ddd0; margin-bottom:6px; padding:6px; border-radius:8px; background:#fff;";
    const sh = "text-align:center; font-weight:bold; font-size:0.65rem; border-bottom:1px solid #e5ddd0; margin-bottom:6px; padding-bottom:3px; color:#78716c;";
    const sr = "display:flex; justify-content:flex-start; margin-bottom:3px; align-items:center;";
    const sl = "width:42px; font-size:0.55rem; color:#78716c; text-align:right; padding-right:4px; flex-shrink:0;";

    const renderSec = (title, slug) => {
        const isA = (slug==='startup' && player.net_worth===0) || (slug==='millionaire' && player.net_worth===1) || (slug==='billionaire' && player.net_worth===2);
        const headerStyle = isA
            ? "text-align:center; font-weight:bold; font-size:0.85rem; border-bottom:2px solid var(--player-color); margin-bottom:6px; padding-bottom:3px; color:var(--player-color);"
            : sh;
        return `<div style="${ss}${isA ? ' border-color:var(--player-color);' : ''}">
            <div style="${headerStyle}">${title}</div>
            <div style="${sr}"><div style="${sl}">COMPUTE</div>${genCells('compute',slug)}</div>
            <div style="${sr}"><div style="${sl}">MODEL</div>${genCells('model',slug)}</div>
            <div style="${sr}"><div style="${sl}">PRESENCE</div>${genCells('presence',slug)}</div>
            <div style="${sr}"><div style="${sl}">WORKERS</div>${genCells('workers',slug)}</div>
        </div>`;
    };

    container.innerHTML = `${renderSec("STARTUP","startup")}${renderSec("MILLIONAIRE","millionaire")}${renderSec("BILLIONAIRE","billionaire")}`;
}

// ── CARDS ──────────────────────────────────────────────────
function checkHandLimit(player) {
    if (Game.isDiscarding) return;
    const limit = player.hand_limit || 5;
    if (player.hand && player.hand.length > limit) promptDiscardModal(player, limit);
}

function renderPlayerHand(player) {
    const container = document.getElementById('player-hand');
    if (!container) return;
    const committedIds = getCommittedCardIds();
    const NO_IMG = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxODAiIGhlaWdodD0iMjUwIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjMjIyIi8+PHRleHQgeD0iOTAiIHk9IjEyNSIgZm9udC1mYW1pbHk9IkNvdXJpZXIgTmV3IiBmb250LXNpemU9IjEyIiBmaWxsPSIjNjY2IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5OTyBJTUFHRTwvdGV4dD48L3N2Zz4=';

    // ── CARDS IN PLAY (right column, vertical stack) ────────────
    // 3 effect slots, top to bottom. From top: active effects (carried over from
    // prior rounds) → queued cards (selected this round but not yet resolved) →
    // free-played cards (already resolved this round) → empty slots.
    const effectsContainer = document.getElementById('active-effects-container');
    if (effectsContainer) {
        const EFFECT_SLOT_MAX = 3;
        const effects = player.active_effects || [];
        // Cards the player committed via Play Card this round — these used to
        // render as "QUEUED" inside the hand row; they now move to a play-slot.
        const queuedCards = (player.hand || []).filter(c => committedIds.has(c.id));
        const freePlayed = (Game.cardsPlayedThisTurn || []).filter(c => !committedIds.has(c.id));
        const thisTurn = [...queuedCards, ...freePlayed];

        const slotEntries = [];
        for (let i = 0; i < EFFECT_SLOT_MAX; i++) {
            if (i < effects.length) {
                slotEntries.push({ kind: 'active', card: effects[i] });
            } else if (i - effects.length < thisTurn.length) {
                slotEntries.push({ kind: 'this-turn', card: thisTurn[i - effects.length] });
            } else {
                slotEntries.push({ kind: 'empty', idx: i + 1 });
            }
        }

        const renderPlaySlot = (e) => {
            if (e.kind === 'empty') return `<div class="play-slot empty"></div>`;
            const img = e.card.image_file ? `assets/${e.card.image_file}` : '';
            const cls = e.kind === 'active' ? 'active-effect' : 'this-turn';
            const cardId = e.card.id != null ? ` data-card-id="${e.card.id}"` : '';
            return `<div class="play-card ${cls}"${cardId}><img src="${img}" onerror="this.src='${NO_IMG}'"></div>`;
        };

        const infiniteAvailable = player.free_active_effect_available && effects.length > 0;
        const ilButton = infiniteAvailable
            ? `<button id="btn-replay-active-effect" onclick="replayActiveEffectFree()" style="margin-top:8px; padding:6px 10px; font-size:0.65rem; font-weight:600; background:#a78bfa; color:#fff; border:none; border-radius:6px; cursor:pointer;">Replay Active Effect (Infinite Loop, free)</button>`
            : '';

        effectsContainer.innerHTML = `
            <div class="play-slots-col">${slotEntries.map(renderPlaySlot).join('')}</div>
            ${ilButton}
        `;
    }

    // ── HAND (bottom row) ───────────────────────────────────────
    // Queued cards moved to the play-slots column; render only the cards still
    // sitting in hand. Empty hand_limit slots get a dashed outline. If we're
    // peeking at an opponent's board (PLAYER_ID != turnPlayerId), the opponent's
    // hand is flipped — we show generic card backs, not the actual cards.
    const visibleHand = (player.hand || []).filter(c => !committedIds.has(c.id));
    const HAND_MAX = player.hand_limit || 5;
    const isPeeking = Game.turnPlayerId != null && Game.PLAYER_ID !== Game.turnPlayerId;

    const CARD_BACKS = [
        'assets/svg/card-back-research.svg',
        'assets/svg/card-back-influence.svg',
        'assets/svg/card-back-sabotage.svg',
    ];

    const renderCard = (card, idx) => {
        if (isPeeking) {
            // Cycle through the three deck-back designs by card position so the
            // back row looks like a mixed hand instead of a wall of one design.
            const back = CARD_BACKS[idx % CARD_BACKS.length];
            return `<div class="hand-card face-down"><img src="${back}" alt="Face-down card"></div>`;
        }
        const img = card.image_file ? `assets/${card.image_file}` : '';
        return `<div class="hand-card"><img src="${img}" onerror="this.src='${NO_IMG}'"></div>`;
    };

    const slotsHtml = [];
    for (let i = 0; i < HAND_MAX; i++) {
        if (i < visibleHand.length) {
            slotsHtml.push(renderCard(visibleHand[i], i));
        } else {
            slotsHtml.push(`<div class="hand-slot empty"></div>`);
        }
    }
    container.innerHTML = slotsHtml.join('');
}

// ── STRATEGY BOARD ────────────────────────────────────────
const ACTION_ICON_MAP = {
    buy_chips: 'assets/svg/buy-chips-icon.svg',
    recruit: 'assets/svg/recruit-icon.svg',
    train_model: 'assets/svg/train-model-icon.svg',
    increase_net_worth: 'assets/svg/increase-net-worth-icon.svg',
    marketing: 'assets/svg/marketing-icon.svg',
    scale_presence: 'assets/svg/scale-presence-icon.svg',
    play_card: 'assets/svg/play-card-icon.svg',
    raise_funds: 'assets/svg/raise-funds-icon.svg',
};
const SPECIAL_RED_ACTIONS = new Set(['play_card', 'raise_funds']);

function renderStrategyBoard() {
    const container = document.getElementById('strategy-grid');
    if (!container) return;
    const me = Game.currentGameState?.players.find(p => p.id === Game.PLAYER_ID);

    container.innerHTML = ACTIONS.map(action => {
        let slug = action.toLowerCase().replace(/ /g, '_');
        if (slug === 'train_new_model') slug = 'train_model';
        let avail = me ? isActionAvailable(slug) : false;
        if (slug === 'play_card' && me && me.ransomware_locked >= 2) avail = false;

        let cost = "\u2014";
        let costClass = "";
        let costSub = "";
        if (me) {
            if (slug === 'buy_chips') {
                const c = COMPUTE_COSTS[me.compute_level+1];
                if (c) cost = c; else { cost = "MAX"; costClass = "cost-max"; }
            }
            else if (slug === 'recruit') {
                if (me.next_worker_cost != null) {
                    cost = `$${me.next_worker_cost}`;
                } else {
                    const nextW = me.total_worker_count + 1;
                    if (nextW > 8) { cost = "MAX"; costClass = "cost-max"; }
                    else cost = WORKER_COSTS[nextW] || WORKER_COSTS[4] || "$2";
                }
            }
            else if (slug === 'train_model') {
                const modelRed = getProjectedModelCostReduction(me);
                const tp = Game.currentGameState.placements.filter(p => p.player_id===Game.PLAYER_ID && p.action_type==='train_model' && Number.isInteger(p.worker_number));
                const hasFreeQueued = Game.currentGameState.placements.some(p => p.player_id===Game.PLAYER_ID && p.action_type==='train_model' && !Number.isInteger(p.worker_number));
                let wu = tp.length, pv = me.model_version;
                while (pv < 7 && wu > 0) { const bc = parseInt((MODEL_COSTS[pv+1]||"1w").replace('w','')); const c = Math.max(0, bc - modelRed); if (wu >= c) { wu -= c; pv++; } else break; }
                if (hasFreeQueued && pv < 7) pv++;
                if (pv >= 7) { cost = "MAX"; costClass = "cost-max"; }
                else {
                    const bc = parseInt((MODEL_COSTS[pv+1]||"1w").replace('w',''));
                    const effective = Math.max(0, bc - modelRed);
                    cost = effective + "W";
                    if (modelRed > 0 && bc > effective) costSub = `was ${bc}W`;
                    else if (modelRed > 0) costSub = `-${modelRed} active`;
                }
            }
            else if (slug === 'increase_net_worth') {
                if (me.net_worth === 0) { cost = "$3"; costSub = "-2 Rep"; }
                else if (me.net_worth === 1) { cost = "$5"; costSub = "-4 Rep"; }
                else { cost = "MAX"; costClass = "cost-max"; }
            }
            else if (slug === 'scale_presence') {
                cost = me.next_presence_cost != null
                    ? `$${me.next_presence_cost}`
                    : `$${PRESENCE_COSTS_LIST[me.presence_count-1]||14}`;
            }
            else if (slug === 'marketing') {
                cost = "1W";
            }
            else if (slug === 'play_card') {
                cost = "0–2W";
                costSub = "per card";
            }
            else if (slug === 'raise_funds') {
                cost = "1–3W";
                costSub = "per tier";
            }
        }

        const idSuffix = action.toLowerCase().replace(/ /g,'-');
        const placements = (Game.currentGameState?.placements || []).filter(
            p => p.player_id === Game.PLAYER_ID && p.action_type === slug
        );
        const workerChips = placements.map(p => {
            const isFree = !Number.isInteger(p.worker_number);
            const label = isFree ? '\u2605' : String(p.worker_number);
            return `<span class="worker-chip${isFree ? ' free' : ''}">${label}</span>`;
        }).join('');

        const tileClasses = [
            'strategy-tile',
            !avail ? 'unavailable' : '',
            SPECIAL_RED_ACTIONS.has(slug) ? 'special-red' : '',
        ].filter(Boolean).join(' ');
        const onClick = avail ? `onclick="placeWorker('${action}')"` : '';
        const iconSrc = ACTION_ICON_MAP[slug] || '';

        return `<div class="${tileClasses}" data-slug="${slug}" data-action="${action}" ${onClick} title="${ACTION_DESCRIPTIONS[slug] || ''}">
            <div class="tile-head">
                ${iconSrc ? `<img class="tile-icon" src="${iconSrc}" alt="" onerror="this.style.display='none'">` : ''}
                <span class="tile-name">${action}</span>
            </div>
            <div class="tile-cost ${costClass}">${cost}${costSub ? ` <span class="tile-cost-secondary">(${costSub})</span>` : ''}</div>
            <div class="tile-workers" id="count-${idSuffix}">${workerChips}</div>
        </div>`;
    }).join('');
}

// ── WORLD MAP ─────────────────────────────────────────────
// Inline worker-token.svg (matches assets/svg/worker-token.svg). Inlined so
// `currentColor` picks up the per-player color set on the parent element.
const WORKER_TOKEN_SVG = `<svg viewBox="0 0 48 48" width="100%" height="100%" aria-hidden="true">
    <circle cx="24" cy="24" r="22" fill="#faf7f2" stroke="#d4c9b8" stroke-width="1.5"/>
    <circle cx="24" cy="18" r="6.5" fill="currentColor" stroke="#1e1b18" stroke-width="1" stroke-opacity="0.35"/>
    <path d="M10 41 C 10 32, 17 27, 24 27 C 31 27, 38 32, 38 41 Z" fill="currentColor" stroke="#1e1b18" stroke-width="1" stroke-opacity="0.35"/>
    <path d="M20 25 Q 24 28 28 25 L 28 28 L 20 28 Z" fill="#1e1b18" fill-opacity="0.18"/>
</svg>`;

function renderWorldMap(clickHandler = null) {
    const overlay = document.getElementById('presence-overlay');
    if (!overlay || !Game.currentGameState) return;
    overlay.innerHTML = '';

    REGION_LAYOUT.forEach(layout => {
        const region = Game.currentGameState.regions?.find(r => r.id === layout.id);
        const subsidies = region ? region.subsidy_tokens : 0;
        const presencePlayers = region ? (region.presence_players||[]) : [];
        // Region marker: centred on (layout.x%, layout.y%). Labels live in
        // the SVG itself (images/world-map.svg) so the user can position them
        // by editing the SVG directly. This DOM marker only carries the
        // worker tokens + subsidy coin, anchored at the same point.
        const mc = document.createElement('div');
        mc.className = 'region-marker';
        mc.style.left = `${layout.x}%`;
        mc.style.top = `${layout.y}%`;
        mc.style.pointerEvents = clickHandler ? 'auto' : 'none';
        if (clickHandler) { mc.style.cursor = 'pointer'; mc.onclick = () => clickHandler(layout.id); }

        const row = document.createElement('div');
        row.className = 'region-row';

        presencePlayers.forEach(playerName => {
            const pObj = Game.currentGameState.players.find(p => p.name === playerName);
            if (!pObj) return;
            const b = document.createElement('div');
            b.className = 'presence-token';
            b.style.color = PLAYER_COLORS[pObj.id] || "#888";
            b.innerHTML = WORKER_TOKEN_SVG;
            b.title = pObj.name;
            row.appendChild(b);
        });

        if (subsidies > 0) {
            const sub = document.createElement('div');
            sub.className = 'subsidy-marker';
            const countBadge = subsidies > 1
                ? `<span class="subsidy-count">${subsidies}</span>`
                : '';
            sub.innerHTML = `<img src="assets/svg/subsidy-token.svg" alt="Subsidy token">${countBadge}`;
            sub.title = `${subsidies} subsidy token${subsidies > 1 ? 's' : ''}`;
            row.appendChild(sub);
        }

        mc.appendChild(row);
        overlay.appendChild(mc);
    });
}

// ── LOG ───────────────────────────────────────────────────
function addLog(msg) {
    console.log(`[Disruptopia] ${msg}`);
}

// ── ERROR MODAL ───────────────────────────────────────────
function showErrorModal(title, message) {
    const modal = document.getElementById('choice-modal');
    document.getElementById('modal-title').innerText = title;
    document.getElementById('modal-desc').innerText = message;
    const opts = document.getElementById('modal-options');
    opts.innerHTML = "";
    const btn = document.createElement('button');
    btn.innerText = "OK";
    btn.className = "modal-confirm-btn";
    btn.onclick = () => modal.style.display='none';
    opts.appendChild(btn);
    modal.style.display = "flex";
}

function showGameOverModal(leaderboard) {
    const modal = document.getElementById('choice-modal');
    document.getElementById('modal-title').innerText = "Game Over!";
    document.getElementById('modal-desc').innerHTML = leaderboard.map((e,i) => {
        const medal = i===0 ? "WINNER" : `#${i+1}`;
        return `<span style="font-weight:${i===0?'bold':'normal'}; color:${i===0?'#fbbf24':'#1e1b18'};">${medal} ${e.user_name}: ${e.total_vp} VP</span>`;
    }).join('<br>');
    const opts = document.getElementById('modal-options');
    opts.innerHTML = "";
    const btn = document.createElement('button');
    btn.innerText = "New Game"; btn.style.cssText = "padding:10px 20px; background:linear-gradient(135deg,#818cf8,#a78bfa); color:#fff; border:none; font-weight:bold; cursor:pointer; margin-right:10px; border-radius:8px; font-family:'Space Grotesk',system-ui,sans-serif;";
    btn.onclick = () => { modal.style.display='none'; resetGame(); };
    opts.appendChild(btn);
    const cls = document.createElement('button');
    cls.innerText = "Close"; cls.style.cssText = "padding:10px 20px; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; cursor:pointer; border-radius:8px;";
    cls.onclick = () => modal.style.display='none';
    opts.appendChild(cls);
    modal.style.display = "flex";
}
