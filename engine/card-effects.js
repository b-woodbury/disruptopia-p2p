// Disruptopia P2P - Card Effects
// Ported from backend/effects_research.py, effects_influence.py, effects_sabotage.py
// Operates on a plain JS game state object (no database)
//
// Each effect function takes (state, playerId, cardId, payload) and returns
// { success: true, message: "..." } or { error: "..." }
//
// Depends on globals: Engine (from game-engine.js), Config (config constants)

// ==========================================
// SHARED HELPERS
// ==========================================

function _getPlayer(state, playerId) {
    return state.players.find(p => p.id === playerId);
}

function _addPower(state, player, amount) {
    player.power = Engine.clampPower(player.power + amount);
    Engine.updatePlayerIncome(state, player);
}

function _addReputation(state, player, amount) {
    player.reputation = Engine.clampRep(player.reputation + amount);
}

function _getSharedPresenceOpponents(state, playerId) {
    const player = _getPlayer(state, playerId);
    const playerRegions = new Set(player.presenceRegions);
    return state.players.filter(p => {
        if (p.id === playerId) return false;
        return p.presenceRegions.some(r => playerRegions.has(r));
    });
}

function _getSharedTarget(state, playerId, payload) {
    if (payload && payload.target_player_id != null) {
        const player = _getPlayer(state, playerId);
        const target = _getPlayer(state, payload.target_player_id);
        if (!target || target.id === playerId) return null;
        const playerRegions = new Set(player.presenceRegions);
        if (target.presenceRegions.some(r => playerRegions.has(r))) return target;
        return null;
    }
    const shared = _getSharedPresenceOpponents(state, playerId);
    if (shared.length === 1) return shared[0];
    return null;
}

function _getTargetOpponent(state, playerId, payload) {
    const opponents = state.players.filter(p => p.id !== playerId);
    if (!opponents.length) return null;
    if (payload && payload.target_player_id != null) {
        const target = _getPlayer(state, payload.target_player_id);
        if (target && target.id !== playerId) return target;
    }
    if (opponents.length === 1) return opponents[0];
    return null;
}

function _addPendingInteraction(state, interaction) {
    if (!state.game.pendingInteractions) state.game.pendingInteractions = [];
    state.game.pendingInteractions.push(interaction);
}

function _checkWorkerNwReq(player, added) {
    if (added == null) added = 1;
    const nextNum = player.totalWorkers + added;
    if (nextNum >= 7 && player.netWorthLevel < 2) {
        return { error: "Must be Billionaire for 7+ Tech Workers." };
    }
    if (nextNum >= 5 && player.netWorthLevel < 1) {
        return { error: "Must be Millionaire for 5+ Tech Workers." };
    }
    return null;
}

function _checkComputeNwReq(player, added) {
    if (added == null) added = 1;
    const nextLevel = player.computeLevel + added;
    const nwReq = (Config.COMPUTE_NET_WORTH_REQ || {})[nextLevel] || 0;
    if (player.netWorthLevel < nwReq) {
        const nwNames = { 0: "Startup", 1: "Millionaire", 2: "Billionaire" };
        return { error: `Must be ${nwNames[nwReq]} for Compute Level ${nextLevel}.` };
    }
    return null;
}

function _countCompetitorOnlyPresence(state, playerId) {
    const playerRegions = new Set(_getPlayer(state, playerId).presenceRegions);
    const allOccupied = new Set();
    for (const p of state.players) {
        if (p.id === playerId) continue;
        for (const r of p.presenceRegions) allOccupied.add(r);
    }
    let count = 0;
    for (const r of allOccupied) {
        if (!playerRegions.has(r)) count++;
    }
    return count;
}


// ==========================================
// CARD EFFECTS REGISTRY
// ==========================================

const CardEffects = {

    // ------------------------------------------
    // RESEARCH EFFECTS
    // ------------------------------------------

    gpu_tech(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        player.tempModelCostWorkerReduction += 1;
        return { success: true, message: "GPU Tech: Model Upgrades -1 Worker Cost this round." };
    },

    microdosing_interns(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        player.tempCardCostWorkerReduction += 1;
        return { success: true, message: "Microdosing: Cards -1 Worker Cost this round." };
    },

    unethical_data(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);

        // Phase 2: Player has chosen a card to play
        if (payload && payload.chosen_card_id != null) {
            const chosenId = payload.chosen_card_id;
            const otherId = payload.other_card_id;
            const cPlay = state.components.find(c => c.id === chosenId);
            if (!cPlay) return { error: "Chosen card not found." };
            const cPlayDef = state.cardDefinitions.find(d => d.id === cPlay.cardDetailsId);

            // Play the chosen card
            if (cPlayDef && cPlayDef.isEffect) {
                let slot = 1;
                for (let s = 1; s <= 3; s++) {
                    if (!state.components.find(c => c.zone === `active_effect_card_slot_${s}_p${playerId}`)) {
                        slot = s;
                        break;
                    }
                }
                if (cPlayDef.effectSlug && CardEffects[cPlayDef.effectSlug]) {
                    CardEffects[cPlayDef.effectSlug](state, playerId, cPlay.id, {});
                }
                cPlay.zone = `active_effect_card_slot_${slot}_p${playerId}`;
            } else {
                if (cPlayDef && cPlayDef.effectSlug && CardEffects[cPlayDef.effectSlug]) {
                    CardEffects[cPlayDef.effectSlug](state, playerId, cPlay.id, {});
                }
                cPlay.zone = `${cPlay.subType}_discard`;
                cPlay.ownerId = null;
            }

            // Discard the unchosen card
            if (otherId != null) {
                const cOther = state.components.find(c => c.id === otherId);
                if (cOther && cOther.zone === `hand_p${playerId}`) {
                    cOther.zone = `${cOther.subType}_discard`;
                    cOther.ownerId = null;
                }
            }

            return { success: true, message: `Played ${cPlayDef ? cPlayDef.name : "card"} for free! Other card discarded.` };
        }

        // Phase 1: Draw 2 research cards
        const drawnCards = [];
        for (let i = 0; i < 2; i++) {
            const res = Engine.drawCard(state, playerId, "research_deck");
            if (res.componentId != null) {
                const c = state.components.find(comp => comp.id === res.componentId);
                if (c) drawnCards.push(c);
            }
        }

        if (drawnCards.length === 0) {
            return { success: true, message: "Deck empty, nothing drawn." };
        }

        // Check for Sweatshop
        const sweatshopDrawn = drawnCards.some(c => {
            const def = state.cardDefinitions.find(d => d.id === c.cardDetailsId);
            return def && def.effectSlug === "sweatshop";
        });

        if (sweatshopDrawn) {
            for (const c of drawnCards) {
                c.zone = `${c.subType}_discard`;
                c.ownerId = null;
            }
            _addReputation(state, player, -1);
            return { success: true, message: "Drawn Sweatshop! Discarded both, -1 Rep." };
        }

        // Return drawn cards for choice
        return {
            success: true,
            requires_choice: true,
            message: "Choose 1 of the drawn cards to play for free. The other is discarded.",
            drawn_cards: drawnCards.map(c => {
                const def = state.cardDefinitions.find(d => d.id === c.cardDetailsId);
                return {
                    id: c.id,
                    name: def ? def.name : "Unknown",
                    is_effect: def ? def.isEffect : false,
                    image_file: def ? def.image : null,
                    effect_slug: def ? def.effectSlug : null,
                    cost: def ? def.cost : 0,
                };
            }),
        };
    },

    whitepaper(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.totalWorkers >= 8) return { error: "Max workers reached." };
        const nwErr = _checkWorkerNwReq(player);
        if (nwErr) return nwErr;
        player.totalWorkers += 1;
        return { success: true, message: "Whitepaper: +1 Worker (Available Now)." };
    },

    sweatshop(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.reputation < 2) return { error: "Requirement not met: Need at least 2 Reputation." };
        player.tempModelCostWorkerReduction += 2;
        _addReputation(state, player, -2);
        return { success: true, message: "Sweatshop: Model Cost -2 Workers, -2 Rep." };
    },

    hack_competitor_model(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);

        // Req: Competitor with higher model
        const competitors = state.players.filter(p => p.id !== playerId);
        if (!competitors.some(c => c.modelVersion > player.modelVersion)) {
            return { error: "Requirement not met: No competitor has a higher Model Version." };
        }

        if (player.corporateFunds < 4) return { error: "Insufficient funds: Need $4." };

        const nextVersion = player.modelVersion + 1;
        if (nextVersion > 7) return { error: "Maximum Model Version reached." };
        if (player.computeLevel < nextVersion) {
            return { error: `Insufficient Compute Level. Need ${nextVersion}.` };
        }

        const nwReq = (Config.MODEL_NET_WORTH_REQ || {})[nextVersion] || 0;
        if (player.netWorthLevel < nwReq) {
            const nwNames = { 0: "Startup", 1: "Millionaire", 2: "Billionaire" };
            return { error: `Must be ${nwNames[nwReq]} for Model Version ${nextVersion}.` };
        }

        player.corporateFunds -= 4;
        player.modelVersion = nextVersion;
        player.reputation = Engine.clampRep(player.reputation + 1);
        player.power = Engine.clampPower(player.power + Math.floor(player.presenceCount / 2));
        Engine.updatePlayerIncome(state, player);
        Engine.checkReputationTiles(state, playerId);
        return { success: true, message: `Hacked Model: Upgraded to V${player.modelVersion}.` };
    },

    recruiting_pipeline(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);

        if (player.totalWorkers >= 7) {
            return { error: `Cannot recruit 2 workers. Max is 8, you have ${player.totalWorkers}.` };
        }

        const next1 = player.totalWorkers + 1;
        const next2 = player.totalWorkers + 2;

        // Check NW for both new workers
        for (const nextNum of [next1, next2]) {
            const tier = Config.RECRUIT_COSTS[nextNum] || Config.RECRUIT_COSTS[4];
            if (player.netWorthLevel < tier.min_nw) {
                const nwNames = { 0: "Startup", 1: "Millionaire", 2: "Billionaire" };
                return { error: `Must be ${nwNames[tier.min_nw]} for worker #${nextNum}.` };
            }
        }

        // Pay only the more expensive (always the higher worker number)
        const costTier = Config.RECRUIT_COSTS[next2] || Config.RECRUIT_COSTS[4];
        const costCash = costTier.money;

        if (player.corporateFunds < costCash) {
            return { error: `Insufficient funds: Need $${costCash}.` };
        }

        player.corporateFunds -= costCash;
        player.totalWorkers += 2;
        return { success: true, message: `Pipeline Built: +2 Workers for $${costCash}.` };
    },

    open_source(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const bonus = Math.floor(player.presenceCount / 2);
        _addPower(state, player, bonus);
        return { success: true, message: `Open Source: +${bonus} Power.` };
    },

    spaghetti_code(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.totalWorkers >= 8) return { error: "Max workers reached." };
        const nwErr = _checkWorkerNwReq(player);
        if (nwErr) return nwErr;
        player.totalWorkers += 1;
        return { success: true, message: "Spaghetti Code: +1 Worker (Free)." };
    },

    nerdy_optimization(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.computeLevel >= 7) return { success: true, message: "Already at max Compute Level." };
        const nwErr = _checkComputeNwReq(player);
        if (nwErr) return nwErr;
        player.computeLevel += 1;
        return { success: true, message: "Optimized: +1 Compute." };
    },

    big_compute_energy(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        player.tempComputeGainPowerBonus += 2;
        return { success: true, message: "Big Compute Energy active." };
    },

    powerpoint(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.reputation < 1) return { error: "Requirement not met: Need at least 1 Reputation." };
        if (player.computeLevel >= 7) return { success: true, message: "Already at max Compute Level." };
        const nwErr = _checkComputeNwReq(player);
        if (nwErr) return nwErr;
        player.computeLevel += 1;
        _addReputation(state, player, -1);
        return { success: true, message: "Powerpoint: +1 Compute, -1 Rep." };
    },

    burn_out(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.computeLevel > 4) return { error: "Requirement not met: Compute must be at most 4." };
        if (player.totalWorkers <= 1) return { error: "Cannot burn out last worker." };
        // Check NW for both levels of compute gain
        for (let added = 1; added <= 2; added++) {
            if (player.computeLevel + added <= 7) {
                const nwErr = _checkComputeNwReq(player, added);
                if (nwErr) return nwErr;
            }
        }
        player.computeLevel = Math.min(7, player.computeLevel + 2);
        player.totalWorkers -= 1;
        return { success: true, message: "Burn Out: +2 Compute, -1 Worker." };
    },

    hackathon(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        player.tempComputeMonetaryDiscount += 3;
        return { success: true, message: "Hackathon: Compute Upgrade -$3 discount." };
    },

    model_hype(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.presenceCount > 7) return { error: "Requirement not met: Presence <= 7." };
        player.tempTrainModelPerRegionPowerBonus = true;
        return { success: true, message: "Model Hype active." };
    },

    piggyback(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        player.tempPiggybackCompetitorModel = true;
        return { success: true, message: "Piggyback active." };
    },

    remote_work(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.totalWorkers >= 8) return { error: "Max workers reached." };
        const nwErr = _checkWorkerNwReq(player);
        if (nwErr) return nwErr;
        player.totalWorkers += 1;

        // Block usage this round with dummy placement
        const newWorkerNum = player.totalWorkers;
        state.workerPlacements.push({
            playerId: playerId,
            workerNumber: newWorkerNum,
            actionType: "remote_work_cooldown",
            targetRegion: 0,
            targetCardId: null,
            targetSubAction: null,
        });
        return { success: true, message: "Remote Work: +1 Worker (Available Next Round)." };
    },

    // ------------------------------------------
    // INFLUENCE EFFECTS
    // ------------------------------------------

    build_hq(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.presenceCount < 2) return { error: "Requirement not met: Presence in at least 2 Regions." };
        _addReputation(state, player, 2);
        _addPower(state, player, 2);
        return { success: true, message: "HQ Built! +2 Rep, +2 Power." };
    },

    corporate_espionage(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.modelVersion < 3) return { error: "Requirement not met: Model Version must be at least 3." };
        return { success: true, message: "Espionage active." };
    },

    defense_contract(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.modelVersion >= 5) return { error: "Requirement not met: Model Version must be less than 5." };
        const boost = { 0: 1, 1: 2, 2: 3 }[player.netWorthLevel] || 1;
        _addPower(state, player, boost);
        return { success: true, message: `Defense Contract signed. +${boost} Power.` };
    },

    intern_program(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.presenceCount < 2) return { error: "Requirement not met: Presence in at least 2 Regions." };
        _addReputation(state, player, 2);
        return { success: true, message: "Interns hired. +2 Reputation. This card cannot be discarded." };
    },

    management_restructuring(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const canSell = Math.min(player.power, 3);
        if (canSell === 0) return { success: true, message: "No power to sell." };
        let toSell;
        if (payload && payload.amount != null) {
            toSell = Math.max(0, Math.min(3, Math.min(parseInt(payload.amount), canSell)));
        } else {
            toSell = canSell;
        }
        if (toSell === 0) return { success: true, message: "No power sold." };
        const earned = toSell * 5;
        player.power -= toSell;
        player.corporateFunds += earned;
        Engine.updatePlayerIncome(state, player);
        return { success: true, message: `Sold ${toSell} Power for $${earned}.` };
    },

    influencer_marketing(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const cash = { 0: 6, 1: 8, 2: 10 }[player.netWorthLevel] || 6;
        player.corporateFunds += cash;
        return { success: true, message: `Influencers paid off. +$${cash}.` };
    },

    carbon_offsets(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const amount = player.subsidyTokens;
        if (amount > 0) _addReputation(state, player, amount);
        return { success: true, message: `Greenwashed! +${amount} Reputation.` };
    },

    celebrity_tour(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);

        if (payload && payload.regions) {
            const regions = payload.regions.slice(0, 2);
            if (regions.length === 0) return { error: "No regions selected." };

            // Validate adjacency for each region
            const owned = new Set(player.presenceRegions);
            const expanded = new Set(owned);
            for (const regionId of regions) {
                if (owned.has(regionId)) continue;
                let isAdjacent = false;
                for (const rId of expanded) {
                    if ((Config.WORLD_MAP[rId] || []).includes(regionId)) {
                        isAdjacent = true;
                        break;
                    }
                }
                if (!isAdjacent) return { error: `Region ${regionId} is not adjacent to your territory.` };
                expanded.add(regionId);
            }

            // Calculate costs - pay only the more expensive
            const currentCount = player.presenceCount;
            const costs = [];
            for (let i = 0; i < regions.length; i++) {
                let idx = (currentCount + i) - 1;
                if (idx < 0) idx = 0;
                if (idx >= Config.PRESENCE_COSTS.length) {
                    costs.push(Config.PRESENCE_COSTS[Config.PRESENCE_COSTS.length - 1]);
                } else {
                    costs.push(Config.PRESENCE_COSTS[idx]);
                }
            }

            const totalCost = costs.length ? Math.max(...costs) : 0;
            if (player.corporateFunds < totalCost) {
                return { error: `Insufficient funds. Need $${totalCost}.` };
            }

            player.corporateFunds -= totalCost;

            for (const regionId of regions) {
                if (player.presenceRegions.includes(regionId)) continue;
                player.presenceRegions.push(regionId);
                player.presenceCount += 1;
                const rs = state.regionStates.find(r => r.regionId === regionId);
                if (rs && rs.subsidyTokensRemaining > 0) {
                    rs.subsidyTokensRemaining -= 1;
                    player.subsidyTokens += 1;
                }
            }

            Engine.updatePlayerIncome(state, player);
            return { success: true, message: `Celebrity Tour! Expanded to ${regions.length} regions for $${totalCost}.` };
        }

        // No regions specified - create pending interaction
        const owned = new Set(player.presenceRegions);
        const neighbors = [];
        for (const rId of owned) {
            for (const adj of (Config.WORLD_MAP[rId] || [])) {
                if (!owned.has(adj) && !neighbors.includes(adj)) {
                    neighbors.push(adj);
                }
            }
        }
        if (neighbors.length === 0) return { error: "No adjacent regions available for expansion." };

        _addPendingInteraction(state, {
            type: "choose_regions",
            responding_player_id: playerId,
            card_name: "Celebrity Sponsor World Tour",
            effect_slug: "celebrity_tour",
            max_regions: 2,
            available_regions: neighbors.sort((a, b) => a - b),
            current_presence: [...owned].sort((a, b) => a - b),
        });
        return {
            success: true,
            message: "Celebrity Tour queued - choose 2 regions to expand into.",
            requires_interaction: true,
        };
    },

    free_wifi(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);

        // Player may opt out
        if (payload && payload.skip) {
            return { success: true, message: "Free Wifi played but opted not to pay $1." };
        }

        if (player.corporateFunds < 1) {
            return { success: true, message: "Free Wifi played but you have no funds to pay." };
        }

        player.corporateFunds -= 1;
        const boost = { 0: 3, 1: 2, 2: 1 }[player.netWorthLevel] || 3;
        _addReputation(state, player, boost);
        return { success: true, message: `Wifi Sponsored. +${boost} Reputation for $1.` };
    },

    debt_expansion(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.presenceCount < 5) return { error: "Requirement not met: Presence in at least 5 Regions." };
        player.tempPresenceMonetaryDiscount += 4;
        return { success: true, message: "Expansion discount active: -$4 on Scale Presence this round." };
    },

    bribe_un(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.presenceCount > 5) return { error: "Requirement not met: Presence in at most 5 Regions." };
        const amount = player.presenceCount;
        _addPower(state, player, amount);
        return { success: true, message: `UN Bribed. +${amount} Power.` };
    },

    hire_ethicist(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const count = _countCompetitorOnlyPresence(state, playerId);
        _addReputation(state, player, count);
        return { success: true, message: `Ethicist hired. +${count} Reputation.` };
    },

    podcast_tour(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const affordable = Math.min(3, player.corporateFunds);
        let toBuy;
        if (payload && payload.amount != null) {
            toBuy = Math.max(0, Math.min(3, Math.min(parseInt(payload.amount), affordable)));
        } else {
            toBuy = affordable;
        }
        if (toBuy === 0) return { success: true, message: "No funds to buy power." };
        player.corporateFunds -= toBuy;
        _addPower(state, player, toBuy);
        return { success: true, message: `Podcast Tour complete. +${toBuy} Power for $${toBuy}.` };
    },

    community_ads(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        _addReputation(state, player, player.presenceCount);
        return { success: true, message: `Ads run. +${player.presenceCount} Reputation.` };
    },

    hire_lobbyist(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const boost = { 0: 1, 1: 2, 2: 3 }[player.netWorthLevel] || 1;
        _addPower(state, player, boost);
        return { success: true, message: `Lobbyist hired. +${boost} Power.` };
    },

    court_autocrat(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.reputation < 1) return { error: "Requirement not met: Reputation must be at least 1." };
        const repLoss = player.presenceCount;
        _addPower(state, player, 3);
        player.reputation = Math.max(-3, player.reputation - repLoss);
        return { success: true, message: `Autocrat courted. +3 Power, -${repLoss} Rep.` };
    },

    layoffs(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.totalWorkers <= 1) return { error: "Cannot fire last worker." };
        const gain = player.totalWorkers * 3; // Calculated BEFORE losing worker
        player.totalWorkers -= 1;
        player.corporateFunds += gain;
        return { success: true, message: `Layoffs executed. +$${gain}, -1 Worker.` };
    },

    vc_investor(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.corporateFunds >= 10) return { error: "Requirement not met: Corporate Funds must be less than $10." };
        const gain = { 0: 4, 1: 6, 2: 8 }[player.netWorthLevel] || 4;
        player.corporateFunds += gain;
        return { success: true, message: `VC Signed. +$${gain}.` };
    },

    university_collab(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        _addReputation(state, player, 2);
        _addPower(state, player, 1);
        player.corporateFunds += 5;
        return { success: true, message: "Collaboration successful. +2 Rep, +1 Pwr, +$5." };
    },

    // ------------------------------------------
    // SABOTAGE EFFECTS
    // ------------------------------------------

    back_to_office(state, playerId, cardId, payload) {
        const target = _getSharedTarget(state, playerId, payload);
        if (!target) return { error: "No valid target with shared presence." };
        _addReputation(state, target, -2);
        return { success: true, message: `Back to Office! ${target.userName} lost 2 Reputation.` };
    },

    ceo_twitter_rampage(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);

        if (!payload || payload.region_id == null) {
            const playerRegions = [...new Set(player.presenceRegions)].sort((a, b) => a - b);
            if (playerRegions.length === 0) return { error: "You have no presence in any region." };
            _addPendingInteraction(state, {
                type: "choose_region_attack",
                responding_player_id: playerId,
                card_name: "CEO Twitter Rampage",
                effect_slug: "ceo_twitter_rampage",
                available_regions: playerRegions,
                effect_description: "-2 Reputation to all competitors in chosen region",
            });
            return { success: true, message: "Choose a region to attack.", requires_interaction: true };
        }

        const regionId = parseInt(payload.region_id);
        const competitorsHit = [];
        for (const opp of state.players) {
            if (opp.id === playerId) continue;
            if (opp.presenceRegions.includes(regionId)) {
                _addReputation(state, opp, -2);
                competitorsHit.push(opp.userName);
            }
        }
        if (competitorsHit.length > 0) {
            return { success: true, message: `CEO Rampage in Region ${regionId}! ${competitorsHit.join(", ")} lost 2 Rep each.` };
        }
        return { success: true, message: `CEO Rampage in Region ${regionId}! No competitors there.` };
    },

    freemium_infrastructure(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        _addPower(state, player, 1);

        if (!payload || payload.region_id == null) {
            const playerRegions = [...new Set(player.presenceRegions)].sort((a, b) => a - b);
            if (playerRegions.length === 0) {
                return { success: true, message: "+1 Power. No regions to pick." };
            }
            _addPendingInteraction(state, {
                type: "choose_region_attack",
                responding_player_id: playerId,
                card_name: "City Infrastructure Running on Freemium App",
                effect_slug: "freemium_infrastructure",
                available_regions: playerRegions,
                effect_description: "Competitors there pay you $2 or lose 1 Rep",
            });
            return { success: true, message: "+1 Power. Choose a region.", requires_interaction: true };
        }

        const regionId = parseInt(payload.region_id);
        for (const opp of state.players) {
            if (opp.id === playerId) continue;
            if (opp.presenceRegions.includes(regionId)) {
                if (opp.corporateFunds >= 2) {
                    opp.corporateFunds -= 2;
                    player.corporateFunds += 2;
                } else {
                    _addReputation(state, opp, -1);
                }
            }
        }
        return { success: true, message: `Freemium chaos in Region ${regionId}! +1 Power.` };
    },

    consulting_fees(state, playerId, cardId, payload) {
        return { success: true, message: "Consulting Fees active. Shared-presence opponents pay $1 per Power gain." };
    },

    content_moderation(state, playerId, cardId, payload) {
        const target = _getSharedTarget(state, playerId, payload);
        if (!target) return { error: "No valid target with shared presence." };
        const card = state.components.find(c => c.id === cardId);
        if (card) {
            card.zone = `debuff_p${target.id}`;
            card.ownerId = target.id;
        }
        return { success: true, message: `Content Moderation handed to ${target.userName}. Cards cost +1 Worker next round.` };
    },

    cooling_failure(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const target = _getTargetOpponent(state, playerId, payload);
        if (!target) return { error: "No valid target." };
        if (target.computeLevel <= player.computeLevel) {
            return { error: `${target.userName}'s Compute (${target.computeLevel}) is not higher than yours (${player.computeLevel}).` };
        }
        target.computeLevel -= 1;
        if (target.modelVersion > target.computeLevel) {
            target.modelVersion = target.computeLevel;
        }
        Engine.updatePlayerIncome(state, target);
        const nwErr = _checkComputeNwReq(player);
        if (!nwErr && player.computeLevel < 7) {
            player.computeLevel += 1;
        }
        return { success: true, message: `Cooling Failure! ${target.userName} -1 Compute. You +1 Compute.` };
    },

    fake_celebrity_death(state, playerId, cardId, payload) {
        const target = _getSharedTarget(state, playerId, payload);
        if (!target) return { error: "No valid target with shared presence." };
        target.power = Math.max(0, target.power - 3);
        Engine.updatePlayerIncome(state, target);
        return { success: true, message: `Celebrity faked! ${target.userName} lost 3 Power.` };
    },

    gpu_price_hike(state, playerId, cardId, payload) {
        return { success: true, message: "GPU Price Hike active. Shared-presence opponents pay $1 per Compute increase." };
    },

    hack_toasters(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.modelVersion < 3) return { error: "Requirement not met: Model Version must be at least 3." };
        const target = _getSharedTarget(state, playerId, payload);
        if (!target) return { error: "No valid target with shared presence." };

        if (payload && payload.steal_card_id != null) {
            const stolen = state.components.find(c => c.id === payload.steal_card_id);
            if (!stolen) return { error: "Card not found." };

            // Find an open effect slot
            let slot = 1;
            for (let s = 1; s <= 3; s++) {
                if (!state.components.find(c => c.zone === `active_effect_card_slot_${s}_p${playerId}`)) {
                    slot = s;
                    break;
                }
            }

            // Discard existing card in slot if occupied
            const existing = state.components.find(c => c.zone === `active_effect_card_slot_${slot}_p${playerId}`);
            if (existing) {
                existing.zone = `${existing.subType}_discard`;
                existing.ownerId = null;
            }

            stolen.zone = `active_effect_card_slot_${slot}_p${playerId}`;
            stolen.ownerId = playerId;
            const stolenDef = state.cardDefinitions.find(d => d.id === stolen.cardDetailsId);
            return { success: true, message: `Stole ${stolenDef ? stolenDef.name : "a card"} from ${target.userName}!` };
        }

        // Gather target's active effect cards
        const targetEffects = [];
        for (let s = 1; s <= 3; s++) {
            const cards = state.components.filter(c => c.zone === `active_effect_card_slot_${s}_p${target.id}`);
            targetEffects.push(...cards);
        }
        if (targetEffects.length === 0) {
            return { error: `${target.userName} has no active effect cards.` };
        }

        _addPendingInteraction(state, {
            type: "steal_card",
            responding_player_id: playerId,
            target_player_id: target.id,
            target_player_name: target.userName,
            card_name: "Hack Smart Toasters",
            effect_slug: "hack_toasters",
            target_hand: targetEffects.map(c => {
                const def = state.cardDefinitions.find(d => d.id === c.cardDetailsId);
                return {
                    id: c.id,
                    name: def ? def.name : "Unknown",
                    image_file: def ? def.image : null,
                    cost: def ? def.cost : 0,
                    description: def ? def.description : "",
                };
            }),
        });
        return { success: true, message: `Choose an effect card to steal from ${target.userName}.`, requires_interaction: true };
    },

    nefarious_schemings(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        for (let i = 0; i < 2; i++) {
            Engine.drawCard(state, playerId, "sabotage_deck");
        }
        player.tempHandLimitIgnore = true;
        return { success: true, message: "Nefarious Schemings! Drew 2 Sabotage Cards. Hand limit ignored this round." };
    },

    patent_troll(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.power < 5) return { error: "Requirement not met: Power must be at least 5." };
        const sharedOpps = _getSharedPresenceOpponents(state, playerId);
        let total = 0;
        for (const opp of sharedOpps) {
            const steal = Math.min(2, opp.corporateFunds);
            opp.corporateFunds -= steal;
            player.corporateFunds += steal;
            total += steal;
        }
        return { success: true, message: `Patent Troll! Stole $${total} from ${sharedOpps.length} competitors.` };
    },

    phishing_scam(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        if (player.power < 10) return { error: "Requirement not met: Power must be at least 10." };
        const target = _getSharedTarget(state, playerId, payload);
        if (!target) return { error: "No valid target with shared presence." };
        let repLoss = 3;
        if (payload && payload.amount != null) {
            repLoss = Math.max(1, Math.min(3, parseInt(payload.amount)));
        }
        repLoss = Math.min(repLoss, player.reputation + 3);
        if (repLoss <= 0) return { error: "Not enough reputation to sacrifice." };
        player.reputation = Math.max(-3, player.reputation - repLoss);
        const powerLoss = repLoss * 2;
        target.power = Math.max(0, target.power - powerLoss);
        Engine.updatePlayerIncome(state, target);
        return { success: true, message: `Phishing! Lost ${repLoss} Rep. ${target.userName} lost ${powerLoss} Power.` };
    },

    poach_engineers(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const target = _getSharedTarget(state, playerId, payload);
        if (!target) return { error: "No valid target with shared presence." };
        if (target.totalWorkers < 4) return { error: `${target.userName} needs at least 4 Tech Workers.` };
        if (player.totalWorkers >= 8) return { error: "You already have max workers." };
        const nwErr = _checkWorkerNwReq(player);
        if (nwErr) return nwErr;
        player.totalWorkers += 1;
        _addReputation(state, player, -1);
        const card = state.components.find(c => c.id === cardId);
        if (card) {
            card.zone = `debuff_p${target.id}`;
            card.ownerId = target.id;
        }
        return { success: true, message: `Poached! +1 Worker, -1 Rep. ${target.userName} loses 1 Worker end of round.` };
    },

    private_jet(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const target = _getSharedTarget(state, playerId, payload);
        if (!target) return { error: "No valid target with shared presence." };
        if (target.subsidyTokens < 1) return { error: `${target.userName} has no Subsidy Tokens.` };
        target.subsidyTokens -= 1;
        Engine.updatePlayerIncome(state, target);
        player.subsidyTokens += 1;
        _addReputation(state, player, -1);
        Engine.updatePlayerIncome(state, player);
        return { success: true, message: `Private Jet! Stole Subsidy Token from ${target.userName}. -1 Rep.` };
    },

    ransomware(state, playerId, cardId, payload) {
        const target = _getSharedTarget(state, playerId, payload);
        if (!target) return { error: "No valid target with shared presence." };
        if (target.totalWorkers < 4) return { error: `${target.userName} needs at least 4 Tech Workers.` };
        const card = state.components.find(c => c.id === cardId);
        if (card) {
            card.zone = `debuff_p${target.id}`;
            card.ownerId = target.id;
        }
        return { success: true, message: `Ransomware handed to ${target.userName}! They lose 1 Worker next round.` };
    },

    spin_media(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const target = _getSharedTarget(state, playerId, payload);
        if (!target) return { error: "No valid target with shared presence." };
        _addReputation(state, player, 1);
        _addReputation(state, target, -2);
        return { success: true, message: `Media spun! +1 Rep. ${target.userName} -2 Rep.` };
    },

    squeeze_competition(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        const target = _getSharedTarget(state, playerId, payload);
        if (!target) return { error: "No valid target with shared presence." };
        if (target.presenceCount <= player.presenceCount) {
            return { error: `${target.userName} doesn't have more regions than you.` };
        }

        const playerRegions = new Set(player.presenceRegions);
        const targetRegions = new Set(target.presenceRegions);
        const shared = [];
        for (const r of playerRegions) {
            if (targetRegions.has(r)) shared.push(r);
        }
        if (shared.length === 0) return { error: "No shared regions." };

        if (payload && payload.region_id != null) {
            const regionToRemove = parseInt(payload.region_id);
            if (!shared.includes(regionToRemove)) {
                return { error: `Region ${regionToRemove} is not a shared region.` };
            }
            const idx = target.presenceRegions.indexOf(regionToRemove);
            if (idx !== -1) {
                target.presenceRegions.splice(idx, 1);
                target.presenceCount -= 1;
            }
            if (target.subsidyTokens > 0) {
                target.subsidyTokens -= 1;
            }
            Engine.updatePlayerIncome(state, target);
            return { success: true, message: `Squeezed! Removed ${target.userName} from Region ${regionToRemove}.` };
        }

        _addPendingInteraction(state, {
            type: "choose_squeeze_region",
            responding_player_id: playerId,
            target_player_id: target.id,
            target_player_name: target.userName,
            card_name: "Squeeze Out the Competition",
            effect_slug: "squeeze_competition",
            shared_regions: shared.sort((a, b) => a - b),
        });
        return { success: true, message: `Choose shared region to remove ${target.userName} from.`, requires_interaction: true };
    },

    supply_chain_meltdown(state, playerId, cardId, payload) {
        const target = _getSharedTarget(state, playerId, payload);
        if (!target) return { error: "No valid target with shared presence." };
        const card = state.components.find(c => c.id === cardId);
        if (card) {
            card.zone = `debuff_p${target.id}`;
            card.ownerId = target.id;
        }
        return { success: true, message: `Supply Chain Meltdown handed to ${target.userName}! Actions cost +$3 next round.` };
    },

    unionize_robots(state, playerId, cardId, payload) {
        const player = _getPlayer(state, playerId);
        player.tempP1Steal = true;
        return { success: true, message: "Unionized! You will be Player 1 next round." };
    },
};
