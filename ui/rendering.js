// ── PLAYER SELECTOR ───────────────────────────────────────
function updatePlayerSelector(players) {
    const select = document.getElementById('player-select');
    if (!select) return;
    if (select.options.length !== players.length) {
        select.innerHTML = '';
        players.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id; opt.innerText = p.name;
            if (p.id === Game.PLAYER_ID) opt.selected = true;
            select.appendChild(opt);
        });
    }
    // Auto-select first player if none selected
    if (!Game.PLAYER_ID && players.length > 0) {
        Game.PLAYER_ID = players[0].id;
        localStorage.setItem('active_player_id', Game.PLAYER_ID);
        select.value = Game.PLAYER_ID;
    }
    // Sync dropdown to current player
    if (Game.PLAYER_ID) select.value = Game.PLAYER_ID;
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
        banner.style.cssText = "background:#fef2f2; color:#dc2626; padding:8px 12px; text-align:center; font-weight:bold; font-size:0.85rem; border:1px solid #fca5a5; margin:4px 0; border-radius:8px;";
        banner.innerHTML = "RANSOMWARE: Cannot play cards this round";
        const nameEl = document.getElementById('user-name');
        if (nameEl && nameEl.parentNode) nameEl.parentNode.insertBefore(banner, nameEl.nextSibling);
    }

    // Update assigned worker display - only current player's placements
    ACTIONS.forEach(action => {
        let slug = action.toLowerCase().replace(/ /g, "_");
        if (slug === 'train_new_model') slug = 'train_model';
        const placements = Game.currentGameState.placements.filter(p => p.action_type === slug && p.player_id === Game.PLAYER_ID);
        const workerIds = placements.map(p => Number.isInteger(p.worker_number) ? p.worker_number : "Free").sort().join(", ");
        const cell = document.getElementById(`count-${action.toLowerCase().replace(/ /g, '-')}`);
        if (cell) {
            if (workerIds) {
                const badges = workerIds.split(', ').map(w => {
                    if (w === 'Free') return `<span style="display:inline-block; background:#eef2ff; color:#4f46e5; font-size:0.55rem; font-weight:700; padding:1px 5px; border-radius:4px; border:1px solid #c7d2fe;">${w}</span>`;
                    return `<span style="display:inline-block; color:#4f46e5; font-size:0.65rem; font-weight:700;">${w}</span>`;
                }).join(' ');
                cell.innerHTML = badges;
            } else {
                cell.innerText = "\u2014";
            }
        }
    });

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
            const cl = isOwned ? "#4f46e5" : "#78716c";
            return `<div style="background:${bg}; color:${cl}; border:1px solid #e5ddd0; padding:4px 6px; text-align:center; min-width:32px; font-weight:bold; font-size:0.7rem; border-radius:4px;">${content}</div>`;
        }).join('');
    };

    const ss = "flex:1; border:1px solid #e5ddd0; margin:0 3px; padding:4px; min-width:100px; border-radius:8px; background:#fff;";
    const sh = "text-align:center; font-weight:bold; font-size:0.65rem; border-bottom:1px solid #e5ddd0; margin-bottom:6px; padding-bottom:3px; color:#78716c;";
    const sr = "display:flex; justify-content:flex-start; margin-bottom:3px; align-items:center;";
    const sl = "width:55px; font-size:0.6rem; color:#78716c; text-align:right; padding-right:6px; flex-shrink:0;";

    const renderSec = (title, slug) => {
        const isA = (slug==='startup' && player.net_worth===0) || (slug==='millionaire' && player.net_worth===1) || (slug==='billionaire' && player.net_worth===2);
        const headerStyle = isA
            ? "text-align:center; font-weight:bold; font-size:0.85rem; border-bottom:2px solid #4f46e5; margin-bottom:6px; padding-bottom:3px; color:#4f46e5;"
            : sh;
        return `<div style="${ss}${isA ? ' border-color:#4f46e5;' : ''}">
            <div style="${headerStyle}">${title}</div>
            <div style="${sr}"><div style="${sl}">COMPUTE</div>${genCells('compute',slug)}</div>
            <div style="${sr}"><div style="${sl}">MODEL</div>${genCells('model',slug)}</div>
            <div style="${sr}"><div style="${sl}">PRESENCE</div>${genCells('presence',slug)}</div>
            <div style="${sr}"><div style="${sl}">WORKERS</div>${genCells('workers',slug)}</div>
        </div>`;
    };

    container.innerHTML = `<div style="display:flex; width:100%;">${renderSec("STARTUP","startup")}${renderSec("MILLIONAIRE","millionaire")}${renderSec("BILLIONAIRE","billionaire")}</div>`;
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

    // Render active effects in the map-side panel as thumbnails with hover-to-enlarge
    const effectsContainer = document.getElementById('active-effects-container');
    if (effectsContainer) {
        const makeCard = (img, borderColor, labelColor, labelBg, labelText) =>
            `<div style="width:110px; flex-shrink:0; border:2px solid ${borderColor}; border-radius:6px; overflow:visible; box-shadow:0 1px 4px rgba(0,0,0,0.08); transition:transform 0.2s, z-index 0s; cursor:pointer; position:relative; background:#fff;" onmouseenter="this.style.transform='scale(2)'; this.style.zIndex='100';" onmouseleave="this.style.transform=''; this.style.zIndex='';">
                <img src="${img}" style="width:100%; height:auto; display:block; border-radius:4px 4px 0 0;" onerror="this.style.display='none'">
                <div style="padding:2px; font-size:0.45rem; color:${labelColor}; text-align:center; background:${labelBg}; font-weight:600;">${labelText}</div>
            </div>`;

        let cards = [];
        const effects = player.active_effects || [];
        effects.forEach(eff => {
            const img = eff.image_file ? `assets/${eff.image_file}` : '';
            cards.push(makeCard(img, '#d97706', '#d97706', '#fffbeb', 'ACTIVE'));
        });
        if (Game.cardsPlayedThisTurn.length > 0) {
            Game.cardsPlayedThisTurn.forEach(card => {
                const img = card.image_file ? `assets/${card.image_file}` : '';
                cards.push(makeCard(img, '#4f46e5', '#4f46e5', '#eef2ff', 'THIS TURN'));
            });
        }

        // Infinite Loop freebie: show a button when the tile is held and the
        // freebie hasn't been used this round, and there's at least one
        // active-effect card to replay.
        const infiniteAvailable = player.free_active_effect_available && effects.length > 0;
        const ilButton = infiniteAvailable
            ? `<button id="btn-replay-active-effect" onclick="replayActiveEffectFree()" style="margin-top:6px; padding:6px 10px; font-size:0.65rem; font-weight:600; background:#7c3aed; color:#fff; border:none; border-radius:6px; cursor:pointer;">Replay Active Effect (Infinite Loop, free)</button>`
            : '';
        if (cards.length > 0) {
            effectsContainer.innerHTML = `<div style="display:flex; flex-wrap:wrap; gap:6px; align-items:flex-start;">${cards.join('')}</div>${ilButton}`;
        } else {
            effectsContainer.innerHTML = `<div style="border: 2px dashed #d4c9b8; border-radius: 8px; padding: 16px 10px; text-align: center; color: #78716c; font-size: 0.6rem;">Effect cards appear here when played</div>${ilButton}`;
        }
    }

    // Cards in hand
    let html = '';
    const allHand = player.hand || [];
    if (allHand.length === 0) {
        container.innerHTML = '<div style="color:#78716c; font-style:italic; padding:10px;">Hand is empty.</div>';
        return;
    }

    html += allHand.map(card => {
        const isCommitted = committedIds.has(card.id);
        const cost = card.cost > 0 ? `${card.cost}W` : "Free";
        const type = card.is_effect ? "EFFECT" : "ACTION";
        const img = card.image_file ? `assets/${card.image_file}` : '';

        if (isCommitted) {
            return `<div style="border:2px solid #4f46e5; background:#f5f0e8; width:150px; flex-shrink:0; border-radius:8px; overflow:hidden; opacity:0.5; box-shadow:0 2px 8px rgba(0,0,0,0.08);">
                <img src="${img}" style="width:100%; display:block; filter:brightness(0.7);" onerror="this.src='${NO_IMG}'">
                <div style="padding:2px; font-size:0.55rem; color:#4f46e5; text-align:center; border-top:1px solid #e5ddd0; background:#eef2ff; font-weight:600;">QUEUED</div>
            </div>`;
        }

        return `<div style="border:2px solid #d4c9b8; background:#ffffff; width:150px; flex-shrink:0; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.08); transition: transform 0.15s; cursor: pointer;" onmouseenter="this.style.transform='translateY(-4px)'" onmouseleave="this.style.transform=''">
            <img src="${img}" style="width:100%; display:block;" onerror="this.src='${NO_IMG}'">
            <div style="padding:2px; font-size:0.55rem; color:#1e1b18; text-align:center; border-top:1px solid #e5ddd0; background:#faf7f2; font-weight:500;">${type} | ${cost}</div>
        </div>`;
    }).join('');

    container.innerHTML = html;
}

// ── STRATEGY BOARD ────────────────────────────────────────
function renderStrategyBoard() {
    const container = document.getElementById('strategy-rows');
    if (!container) return;
    const me = Game.currentGameState?.players.find(p => p.id === Game.PLAYER_ID);

    container.innerHTML = ACTIONS.map(action => {
        let slug = action.toLowerCase().replace(/ /g, '_');
        if (slug === 'train_new_model') slug = 'train_model';
        let avail = me ? isActionAvailable(slug) : false;
        // Disable Play Card if ransomware locked
        if (slug === 'play_card' && me && me.ransomware_locked >= 2) avail = false;
        const btnStyle = avail ? "" : "display:none;";

        let cost = "\u2014";
        if (me) {
            if (slug === 'buy_chips') cost = COMPUTE_COSTS[me.compute_level+1] || "MAX";
            else if (slug === 'recruit') {
                // Prefer the engine's slot-aware cost (rulebook p.14); fall back
                // to the old sequential lookup if not present (older saves).
                if (me.next_worker_cost != null) {
                    cost = `$${me.next_worker_cost}`;
                } else {
                    const nextW = me.total_worker_count + 1;
                    if (nextW > 8) cost = "MAX";
                    else cost = WORKER_COSTS[nextW] || WORKER_COSTS[4] || "$2";
                }
            }
            else if (slug === 'train_model') {
                const modelRed = getProjectedModelCostReduction(me);
                // Count only REAL worker placements (not free actions with fractional worker numbers)
                const tp = Game.currentGameState.placements.filter(p => p.player_id===Game.PLAYER_ID && p.action_type==='train_model' && Number.isInteger(p.worker_number));
                const hasFreeQueued = Game.currentGameState.placements.some(p => p.player_id===Game.PLAYER_ID && p.action_type==='train_model' && !Number.isInteger(p.worker_number));
                let wu = tp.length, pv = me.model_version;
                // Fast-forward past upgrades covered by real workers
                while (pv < 7 && wu > 0) { const bc = parseInt((MODEL_COSTS[pv+1]||"1w").replace('w','')); const c = Math.max(0, bc - modelRed); if (wu >= c) { wu -= c; pv++; } else break; }
                // Also skip past the free-queued upgrade
                if (hasFreeQueued && pv < 7) pv++;
                if (pv >= 7) { cost = "MAX"; }
                else {
                    const bc = parseInt((MODEL_COSTS[pv+1]||"1w").replace('w',''));
                    const effective = Math.max(0, bc - modelRed);
                    cost = effective + "W";
                    if (modelRed > 0 && bc > effective) cost += ` (was ${bc}W)`;
                    else if (modelRed > 0) cost += ` (-${modelRed} active)`;
                }
            } else if (slug === 'increase_net_worth') cost = me.net_worth===0 ? "$3 -2R" : me.net_worth===1 ? "$5 -4R" : "MAX";
            else if (slug === 'scale_presence') {
                cost = me.next_presence_cost != null
                    ? `$${me.next_presence_cost}`
                    : `$${PRESENCE_COSTS_LIST[me.presence_count-1]||14}`;
            }
            else if (['marketing','play_card','raise_funds'].includes(slug)) cost = "FREE";
        }

        const desc = ACTION_DESCRIPTIONS[slug] || "";
        const idSuffix = action.toLowerCase().replace(/ /g,'-');
        return `<tr>
            <td style="text-align:left;"><div style="font-weight:600; font-size:0.75rem; color:#1e1b18;">${action}</div><div style="font-size:0.55rem; color:#78716c;">${desc}</div></td>
            <td style="font-size:0.7rem; color:#1e1b18;">${cost}</td>
            <td id="count-${idSuffix}" style="font-size:0.7rem; color:#1e1b18;">\u2014</td>
            <td><button onclick="placeWorker('${action}')" class="btn-worker" style="${btnStyle}">+</button></td>
        </tr>`;
    }).join('');
}

// ── WORLD MAP ─────────────────────────────────────────────
function renderWorldMap(clickHandler = null) {
    const overlay = document.getElementById('presence-overlay');
    if (!overlay || !Game.currentGameState) return;
    overlay.innerHTML = '';

    REGION_LAYOUT.forEach(layout => {
        const region = Game.currentGameState.regions?.find(r => r.id === layout.id);
        const subsidies = region ? region.subsidy_tokens : 0;
        const presencePlayers = region ? (region.presence_players||[]) : [];

        const mc = document.createElement('div');
        mc.className = 'region-marker';
        mc.style.left = `${layout.x}%`;
        mc.style.top = `${layout.y}%`;
        mc.style.pointerEvents = clickHandler ? 'auto' : 'none';
        if (clickHandler) { mc.style.cursor = 'pointer'; mc.onclick = () => clickHandler(layout.id); }

        // Subsidy token badge in top-right corner of region
        if (subsidies > 0) {
            const tokenBadge = document.createElement('div');
            tokenBadge.className = 'subsidy-token';
            tokenBadge.innerText = subsidies;
            tokenBadge.style.position = 'absolute';
            tokenBadge.style.top = '-12px';
            tokenBadge.style.right = '-12px';
            tokenBadge.style.zIndex = '5';
            mc.appendChild(tokenBadge);
        }

        // Region label
        const lbl = document.createElement('div');
        lbl.style.cssText = "font-size:0.5rem; color:#78716c; pointer-events:none;";
        lbl.innerText = `R${layout.id}`;
        mc.appendChild(lbl);

        // Player bubbles
        presencePlayers.forEach(playerName => {
            const pObj = Game.currentGameState.players.find(p => p.name === playerName);
            if (!pObj) return;
            const b = document.createElement('div');
            b.className = 'presence-bubble';
            b.style.position = 'relative'; b.style.transform = 'none';
            b.style.display = 'inline-block'; b.style.margin = '1px';
            b.style.pointerEvents = 'none';
            b.innerText = pObj.name.split(' ').map(w => w[0]).join('');
            b.style.backgroundColor = PLAYER_COLORS[pObj.id] || "#888";
            b.style.color = [2,3].includes(pObj.id) ? "#000" : "#fff";
            b.title = pObj.name;
            mc.appendChild(b);
        });

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
    btn.innerText = "OK"; btn.style.cssText = "padding:8px 16px; cursor:pointer; background:#dc2626; color:#fff; border:none; border-radius:8px; font-weight:600; font-family:'Inter',system-ui,sans-serif;";
    btn.onclick = () => modal.style.display='none';
    opts.appendChild(btn);
    modal.style.display = "flex";
}

function showGameOverModal(leaderboard) {
    const modal = document.getElementById('choice-modal');
    document.getElementById('modal-title').innerText = "Game Over!";
    document.getElementById('modal-desc').innerHTML = leaderboard.map((e,i) => {
        const medal = i===0 ? "WINNER" : `#${i+1}`;
        return `<span style="font-weight:${i===0?'bold':'normal'}; color:${i===0?'#d97706':'#1e1b18'};">${medal} ${e.user_name}: ${e.total_vp} VP</span>`;
    }).join('<br>');
    const opts = document.getElementById('modal-options');
    opts.innerHTML = "";
    const btn = document.createElement('button');
    btn.innerText = "New Game"; btn.style.cssText = "padding:10px 20px; background:linear-gradient(135deg,#4f46e5,#7c3aed); color:#fff; border:none; font-weight:bold; cursor:pointer; margin-right:10px; border-radius:8px; font-family:'Fredoka',cursive;";
    btn.onclick = () => { modal.style.display='none'; resetGame(); };
    opts.appendChild(btn);
    const cls = document.createElement('button');
    cls.innerText = "Close"; cls.style.cssText = "padding:10px 20px; background:#f5f0e8; color:#78716c; border:1px solid #d4c9b8; cursor:pointer; border-radius:8px;";
    cls.onclick = () => modal.style.display='none';
    opts.appendChild(cls);
    modal.style.display = "flex";
}
