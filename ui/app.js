// Disruptopia P2P - Main Application
// Adapted from frontend/api.js + frontend/setup.js
// All game logic runs locally via Engine.*

// ── SHARED GAME STATE ─────────────────────────────────────
window.Game = {
    GAME_ID: 1,
    PLAYER_ID: parseInt(localStorage.getItem('active_player_id')) || null,
    currentGameState: null,
    localState: null,  // Raw engine state (camelCase)
    cardsPlayedThisTurn: [],
    _processingInteractions: false,
    isDiscarding: false,
    discardSelectedCard: null,
    setupDragging: null,
    setupClickSelected: null,
    // Multiplayer state. mode is 'local' | 'host' | 'join'. In 'host'/'join'
    // mode, every state-changing action is broadcast through the relay and
    // Game.PLAYER_ID is locked to the slot the player took.
    mp: {
        mode: 'local',
        gameCode: null,
        relayUrl: null,
        connected: false,
        applyingRemote: false,  // set during remote-action application to skip re-broadcast
    },
};

// Constants aliases for rendering compatibility
const ACTIONS = Config.ACTIONS;
const ACTION_DESCRIPTIONS = Config.ACTION_DESCRIPTIONS;
const REGIONS = Config.REGIONS;
const REGION_LAYOUT = Config.REGION_LAYOUT;
const WORLD_MAP = Config.WORLD_MAP;
const PLAYER_COLORS = Config.PLAYER_COLORS;
const PRESENCE_COSTS_LIST = Config.PRESENCE_COSTS;
const COMPUTE_COSTS = {};
for (const [level, cost] of Object.entries(Config.COMPUTE_UPGRADE_COSTS)) COMPUTE_COSTS[level] = `$${cost}`;
const MODEL_COSTS = {};
for (const [v, w] of Object.entries(Config.MODEL_WORKER_COSTS)) MODEL_COSTS[v] = `${w}w`;
const WORKER_COSTS = {};
for (const [c, info] of Object.entries(Config.RECRUIT_COSTS)) WORKER_COSTS[c] = `$${info.money}`;

// ── INIT ──────────────────────────────────────────────────
async function init() {
    // Try to load saved game from IndexedDB
    try {
        const saved = await Persistence.loadState(1);
        if (saved && saved.game && saved.players && saved.players.length > 0) {
            Game.localState = saved;
            showGameScreen();
            refreshData();
            return;
        }
    } catch(e) { console.log("No saved game found."); }
    showSetupScreen();
}

function showSetupScreen() {
    document.getElementById('setup-screen').style.display = 'block';
    document.getElementById('game-screen').style.display = 'none';
    document.getElementById('btn-reset-game').style.display = 'none';
    updateSetupForm();
}

function showGameScreen() {
    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('game-screen').style.display = 'grid';
    document.getElementById('btn-reset-game').style.display = 'block';
}

function toggleRules() {
    const p = document.getElementById('rules-panel');
    p.style.display = p.style.display === 'flex' ? 'none' : 'flex';
}

// ── STATE VIEW BUILDER ───────────────────────────────────
// Transforms engine state (camelCase) into the format the UI expects (snake_case)
function buildStateView(state) {
    if (!state) return null;
    const players = state.players.map(p => {
        const projected = Engine.getProjectedPlayerState(state, p.id, 99);
        const mods = Engine.getPlayerModifiers(state, p.id);
        return {
            id: p.id,
            name: p.userName,
            power: p.power,
            income: p.income,
            net_worth: p.netWorthLevel,
            reputation: p.reputation,
            compute_level: p.computeLevel,
            model_version: p.modelVersion,
            total_worker_count: p.totalWorkers,
            placed_worker_numbers: state.workerPlacements.filter(w => w.playerId === p.id).map(w => w.workerNumber),
            subsidy_tokens: p.subsidyTokens,
            corporate_funds: p.corporateFunds,
            personal_funds: p.personalFunds,
            presence_count: p.presenceCount,
            presence_regions: [...p.presenceRegions],
            temp_card_cost_worker_reduction: p.tempCardCostWorkerReduction,
            temp_model_cost_worker_reduction: p.tempModelCostWorkerReduction,
            temp_recruit_cost_increase: p.tempRecruitCostIncrease,
            temp_card_cost_worker_increase: p.tempCardCostWorkerIncrease,
            temp_action_cost_increase: p.tempActionCostIncrease,
            temp_worker_lock_count: p.tempWorkerLockCount,
            temp_hand_limit_ignore: p.tempHandLimitIgnore,
            ransomware_locked: p.ransomwareLocked,
            hand_limit: mods.hand_limit,
            // Reputation-tile derived modifiers used by the play-card UI:
            card_cost_worker_reduction: mods.card_cost_worker_reduction || 0,
            free_hand_card_available: !!(mods.free_hand_card && !p.tempFreeHandCardUsed),
            free_active_effect_available: !!(mods.free_active_effect && !p.tempFreeActiveEffectUsed),
            // Projected
            projected_funds: projected.corporate_funds,
            projected_reputation: projected.reputation,
            projected_compute: projected.compute_level,
            projected_model: projected.model_version,
            projected_workers: projected.total_workers,
            projected_presence: projected.presence_count,
            projected_net_worth: projected.net_worth_level,
            projected_subsidies: projected.subsidy_tokens,
            // Hand
            hand: state.components
                .filter(c => c.zone === `hand_p${p.id}` && c.ownerId === p.id)
                .map(c => {
                    const def = state.cardDefinitions.find(d => d.id === c.cardDetailsId);
                    return def ? {
                        id: c.id, name: def.name, is_effect: def.isEffect, cost: def.cost,
                        description: def.description, requirements: def.requirements,
                        image_file: def.image, effect_slug: def.effectSlug,
                    } : null;
                }).filter(Boolean),
            // Active effects
            active_effects: [1,2,3].flatMap(slot =>
                state.components
                    .filter(c => c.zone === `active_effect_card_slot_${slot}_p${p.id}`)
                    .map(c => {
                        const def = state.cardDefinitions.find(d => d.id === c.cardDetailsId);
                        return def ? {slot, id: c.id, name: def.name, description: def.description, image_file: def.image, effect_slug: def.effectSlug} : null;
                    }).filter(Boolean)
            ),
            // Debuffs
            debuffs: state.components
                .filter(c => c.zone === `debuff_p${p.id}`)
                .map(c => {
                    const def = state.cardDefinitions.find(d => d.id === c.cardDetailsId);
                    return def ? {id: c.id, name: def.name, effect_slug: def.effectSlug, image_file: def.image} : null;
                }).filter(Boolean),
        };
    });

    // Region data
    const regionData = [];
    for (let rId = 1; rId <= 10; rId++) {
        const rs = state.regionStates.find(r => r.regionId === rId);
        const presence = state.players
            .filter(p => p.presenceRegions.includes(rId))
            .map(p => p.userName);
        regionData.push({id: rId, subsidy_tokens: rs ? rs.subsidyTokensRemaining : 0, presence_players: presence});
    }

    return {
        game_id: state.game.id,
        current_round: state.game.currentRound,
        max_rounds: state.game.maxRounds,
        game_phase: state.game.gamePhase,
        p1_index: state.game.p1TokenIndex,
        players,
        placements: state.workerPlacements.map(p => ({
            player_id: p.playerId, action_type: p.actionType, worker_number: p.workerNumber,
            target_region: p.targetRegion, target_card_id: p.targetCardId, target_sub_action: p.targetSubAction,
        })),
        regions: regionData,
        pending_interactions: state.game.pendingInteractions || [],
    };
}

// ── REFRESH ───────────────────────────────────────────────
function refreshData() {
    if (!Game.localState) return;
    Game.currentGameState = buildStateView(Game.localState);

    if (Game.PLAYER_ID) {
        const projected = Engine.getProjectedPlayerState(Game.localState, Game.PLAYER_ID, 99);
        const mods = Engine.getPlayerModifiers(Game.localState, Game.PLAYER_ID);
        const placements = Game.localState.workerPlacements.filter(p => p.playerId === Game.PLAYER_ID).length;
        const workersRemaining = (projected.total_workers || 3) - placements;
        Game.currentGameState.availability = Availability.getReport(projected, workersRemaining, mods);
    }

    const roundEl = document.getElementById('round-display');
    if (roundEl && Game.currentGameState.current_round) {
        roundEl.innerText = `Round ${Game.currentGameState.current_round} of ${Game.currentGameState.max_rounds}`;
    }
    if (Game.currentGameState.game_phase === 'finished' && roundEl) {
        roundEl.innerText = 'GAME OVER';
        roundEl.style.color = '#ff0000';
    }

    updatePlayerSelector(Game.currentGameState.players);
    const me = Game.currentGameState.players.find(p => p.id === Game.PLAYER_ID);
    renderStrategyBoard();
    if (me) {
        updateUI(me);
        updateStatsTable(Game.currentGameState.players);
        renderWorldMap();
    } else {
        document.getElementById('user-name').innerText = "Select Player ->";
    }

    // Auto-process pending interactions
    if (Game.currentGameState.pending_interactions && Game.currentGameState.pending_interactions.length > 0 && !Game._processingInteractions) {
        Game._processingInteractions = true;
        processPendingInteractions().finally(() => { Game._processingInteractions = false; });
    }

    // Auto-save to IndexedDB
    Persistence.saveState(Game.localState).catch(e => console.warn("Save failed:", e));
}

async function switchPlayer(newId) {
    if (!newId) return;
    Game.PLAYER_ID = parseInt(newId);
    localStorage.setItem('active_player_id', Game.PLAYER_ID);
    const sel = document.getElementById('player-select');
    if (sel) sel.value = Game.PLAYER_ID;
    refreshData();
}

async function finishRound() {
    const result = Engine.finishRound(Game.localState);
    if (result.status === "game_over") {
        addLog("=== GAME OVER ===");
        showGameOverModal(result.leaderboard);
    } else {
        addLog(`Round ${result.current_round - 1} complete. Round ${result.current_round}/${result.max_rounds} begins.`);
    }
    refreshData();
}

async function resetGame() {
    if (!confirm("RESET entire game? This cannot be undone.")) return;
    await Persistence.deleteState(1);
    localStorage.removeItem('active_player_id');
    Game.PLAYER_ID = null;
    Game.localState = null;
    Game.currentGameState = null;
    const sel = document.getElementById('player-select');
    if (sel) sel.innerHTML = '';
    showSetupScreen();
}

// ── SETUP ─────────────────────────────────────────────────
function updateSetupForm() {
    const count = parseInt(document.getElementById('setup-player-count').value);
    const container = document.getElementById('setup-players-container');
    const defaults = ["Player One","Player Two","Player Three","Player Four","Player Five"];
    const defRegions = {2:[1,6],3:[1,4,8],4:[1,3,6,9],5:[1,3,5,7,9]};
    const regions = defRegions[count] || defRegions[2];
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const color = Config.PLAYER_COLORS[i+1] || '#888';
        container.innerHTML += `
        <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">
            <div style="width:20px; height:20px; border-radius:50%; background:${color}; border:2px solid #fff; flex-shrink:0;"></div>
            <div style="flex:1;">
                <input type="text" id="setup-name-${i}" value="${defaults[i]}" style="width:100%; padding:6px 10px; border:1px solid #d4c9b8; border-radius:6px; font-family:'Inter',system-ui,sans-serif; font-size:0.85rem;">
            </div>
            <div>
                <select id="setup-region-${i}" style="padding:6px 10px; border:1px solid #d4c9b8; border-radius:6px; font-size:0.85rem; font-family:'Inter',system-ui,sans-serif;">
                    ${Config.REGIONS.map((r, idx) => `<option value="${idx+1}" ${regions[i]===(idx+1)?'selected':''}>${r} (${idx+1})</option>`).join('')}
                </select>
            </div>
        </div>`;
    }
}

function setSetupMode(mode) {
    Game.mp.mode = mode;
    const tabs = {local: 'setup-tab-local', host: 'setup-tab-host', join: 'setup-tab-join'};
    for (const [m, id] of Object.entries(tabs)) {
        const el = document.getElementById(id);
        if (m === mode) {
            el.style.background = '#4f46e5'; el.style.color = '#fff'; el.style.borderColor = '#4f46e5';
            el.style.fontWeight = '600';
        } else {
            el.style.background = '#fff'; el.style.color = '#1e1b18'; el.style.borderColor = '#d4c9b8';
            el.style.fontWeight = '400';
        }
    }
    const localHost = document.getElementById('setup-local-host');
    const joinPanel = document.getElementById('setup-join');
    const hostRelay = document.getElementById('setup-host-relay');
    const launchBtn = document.getElementById('setup-launch-btn');
    const hostCode = document.getElementById('setup-host-code');
    if (mode === 'join') {
        localHost.style.display = 'none';
        joinPanel.style.display = 'block';
    } else {
        localHost.style.display = 'block';
        joinPanel.style.display = 'none';
        hostRelay.style.display = (mode === 'host') ? 'block' : 'none';
        launchBtn.innerText = (mode === 'host') ? 'Host Game' : 'Launch Game';
        hostCode.style.display = 'none';
    }
}

async function launchGame() {
    const count = parseInt(document.getElementById('setup-player-count').value);
    const names = [], regionIds = [];
    for (let i = 0; i < count; i++) {
        names.push(document.getElementById(`setup-name-${i}`).value.trim() || `Player ${i+1}`);
        regionIds.push(parseInt(document.getElementById(`setup-region-${i}`).value));
    }
    if (new Set(regionIds).size !== regionIds.length) {
        alert("Each player needs a unique starting region."); return;
    }

    Game.localState = Seed.createGame(names, regionIds);
    Game.PLAYER_ID = Game.localState.players[0].id;
    localStorage.setItem('active_player_id', Game.PLAYER_ID);

    if (Game.mp.mode === 'host') {
        const relayUrl = document.getElementById('setup-relay-url-host').value.trim() || '/api';
        const code = Relay.generateGameCode();
        Relay.configure(relayUrl, code, Game.PLAYER_ID);
        const status = document.getElementById('setup-host-status');
        status.innerText = 'Creating room…';
        document.getElementById('setup-host-code-value').innerText = code;
        document.getElementById('setup-host-code').style.display = 'block';
        const res = await Relay.createRoom(Game.localState);
        if (res.error) {
            status.innerText = `Failed: ${res.error}`;
            return;
        }
        Game.mp.gameCode = code;
        Game.mp.relayUrl = relayUrl;
        Game.mp.connected = true;
        wireRelayCallbacks();
        Relay.startPolling(2500);
        status.innerText = 'Hosted. Waiting for joiners — share the code above.';
    }

    showGameScreen();
    refreshData();
    renderMpBanner();
    addLog(`Game created with ${names.length} players.`);
    if (Game.mp.mode === 'host') addLog(`Hosting at code ${Game.mp.gameCode}.`);
}

async function joinOnlineGame() {
    const relayUrl = document.getElementById('setup-relay-url-join').value.trim() || '/api';
    const code = document.getElementById('setup-join-code').value.trim().toUpperCase();
    const slot = parseInt(document.getElementById('setup-join-slot').value);
    const status = document.getElementById('setup-join-status');
    if (!code) { status.innerText = 'Game code required.'; return; }

    // Player IDs are 1-indexed in the order Seed.createGame creates them.
    const joinerPlayerId = slot;
    Relay.configure(relayUrl, code, joinerPlayerId);
    status.innerText = 'Connecting…';

    const res = await Relay.joinRoom();
    if (res.error) { status.innerText = `Failed: ${res.error}`; return; }
    if (!res.state || !res.state.players) {
        status.innerText = 'Host has not initialized state yet.'; return;
    }
    if (!res.state.players.find(p => p.id === joinerPlayerId)) {
        status.innerText = `Slot ${slot} does not exist in this game.`; return;
    }

    Game.mp.mode = 'join';
    Game.mp.gameCode = code;
    Game.mp.relayUrl = relayUrl;
    Game.mp.connected = true;
    Game.localState = res.state;
    Game.PLAYER_ID = joinerPlayerId;
    localStorage.setItem('active_player_id', Game.PLAYER_ID);
    wireRelayCallbacks();
    // Apply any actions that were queued before we joined.
    if (res.actionCount && res.actionCount > 0) {
        const catchup = await fetch(`${relayUrl}/room/${code}/actions?since=0`).then(r => r.json()).catch(() => ({actions: []}));
        for (const wrapped of (catchup.actions || [])) {
            if (wrapped.playerId !== joinerPlayerId) applyRemoteAction(wrapped.action);
        }
    }
    Relay.startPolling(2500);
    status.innerText = 'Joined.';
    showGameScreen();
    refreshData();
    renderMpBanner();
    addLog(`Joined ${code} as Player ${slot}.`);
}

// ── MULTIPLAYER WIRING ───────────────────────────────────
function wireRelayCallbacks() {
    Relay.onActionReceived = (wrapped) => {
        try { applyRemoteAction(wrapped.action); }
        catch (e) { console.error('applyRemoteAction failed', e); }
    };
}

// Called by placeWorker / undoLastPlacement / executeStrategy / discardCard
// after the local engine mutation succeeds. Suppressed when we're applying
// a remote action (so we don't loop the action back to the relay).
function broadcastAction(action) {
    if (Game.mp.mode === 'local' || !Game.mp.connected) return;
    if (Game.mp.applyingRemote) return;
    Relay.sendAction(action);
}

function applyRemoteAction(action) {
    if (!action || !action.kind) return;
    Game.mp.applyingRemote = true;
    try {
        if (action.kind === 'place_worker') {
            const a = action.args;
            Engine.placeWorker(Game.localState, a.playerId, a.workerNumber, a.slug, a.targetRegion, a.targetCardId, a.targetSubAction);
        } else if (action.kind === 'undo_placement') {
            Engine.undoLastPlacement(Game.localState, action.args.playerId);
        } else if (action.kind === 'execute_strategy') {
            // Re-run the same round resolution + finishRound the host ran.
            // Discard prompts after finishRound only fire for the LOCAL player.
            startStrategyExecution();
        } else if (action.kind === 'discard') {
            Engine.discardCard(Game.localState, action.args.playerId, action.args.cardId);
        } else if (action.kind === 'replay_active_effect') {
            Engine.replayActiveEffect(Game.localState, action.args.playerId, action.args.cardId, null);
        } else if (action.kind === 'play_card_free') {
            // 0-cost cards (or Venture-Mogul-free cards) are played
            // immediately on the active player's device. Re-apply on peers.
            Engine.playCard(
                Game.localState,
                action.args.playerId,
                action.args.cardId,
                action.args.freeSlot,
                action.args.payload,
            );
        } else if (action.kind === 'resolve_interaction') {
            // Another player resolved a pending interaction; find the
            // matching entry in our local state and apply the same payload.
            const interactions = Game.localState.game.pendingInteractions || [];
            const idx = interactions.findIndex(
                i => i.responding_player_id === action.args.responder
                  && i.type === action.args.type
            );
            if (idx >= 0) resolveInteraction(idx, action.args.payload);
        }
        refreshData();
    } finally {
        Game.mp.applyingRemote = false;
    }
}

function renderMpBanner() {
    const banner = document.getElementById('mp-banner');
    if (!banner) return;
    if (Game.mp.mode === 'local' || !Game.mp.connected) {
        banner.style.display = 'none';
        return;
    }
    banner.style.display = 'flex';
    banner.innerHTML = `
        <span style="font-weight:600; color:#4f46e5;">${Game.mp.mode === 'host' ? 'Hosting' : 'Joined'}</span>
        <span style="color:#78716c;">code</span>
        <span style="font-family:'Fredoka',cursive; letter-spacing:0.15rem; color:#4f46e5; font-weight:600;">${Game.mp.gameCode}</span>
        <span style="color:#78716c;">as P${Game.PLAYER_ID}</span>
    `;
    // In MP, lock the player selector to the local player.
    const sel = document.getElementById('player-select');
    if (sel) sel.disabled = true;
}

// ── DISCARD (local) ──────────────────────────────────────
async function localDiscardCard(playerId, cardId) {
    const result = Engine.discardCard(Game.localState, playerId, cardId);
    if (result.error) { showErrorModal("Discard Failed", result.error); return false; }
    refreshData();
    return true;
}

// ── PENDING INTERACTIONS ─────────────────────────────────
async function processPendingInteractions() {
    while (Game.currentGameState.pending_interactions && Game.currentGameState.pending_interactions.length > 0) {
        const interactions = Game.currentGameState.pending_interactions;
        // In MP, only prompt for interactions whose responding_player_id is
        // ours. Other clients will see the same interactions in their state
        // and wait for our broadcasted resolution.
        let idx = 0;
        if (Game.mp.mode !== 'local' && Game.mp.connected) {
            idx = interactions.findIndex(i => i.responding_player_id === Game.PLAYER_ID);
            if (idx === -1) break;
        }
        const interaction = interactions[idx];
        const result = await promptInteraction(interaction);
        if (result) {
            resolveInteraction(idx, result);
            // MP: broadcast the resolution so peers apply the same change.
            broadcastAction({
                kind: 'resolve_interaction',
                args: {
                    responder: interaction.responding_player_id,
                    type: interaction.type,
                    payload: result,
                },
            });
            refreshData();
        } else {
            break;
        }
    }
}

function resolveInteraction(index, payload) {
    const interactions = Game.localState.game.pendingInteractions;
    if (index < 0 || index >= interactions.length) return;
    const interaction = interactions[index];
    const itype = interaction.type;

    if (itype === "forced_discard") {
        const card = Game.localState.components.find(c => c.id === payload.card_id);
        if (card) { card.zone = `${card.subType}_discard`; card.ownerId = null; }
    } else if (itype === "steal_card") {
        const card = Game.localState.components.find(c => c.id === payload.card_id);
        if (card) { card.zone = `hand_p${interaction.responding_player_id}`; card.ownerId = interaction.responding_player_id; }
    } else if (itype === "choose_squeeze_region") {
        const target = Engine.getPlayer(Game.localState, interaction.target_player_id);
        if (target) {
            const idx = target.presenceRegions.indexOf(parseInt(payload.region_id));
            if (idx >= 0) { target.presenceRegions.splice(idx, 1); target.presenceCount -= 1; }
            if (target.subsidyTokens > 0) target.subsidyTokens -= 1;
            Engine.updatePlayerIncome(Game.localState, target);
        }
    } else if (itype === "choose_regions") {
        CardEffects.celebrity_tour(Game.localState, interaction.responding_player_id, 0, {regions: payload.regions});
    } else if (itype === "choose_region_attack") {
        const fn = CardEffects[interaction.effect_slug];
        if (fn) fn(Game.localState, interaction.responding_player_id, 0, {region_id: payload.region_id});
    }

    interactions.splice(index, 1);
}

// ── INTERACTION PROMPTS ──────────────────────────────────
async function promptInteraction(interaction) {
    const modal = document.getElementById('choice-modal');
    const titleEl = document.getElementById('modal-title');
    const descEl = document.getElementById('modal-desc');
    const optsEl = document.getElementById('modal-options');

    return new Promise(resolve => {
        if (interaction.type === "choose_squeeze_region") {
            titleEl.innerText = `${interaction.card_name || "Squeeze"}`;
            descEl.innerText = `Choose a shared region to remove ${interaction.target_player_name} from:`;
            optsEl.innerHTML = "";
            for (const rId of interaction.shared_regions) {
                const btn = document.createElement('button');
                btn.innerText = `Region ${rId} (${Config.REGIONS[rId-1]})`;
                btn.style.cssText = "padding:8px 16px; margin:4px; cursor:pointer; background:#4f46e5; color:#fff; border:none; border-radius:8px;";
                btn.onclick = () => { modal.style.display = 'none'; resolve({region_id: rId}); };
                optsEl.appendChild(btn);
            }
            modal.style.display = "flex";
        } else if (interaction.type === "choose_regions") {
            titleEl.innerText = interaction.card_name || "Choose Regions";
            descEl.innerText = "Select up to 2 regions to expand into:";
            optsEl.innerHTML = "";
            const selected = [];
            for (const rId of interaction.available_regions) {
                const btn = document.createElement('button');
                btn.innerText = `Region ${rId} (${Config.REGIONS[rId-1]})`;
                btn.style.cssText = "padding:8px 16px; margin:4px; cursor:pointer; background:#4f46e5; color:#fff; border:none; border-radius:8px;";
                btn.onclick = () => {
                    selected.push(rId);
                    btn.disabled = true; btn.style.background = '#9ca3af';
                    if (selected.length >= (interaction.max_regions || 2)) {
                        modal.style.display = 'none'; resolve({regions: selected});
                    }
                };
                optsEl.appendChild(btn);
            }
            const doneBtn = document.createElement('button');
            doneBtn.innerText = "Done";
            doneBtn.style.cssText = "padding:8px 16px; margin:4px; cursor:pointer; background:#059669; color:#fff; border:none; border-radius:8px;";
            doneBtn.onclick = () => { modal.style.display = 'none'; resolve(selected.length > 0 ? {regions: selected} : null); };
            optsEl.appendChild(doneBtn);
            modal.style.display = "flex";
        } else if (interaction.type === "choose_region_attack") {
            titleEl.innerText = interaction.card_name || "Choose Region";
            descEl.innerText = interaction.effect_description || "Select a region:";
            optsEl.innerHTML = "";
            for (const rId of interaction.available_regions) {
                const btn = document.createElement('button');
                btn.innerText = `Region ${rId} (${Config.REGIONS[rId-1]})`;
                btn.style.cssText = "padding:8px 16px; margin:4px; cursor:pointer; background:#dc2626; color:#fff; border:none; border-radius:8px;";
                btn.onclick = () => { modal.style.display = 'none'; resolve({region_id: rId}); };
                optsEl.appendChild(btn);
            }
            modal.style.display = "flex";
        } else if (interaction.type === "steal_card") {
            titleEl.innerText = interaction.card_name || "Steal Card";
            descEl.innerText = `Choose a card to steal from ${interaction.target_player_name}:`;
            optsEl.innerHTML = "";
            for (const c of (interaction.target_hand || [])) {
                const btn = document.createElement('button');
                btn.innerText = c.name;
                btn.style.cssText = "padding:8px 16px; margin:4px; cursor:pointer; background:#d97706; color:#fff; border:none; border-radius:8px;";
                btn.onclick = () => { modal.style.display = 'none'; resolve({card_id: c.id}); };
                optsEl.appendChild(btn);
            }
            modal.style.display = "flex";
        } else {
            resolve(null);
        }
    });
}

window.addEventListener('DOMContentLoaded', init);
