// Disruptopia P2P - Game Logic (UI)
// Adapted from frontend/game-logic.js
// All API calls replaced with local Engine.* calls

// ── PLACE WORKER ──────────────────────────────────────────
async function placeWorker(actionName) {
    if (!Game.currentGameState || !Game.PLAYER_ID) { addLog("Error: Select a player first."); return; }
    const me = Game.currentGameState.players.find(p => p.id === Game.PLAYER_ID);
    if (!me) return;

    let slug = actionName.toLowerCase().replace(/ /g, "_");
    if (slug === 'train_new_model') slug = 'train_model';

    let workersToPlaceCount = 1;
    if (slug === 'train_model') {
        const modelReduction = getProjectedModelCostReduction(me);
        const tp = Game.currentGameState.placements.filter(p => p.player_id === Game.PLAYER_ID && p.action_type === 'train_model');
        let wu = tp.length, pv = me.model_version;
        while (pv < 7 && wu > 0) {
            const baseCost = parseInt((MODEL_COSTS[pv + 1] || "1w").replace('w', ''));
            const c = Math.max(0, baseCost - modelReduction);
            if (wu >= c) { wu -= c; pv++; } else break;
        }
        const nextBase = parseInt((MODEL_COSTS[pv + 1] || "1w").replace('w', ''));
        workersToPlaceCount = Math.max(0, nextBase - modelReduction);

        if (workersToPlaceCount === 0) {
            const myPlacements = Game.currentGameState.placements
                .filter(p => p.player_id === Game.PLAYER_ID)
                .map(p => p.worker_number);
            const lastWorker = myPlacements.length > 0 ? Math.max(...myPlacements) : 0;
            const freeSlot = lastWorker + 0.01;
            const result = Engine.placeWorker(Game.localState, Game.PLAYER_ID, freeSlot, 'train_model');
            if (result.error) { showErrorModal("Queue Failed", result.error); }
            else { addLog(`Queued free Train Model (0W)`); }
            refreshData();
            return;
        }
    }

    let targetRegion = null, targetCardId = null, targetSubAction = null;

    // Play Card: visual card selection
    if (slug === 'play_card') {
        const committedIds = getCommittedCardIds();
        const playableHand = (me.hand || []).filter(c => !committedIds.has(c.id));
        if (playableHand.length === 0) { showErrorModal("Play Card", "No cards available to play."); return; }
        const usedNums = Game.currentGameState.placements.filter(p => p.player_id === Game.PLAYER_ID).map(p => p.worker_number);
        const recruits = Game.currentGameState.placements.filter(p => p.player_id === Game.PLAYER_ID && p.action_type === 'recruit').length;
        const maxAvail = me.total_worker_count + recruits - usedNums.length;
        const projectedReduction = getProjectedCardCostReduction(me);

        const selectedCard = await promptCardChoice("Play Card", `Workers available: ${maxAvail}`, playableHand, maxAvail, projectedReduction, me);
        if (!selectedCard) return;

        const playerTargetSlugs = ['back_to_office', 'content_moderation', 'cooling_failure', 'fake_celebrity_death', 'hack_toasters', 'phishing_scam', 'poach_engineers', 'ransomware', 'spin_media', 'squeeze_competition', 'supply_chain_meltdown', 'private_jet'];
        const regionTargetSlugs = ['ceo_twitter_rampage', 'freemium_infrastructure'];

        if (selectedCard.effect_slug && playerTargetSlugs.includes(selectedCard.effect_slug)) {
            const allOpps = Game.currentGameState.players.filter(p => p.id !== Game.PLAYER_ID);
            const validOpps = getValidTargets(selectedCard, me, allOpps);
            if (validOpps.length === 0) { showErrorModal("No Valid Target", "No opponent meets this card's requirements."); return; }
            if (validOpps.length > 1) {
                const chosenTargetId = await promptTargetChoiceWithCard(me, selectedCard, validOpps);
                if (!chosenTargetId) return;
                targetSubAction = String(chosenTargetId);
            } else {
                targetSubAction = String(validOpps[0].id);
            }
        } else if (selectedCard.effect_slug && regionTargetSlugs.includes(selectedCard.effect_slug)) {
            const myRegions = new Set(me.presence_regions || []);
            if (myRegions.size === 0) { showErrorModal("No Valid Region", "You have no presence regions to target."); return; }
            const regionId = await promptMapRegionChoice("Choose Target Region", "Select a region where you have presence:", myRegions);
            if (!regionId) return;
            targetSubAction = `region:${regionId}`;
        }

        const effectiveCost = Math.max(0, selectedCard.cost - projectedReduction);

        if (effectiveCost === 0) {
            let freeSlot = null;
            if (selectedCard.is_effect) {
                const activeSlots = (me.active_effects || []).map(e => e.slot);
                for (let s = 1; s <= 3; s++) { if (!activeSlots.includes(s)) { freeSlot = s; break; } }
                if (!freeSlot) freeSlot = 1;
            }
            let freePlayPayload = null;
            if (selectedCard.effect_slug === 'free_wifi') {
                const choice = await promptUserChoice(`${me.name} - Sponsor Free Wifi`, "Pay $1 for reputation boost? (You may skip)", ["Pay $1", "Skip"]);
                if (choice === "Skip" || !choice) freePlayPayload = {skip: true};
            }

            const result = Engine.playCard(Game.localState, Game.PLAYER_ID, selectedCard.id, freeSlot, freePlayPayload);
            if (result.error) { showErrorModal("Card Failed", result.error); }
            else {
                const effectResult = result.effect_result || result;
                if (effectResult.requires_choice && effectResult.drawn_cards) {
                    await handleDrawnCardChoice(Game.PLAYER_ID, effectResult.drawn_cards);
                } else {
                    addLog(`Played ${selectedCard.name} (free)`);
                }
                if (!selectedCard.is_effect) Game.cardsPlayedThisTurn.push(selectedCard);
            }
            refreshData();
            return;
        }

        targetCardId = selectedCard.id;
        workersToPlaceCount = effectiveCost;
    }

    // Scale Presence: visual map picker
    if (slug === 'scale_presence') {
        const myPresence = new Set([...me.presence_regions]);
        Game.currentGameState.placements.filter(p => p.player_id === Game.PLAYER_ID && p.action_type === 'scale_presence' && p.target_region).forEach(p => myPresence.add(p.target_region));
        const neighbors = new Set();
        myPresence.forEach(rId => { (WORLD_MAP[rId] || []).forEach(a => { if (!myPresence.has(a)) neighbors.add(a); }); });
        if (neighbors.size === 0) { showErrorModal("Scale Presence", "No adjacent regions available."); return; }
        const regionId = await promptMapRegionChoice("Expand Presence", "Click an adjacent region:", neighbors);
        if (!regionId) return;
        targetRegion = regionId;
    }

    // Find available worker numbers
    const usedNumbers = Game.currentGameState.placements.filter(p => p.player_id === Game.PLAYER_ID).map(p => p.worker_number);
    const recruits = Game.currentGameState.placements.filter(p => p.player_id === Game.PLAYER_ID && p.action_type === 'recruit').length;
    const projTotal = me.total_worker_count + recruits;
    let workersToPlace = [];
    for (let i = 1; i <= projTotal; i++) {
        if (!usedNumbers.includes(i)) { workersToPlace.push(i); if (workersToPlace.length === workersToPlaceCount) break; }
    }
    if (workersToPlaceCount > 0 && workersToPlace.length < workersToPlaceCount) {
        showErrorModal("Insufficient Workers", "Not enough Tech Workers available."); return;
    }

    // Place all workers locally, broadcasting each placement.
    let lastResult = {};
    for (const wId of workersToPlace) {
        lastResult = Engine.placeWorker(Game.localState, Game.PLAYER_ID, wId, slug, targetRegion, targetCardId, targetSubAction);
        if (lastResult.error) { showErrorModal("Action Unavailable", lastResult.error); break; }
        broadcastAction({
            kind: 'place_worker',
            args: {playerId: Game.PLAYER_ID, workerNumber: wId, slug, targetRegion, targetCardId, targetSubAction},
        });
    }
    if (!lastResult.error) addLog(`Workers ${workersToPlace.join(",")} -> ${actionName}`);
    refreshData();
}

// ── STRATEGY EXECUTION ────────────────────────────────────
async function startStrategyExecution() {
    refreshData();
    if (!Game.currentGameState) { addLog("CRITICAL: No game state."); return; }

    const unready = Game.currentGameState.players.filter(p =>
        Game.currentGameState.placements.filter(pl => pl.player_id === p.id).length === 0
    );
    if (unready.length > 0) {
        // In MP, do not auto-switch — each player drives their own device.
        if (Game.mp.mode !== 'local' && Game.mp.connected) {
            const me = Game.currentGameState.players.find(p => p.id === Game.PLAYER_ID);
            const meReady = !unready.find(p => p.id === Game.PLAYER_ID);
            if (!meReady && me) {
                addLog(`You still need to place workers.`);
                return;
            }
            addLog(`Waiting for ${unready.map(p => p.name).join(', ')} to place workers.`);
            return;
        }
        await switchPlayer(unready[0].id);
        await promptDiscardIfNeeded(unready[0].id);
        addLog(`Switching to ${unready[0].name} — they need to place workers.`);
        return;
    }

    // Broadcast the execute trigger so other clients run the same resolution.
    broadcastAction({kind: 'execute_strategy', args: {}});

    addLog("SYSTEM: Executing Quarterly Strategy...");
    const resolveResult = Engine.resolveEntireRound(Game.localState);
    const resolutionLog = resolveResult.resolution_log || [];
    addLog(`SYSTEM: ${resolutionLog.length} actions resolved.`);

    if (resolutionLog.length > 0) {
        await animateResolution(resolutionLog);
    }

    addLog("SYSTEM: Finalizing round...");
    await finishRound();
    Game.cardsPlayedThisTurn = [];

    refreshData();
    if (Game.currentGameState?.players.length > 0) {
        if (Game.mp.mode !== 'local' && Game.mp.connected) {
            // MP: only the local player is prompted; other clients prompt
            // their own user. The dropdown is locked in MP.
            await promptDiscardIfNeeded(Game.PLAYER_ID);
        } else {
            // Hot-seat: every over-limit player gets prompted in turn.
            for (const p of Game.currentGameState.players) {
                const limit = p.hand_limit || 5;
                if ((p.hand?.length || 0) > limit) {
                    await switchPlayer(p.id);
                    await promptDiscardIfNeeded(p.id);
                }
            }

            const newP1 = Game.currentGameState.p1_index ?? 0;
            const first = Game.currentGameState.players.sort((a, b) => a.id - b.id)[newP1 % Game.currentGameState.players.length];
            if (first) {
                await switchPlayer(first.id);
                addLog(`${first.name}'s turn to place workers.`);
            }
        }
    }
}

// ── PROJECTED STATE ───────────────────────────────────────
function getProjectedState(player) {
    return {
        ...player,
        corporate_funds: player.projected_funds ?? player.corporate_funds,
        reputation: player.projected_reputation ?? player.reputation,
        compute_level: player.projected_compute ?? player.compute_level,
        model_version: player.projected_model ?? player.model_version,
        total_worker_count: player.projected_workers ?? player.total_worker_count,
        presence_count: player.projected_presence ?? player.presence_count,
        net_worth: player.projected_net_worth ?? player.net_worth,
        subsidy_tokens: player.projected_subsidies ?? player.subsidy_tokens,
    };
}

function getProjectedCardCostReduction(player) {
    return player.temp_card_cost_worker_reduction || 0;
}

function getProjectedModelCostReduction(player) {
    let reduction = player.temp_model_cost_worker_reduction || 0;
    if (Game.currentGameState) {
        const myPlayCardPlacements = Game.currentGameState.placements.filter(
            p => p.player_id === player.id && p.action_type === 'play_card' && p.target_card_id
        );
        for (const pl of myPlayCardPlacements) {
            const card = (player.hand || []).find(c => c.id == pl.target_card_id);
            if (card) {
                if (card.effect_slug === 'gpu_tech') reduction++;
                if (card.effect_slug === 'sweatshop') reduction += 2;
            }
        }
        for (const card of Game.cardsPlayedThisTurn) {
            if (card.effect_slug === 'gpu_tech') reduction++;
            if (card.effect_slug === 'sweatshop') reduction += 2;
        }
    }
    return reduction;
}

function getCommittedCardIds() {
    if (!Game.currentGameState) return new Set();
    return new Set(
        Game.currentGameState.placements
            .filter(p => p.action_type === 'play_card' && p.target_card_id)
            .map(p => p.target_card_id)
    );
}

function checkCardRequirements(card, player) {
    const slug = card.effect_slug;
    if (!slug) return {met: true};
    if (player.ransomware_locked >= 2) return {met: false, reason: "RANSOMWARE LOCKED"};
    const p = getProjectedState(player);
    if (slug === 'hack_competitor_model' && p.corporate_funds < 4) return {met: false, reason: "Need $4"};
    if (slug === 'vc_investor' && p.corporate_funds >= 10) return {met: false, reason: "Funds must be <$10"};
    if ((slug === 'build_hq' || slug === 'intern_program') && p.presence_count < 2) return {met: false, reason: "Need 2+ regions"};
    if (slug === 'debt_expansion' && p.presence_count < 5) return {met: false, reason: "Need 5+ regions"};
    if (slug === 'bribe_un' && p.presence_count > 5) return {met: false, reason: "Max 5 regions"};
    if (slug === 'model_hype' && p.presence_count > 7) return {met: false, reason: "Max 7 regions"};
    if (slug === 'court_autocrat' && p.reputation < 1) return {met: false, reason: "Need 1+ rep"};
    if (slug === 'powerpoint' && p.reputation < 1) return {met: false, reason: "Need 1+ rep"};
    if (slug === 'sweatshop' && p.reputation < 2) return {met: false, reason: "Need 2+ rep"};
    // private_jet: no reputation requirement (card text says "None")
    // phishing_scam: only requires power >= 10 (checked below)
    if (slug === 'corporate_espionage' && p.model_version < 3) return {met: false, reason: "Need model v3+"};
    if (slug === 'defense_contract' && p.model_version >= 5) return {met: false, reason: "Model must be <5"};
    if (slug === 'burn_out' && p.compute_level > 4) return {met: false, reason: "Compute must be <=4"};
    const COMPUTE_NW = {3:1, 4:1, 5:2, 6:2, 7:2};
    if ((slug === 'nerdy_optimization' || slug === 'powerpoint') && p.compute_level < 7) {
        const nextC = p.compute_level + 1;
        const nwReq = COMPUTE_NW[nextC] || 0;
        if (p.net_worth < nwReq) return {met: false, reason: nwReq === 1 ? "Need Millionaire" : "Need Billionaire"};
    }
    if (slug === 'burn_out' && p.compute_level <= 4) {
        for (let add = 1; add <= 2; add++) {
            const nextC = p.compute_level + add;
            const nwReq = COMPUTE_NW[nextC] || 0;
            if (nextC <= 7 && p.net_worth < nwReq) return {met: false, reason: nwReq === 1 ? "Need Millionaire" : "Need Billionaire"};
        }
    }
    if (['whitepaper', 'spaghetti_code', 'remote_work'].includes(slug)) {
        const nextW = p.total_worker_count + 1;
        if (nextW >= 7 && p.net_worth < 2) return {met: false, reason: "Need Billionaire for 7+ workers"};
        if (nextW >= 5 && p.net_worth < 1) return {met: false, reason: "Need Millionaire for 5+ workers"};
    }
    if (slug === 'recruiting_pipeline') {
        const nextW2 = p.total_worker_count + 2;
        if (nextW2 > 8) return {met: false, reason: "Max workers"};
        if (nextW2 >= 7 && p.net_worth < 2) return {met: false, reason: "Need Billionaire"};
        if (nextW2 >= 5 && p.net_worth < 1) return {met: false, reason: "Need Millionaire"};
    }
    if (['spaghetti_code', 'whitepaper', 'remote_work'].includes(slug) && p.total_worker_count >= 8) return {met: false, reason: "Max workers"};
    if (slug === 'poach_engineers' && p.total_worker_count >= 8) return {met: false, reason: "Max workers"};
    if (slug === 'layoffs' && p.total_worker_count <= 1) return {met: false, reason: "Can't fire last worker"};
    if (slug === 'hack_competitor_model' && Game.currentGameState) {
        const opps = Game.currentGameState.players.filter(o => o.id !== player.id);
        if (!opps.some(o => o.model_version > p.model_version)) return {met: false, reason: "No opponent has higher model"};
    }
    if (slug === 'patent_troll' && p.power < 5) return {met: false, reason: "Need 5+ power"};
    if (slug === 'phishing_scam' && p.power < 10) return {met: false, reason: "Need 10+ power"};
    if (slug === 'hack_toasters' && p.model_version < 3) return {met: false, reason: "Need model v3+"};
    return {met: true};
}

function getValidTargets(card, attacker, opponents) {
    const slug = card.effect_slug;
    const attackerRegions = new Set(attacker.presence_regions || []);
    if (Game.currentGameState) {
        Game.currentGameState.placements
            .filter(p => p.player_id === attacker.id && p.action_type === 'scale_presence' && p.target_region)
            .forEach(p => attackerRegions.add(p.target_region));
    }
    return opponents.filter(opp => {
        const oppRegions = new Set(opp.presence_regions || []);
        const hasShared = [...attackerRegions].some(r => oppRegions.has(r));
        if (slug === 'unionize_robots') return true;
        if (slug === 'cooling_failure') return opp.compute_level > attacker.compute_level;
        if (!hasShared) return false;
        if (slug === 'poach_engineers' || slug === 'ransomware') return opp.total_worker_count >= 4;
        if (slug === 'squeeze_competition') return opp.presence_count > attacker.presence_count;
        if (slug === 'hack_toasters') return (opp.active_effects || []).length > 0;
        if (slug === 'private_jet') return opp.subsidy_tokens >= 1;
        return true;
    });
}

function isActionAvailable(actionSlug) {
    if (!Game.currentGameState?.availability) return true;
    let key = actionSlug === 'train_new_model' ? 'train_model' : actionSlug;
    const r = Game.currentGameState.availability[key];
    return r ? r.available : true;
}

// ── UNDO ──────────────────────────────────────────────────
async function undoPlacement() {
    if (!Game.PLAYER_ID) return;
    const result = Engine.undoLastPlacement(Game.localState, Game.PLAYER_ID);
    if (result.error) { addLog(`Error: ${result.error}`); }
    else {
        addLog(`Undo: W${result.worker_number} from ${result.from_action}`);
        broadcastAction({kind: 'undo_placement', args: {playerId: Game.PLAYER_ID}});
    }
    refreshData();
}
