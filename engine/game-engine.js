// Disruptopia P2P - Game Engine
// Ported from backend/game_engine.py
// Operates on a plain JS game state object (no database)

const Engine = {

    // ==========================================
    // 1. CORE UTILITIES & HELPERS
    // ==========================================

    clampRep(val) { return Math.max(-3, Math.min(10, val)); },
    clampPower(val) { return Math.max(0, Math.min(40, val)); },

    getPlayer(state, playerId) {
        return state.players.find(p => p.id === playerId);
    },

    getPlayerModifiers(state, playerId) {
        const mods = {
            model_worker_cost_offset: 0,
            compute_cost_offset: 0,
            hand_limit: 5,
            income_offset: 0,
            draw_bonus: 0,
            worker_income_efficiency: false,
            free_card_play: false,
            priority_p1: false,
        };
        const tiles = state.reputationTiles.filter(t => t.ownerId === playerId);
        for (const tile of tiles) {
            const code = tile.effectCode;
            if (code === "model_cost_plus_1") mods.model_worker_cost_offset += 1;
            else if (code === "model_worker_minus_1") mods.model_worker_cost_offset -= 1;
            else if (code === "compute_cost_plus_3") mods.compute_cost_offset += 3;
            else if (code === "compute_minus_1") mods.compute_cost_offset -= 1;
            else if (code === "compute_minus_2") mods.compute_cost_offset -= 2;
            else if (code === "hand_limit_3") mods.hand_limit = Math.min(mods.hand_limit, 3);
            else if (code === "hand_limit_6") mods.hand_limit = 6;
            else if (code === "income_plus_1") mods.income_offset += 1;
            else if (code === "income_plus_2") mods.income_offset += 2;
            else if (code === "one_worker_income") mods.worker_income_efficiency = true;
            else if (code === "draw_extra_card") mods.draw_bonus += 1;
            else if (code === "perma_p1") mods.priority_p1 = true;
        }
        return mods;
    },

    updatePlayerIncome(state, player) {
        const mods = this.getPlayerModifiers(state, player.id);
        const multiplier = player.netWorthLevel;
        const baseIncome = player.power + (player.subsidyTokens * multiplier);
        player.income = Math.min(39, baseIncome + mods.income_offset);
    },

    checkReputationTiles(state, playerId) {
        const player = this.getPlayer(state, playerId);
        // Level 0 (Penalty)
        const currentPenalty = state.reputationTiles.find(t => t.ownerId === playerId && t.level === 0);
        if (player.reputation === -3 && !currentPenalty) {
            const available = state.reputationTiles.find(t => t.level === 0 && t.ownerId === null);
            if (available) available.ownerId = playerId;
        } else if (player.reputation > -3 && currentPenalty) {
            currentPenalty.ownerId = null;
        }
        // Levels 1-3
        for (const level of [1, 2, 3]) {
            if (level === 2 && player.netWorthLevel < 1) continue;
            if (level === 3 && player.netWorthLevel < 2) continue;
            const minRep = {1: 1, 2: 6, 3: 10}[level];
            if (player.reputation < minRep) continue;
            const tiles = state.reputationTiles.filter(t => t.level === level);
            for (const tile of tiles) {
                if (tile.ownerId === null) { tile.ownerId = playerId; break; }
                const owner = this.getPlayer(state, tile.ownerId);
                if (owner && player.reputation > owner.reputation) { tile.ownerId = playerId; break; }
            }
        }
    },

    // ==========================================
    // 2. CARD DRAWING
    // ==========================================

    drawCard(state, playerId, deckZone) {
        const idx = state.components.findIndex(c => c.zone === deckZone);
        if (idx === -1) return {error: `No cards left in ${deckZone}`};
        const card = state.components[idx];
        card.zone = `hand_p${playerId}`;
        card.ownerId = playerId;
        card.isFaceUp = false;
        return {action: "card_drawn", componentId: card.id};
    },

    executeRoundStartDraw(state, playerId, bonusDeck) {
        const mods = this.getPlayerModifiers(state, playerId);
        const results = [
            this.drawCard(state, playerId, "research_deck"),
            this.drawCard(state, playerId, "influence_deck"),
            this.drawCard(state, playerId, "sabotage_deck"),
        ];
        if (mods.draw_bonus > 0) {
            results.push(this.drawCard(state, playerId, bonusDeck || "research_deck"));
        }
        const handCount = state.components.filter(c => c.zone === `hand_p${playerId}` && c.ownerId === playerId).length;
        if (handCount > mods.hand_limit) {
            return {status: "must_discard", count: handCount - mods.hand_limit, results};
        }
        return {status: "success", results};
    },

    discardCard(state, playerId, cardId) {
        const card = state.components.find(c => c.id === cardId);
        if (!card || card.ownerId !== playerId) return {error: "Invalid card."};
        const def = state.cardDefinitions.find(d => d.id === card.cardDetailsId);
        if (def && def.effectSlug === "intern_program") return {error: "Intern Volunteer Program cannot be discarded."};
        card.zone = `${card.subType}_discard`;
        card.ownerId = null;
        return {action: "card_discarded", cardId};
    },

    // ==========================================
    // 3. PROJECTED STATE
    // ==========================================

    getProjectedPlayerState(state, playerId, upToWorkerNumber) {
        const player = this.getPlayer(state, playerId);
        const mods = this.getPlayerModifiers(state, playerId);
        const projected = {
            compute_level: player.computeLevel,
            model_version: player.modelVersion,
            net_worth_level: player.netWorthLevel,
            corporate_funds: player.corporateFunds,
            reputation: player.reputation,
            total_workers: player.totalWorkers,
            presence_count: player.presenceCount,
            presence_regions: [...player.presenceRegions],
            subsidy_tokens: player.subsidyTokens,
            income: player.income,
        };
        const placements = state.workerPlacements
            .filter(p => p.playerId === playerId && p.workerNumber < upToWorkerNumber)
            .sort((a, b) => a.workerNumber - b.workerNumber);

        for (const p of placements) {
            if (p.actionType === "raise_funds") {
                projected.corporate_funds = 0;
                let gain = Math.min(projected.income, 8);
                if (mods.worker_income_efficiency) gain = Math.min(projected.income, 39);
                projected.corporate_funds += gain;
            } else if (p.actionType === "buy_chips") {
                const nextLvl = projected.compute_level + 1;
                if (nextLvl <= 7) {
                    const cost = Config.COMPUTE_UPGRADE_COSTS[nextLvl] || 0;
                    const finalCost = Math.max(0, cost + mods.compute_cost_offset);
                    const reqNw = Config.COMPUTE_NET_WORTH_REQ[nextLvl] || 0;
                    if (projected.corporate_funds >= finalCost && projected.net_worth_level >= reqNw) {
                        projected.corporate_funds -= finalCost;
                        projected.compute_level = nextLvl;
                    }
                }
            } else if (p.actionType === "marketing") {
                const bonus = Config.MARKETING_BONUSES[projected.net_worth_level];
                if (bonus) projected.reputation = Math.min(10, projected.reputation + bonus.reputation);
            } else if (p.actionType === "increase_net_worth") {
                const nextNw = projected.net_worth_level + 1;
                if (nextNw <= 2) {
                    const costs = Config.NET_WORTH_COSTS[nextNw];
                    if (projected.corporate_funds >= costs.money && (projected.reputation - costs.reputation) >= -3) {
                        projected.corporate_funds -= costs.money;
                        projected.reputation -= costs.reputation;
                        projected.net_worth_level = nextNw;
                    }
                }
            } else if (p.actionType === "recruit") {
                const nextNum = projected.total_workers + 1;
                if (nextNum <= 8) {
                    const tier = Config.RECRUIT_COSTS[nextNum] || Config.RECRUIT_COSTS[4];
                    if (projected.corporate_funds >= tier.money && projected.net_worth_level >= tier.min_nw) {
                        projected.corporate_funds -= tier.money;
                        projected.total_workers = nextNum;
                    }
                }
            } else if (p.actionType === "scale_presence") {
                const costIdx = projected.presence_count - 1;
                if (costIdx < Config.PRESENCE_COSTS.length) {
                    const cost = Config.PRESENCE_COSTS[costIdx];
                    if (projected.corporate_funds >= cost) {
                        projected.corporate_funds -= cost;
                        projected.presence_count += 1;
                        if (p.targetRegion) {
                            projected.presence_regions.push(p.targetRegion);
                            const rs = state.regionStates.find(r => r.regionId === p.targetRegion);
                            if (rs && rs.subsidyTokensRemaining > 0) {
                                projected.subsidy_tokens += 1;
                            }
                        }
                    }
                }
            } else if (p.actionType === "train_model") {
                if (!projected._trainAccum) projected._trainAccum = 0;
                projected._trainAccum += 1;
                const nextV = projected.model_version + 1;
                if (nextV <= 7) {
                    const baseReq = Config.MODEL_WORKER_COSTS[nextV] || 1;
                    const req = Math.max(0, baseReq + mods.model_worker_cost_offset);
                    const reqNw = Config.MODEL_NET_WORTH_REQ[nextV] || 0;
                    if (projected._trainAccum >= req && projected.compute_level >= nextV && projected.net_worth_level >= reqNw) {
                        projected.model_version = nextV;
                        projected._trainAccum = 0;
                    }
                }
            }
        }
        delete projected._trainAccum;
        projected.corporate_funds = Math.max(0, projected.corporate_funds);
        projected.reputation = this.clampRep(projected.reputation);
        return projected;
    },

    // ==========================================
    // 4. VALIDATION
    // ==========================================

    validateBuyChips(state, playerId, projectedState) {
        const nextLevel = projectedState.compute_level + 1;
        const mods = this.getPlayerModifiers(state, playerId);
        if (nextLevel > 7) return {error: "Maximum compute level already reached."};
        const baseCost = Config.COMPUTE_UPGRADE_COSTS[nextLevel];
        const finalCost = Math.max(0, baseCost + mods.compute_cost_offset);
        if (projectedState.corporate_funds < finalCost) return {error: `Insufficient funds. Need $${finalCost}.`};
        const reqNw = Config.COMPUTE_NET_WORTH_REQ[nextLevel] || 0;
        if (projectedState.net_worth_level < reqNw) return {error: "Net Worth too low."};
        return null;
    },

    validateRecruit(state, playerId, projectedState) {
        const nextNum = projectedState.total_workers + 1;
        if (nextNum > 8) return {error: "Max workers reached."};
        const tier = Config.RECRUIT_COSTS[nextNum] || Config.RECRUIT_COSTS[4];
        if (projectedState.corporate_funds < tier.money || projectedState.net_worth_level < tier.min_nw)
            return {error: "Requirements not met for recruitment."};
        return null;
    },

    validateTrainModel(state, playerId, projectedState) {
        const nextV = projectedState.model_version + 1;
        if (nextV > 7) return {error: "Maximum Model Version reached."};
        if (projectedState.compute_level < nextV) return {error: `Insufficient Compute Level. Need ${nextV}.`};
        if (projectedState.net_worth_level < (Config.MODEL_NET_WORTH_REQ[nextV] || 0)) return {error: "Net Worth too low."};
        return null;
    },

    validateIncreaseNetWorth(state, playerId, projectedState) {
        const nextNw = projectedState.net_worth_level + 1;
        if (nextNw > 2) return {error: "Already a Billionaire."};
        const costs = Config.NET_WORTH_COSTS[nextNw];
        if (projectedState.corporate_funds < costs.money) return {error: `Insufficient funds. Need $${costs.money}.`};
        if ((projectedState.reputation - costs.reputation) < -3) return {error: "Reputation too low."};
        return null;
    },

    validateScalePresence(state, playerId, projectedState, targetRegion) {
        if (projectedState.presence_count >= 10) return {error: "Maximum presence reached."};
        let costIdx = projectedState.presence_count - 1;
        if (costIdx < 0) costIdx = 0;
        if (costIdx >= Config.PRESENCE_COSTS.length) return {error: "Max Expansion Limit"};
        const cost = Config.PRESENCE_COSTS[costIdx];
        if (projectedState.corporate_funds < cost) return {error: `Insufficient funds. Need $${cost}.`};
        if (targetRegion) {
            if (projectedState.presence_regions.includes(targetRegion)) return {error: "Already have presence in this region."};
            let valid = false;
            for (const rId of projectedState.presence_regions) {
                if ((Config.WORLD_MAP[rId] || []).includes(targetRegion)) { valid = true; break; }
            }
            if (!valid) return {error: `Region ${targetRegion} is not adjacent to current presence.`};
        }
        return null;
    },

    validatePlacementCount(state, playerId, actionType, workerNumber) {
        const existing = state.workerPlacements.filter(
            p => p.playerId === playerId && p.actionType === actionType && p.workerNumber !== workerNumber
        ).length;
        if (actionType === "raise_funds" && existing + 1 > 3) {
            return {error: "Max efficiency reached with 3 workers."};
        }
        return null;
    },

    validateActionRequirements(state, playerId, actionType, workerNumber, targetRegion) {
        const projected = this.getProjectedPlayerState(state, playerId, workerNumber);
        if (actionType === "buy_chips") return this.validateBuyChips(state, playerId, projected);
        if (actionType === "recruit") return this.validateRecruit(state, playerId, projected);
        if (actionType === "train_model") return this.validateTrainModel(state, playerId, projected);
        if (actionType === "increase_net_worth") return this.validateIncreaseNetWorth(state, playerId, projected);
        if (actionType === "scale_presence") return this.validateScalePresence(state, playerId, projected, targetRegion);
        return null;
    },

    // ==========================================
    // 5. WORKER PLACEMENT
    // ==========================================

    placeWorker(state, playerId, workerNumber, actionType, targetRegion, targetCardId, targetSubAction) {
        const player = this.getPlayer(state, playerId);
        const projected = this.getProjectedPlayerState(state, playerId, workerNumber);
        if (workerNumber < 90 && workerNumber > projected.total_workers) {
            return {error: `Player only has ${player.totalWorkers} workers (projected: ${projected.total_workers}).`};
        }
        const countErr = this.validatePlacementCount(state, playerId, actionType, workerNumber);
        if (countErr) return countErr;
        const reqErr = this.validateActionRequirements(state, playerId, actionType, workerNumber, targetRegion);
        if (reqErr) return reqErr;

        const existing = state.workerPlacements.find(
            p => p.playerId === playerId && p.workerNumber === workerNumber
        );
        if (existing) {
            existing.actionType = actionType;
            existing.targetRegion = targetRegion;
            existing.targetCardId = targetCardId;
            existing.targetSubAction = targetSubAction;
        } else {
            state.workerPlacements.push({
                playerId, workerNumber, actionType, targetRegion, targetCardId, targetSubAction,
            });
        }
        return {action: "worker_placed", worker_number: workerNumber, slot: actionType};
    },

    undoLastPlacement(state, playerId) {
        const playerPlacements = state.workerPlacements
            .filter(p => p.playerId === playerId)
            .sort((a, b) => b.workerNumber - a.workerNumber);
        if (playerPlacements.length === 0) return {error: "No workers placed to undo."};
        const last = playerPlacements[0];
        state.workerPlacements = state.workerPlacements.filter(p => p !== last);
        return {action: "worker_removed", worker_number: last.workerNumber, from_action: last.actionType};
    },

    // ==========================================
    // 6. ACTION EXECUTION
    // ==========================================

    executeBuyChips(state, playerId) {
        const player = this.getPlayer(state, playerId);
        const mods = this.getPlayerModifiers(state, playerId);
        const currentState = {compute_level: player.computeLevel, corporate_funds: player.corporateFunds, net_worth_level: player.netWorthLevel};
        const err = this.validateBuyChips(state, playerId, currentState);
        if (err) return err;
        const nextLevel = player.computeLevel + 1;
        const baseCost = Config.COMPUTE_UPGRADE_COSTS[nextLevel];
        const finalCost = Math.max(0, baseCost + mods.compute_cost_offset - player.tempComputeMonetaryDiscount) + player.tempActionCostIncrease;
        if (player.corporateFunds < finalCost) return {error: `Insufficient funds. Need $${finalCost}.`};
        player.corporateFunds -= finalCost;
        player.computeLevel = nextLevel;
        if (player.tempComputeGainPowerBonus > 0) {
            player.power = this.clampPower(player.power + player.tempComputeGainPowerBonus);
        }
        return {action: "compute_upgraded", new_level: player.computeLevel};
    },

    executeTrainModel(state, playerId, workerCount) {
        const player = this.getPlayer(state, playerId);
        const mods = this.getPlayerModifiers(state, playerId);
        const nextV = player.modelVersion + 1;
        if (nextV > 7) return {error: "Maximum Model Version reached."};
        const baseReq = Config.MODEL_WORKER_COSTS[nextV] || 1;
        const finalReq = Math.max(0, baseReq + mods.model_worker_cost_offset - player.tempModelCostWorkerReduction);
        if (workerCount < finalReq) return {error: `Insufficient Tech Workers. Need ${finalReq}.`};
        if (player.computeLevel < nextV) return {error: `Insufficient Compute Level. Need ${nextV}.`};
        if (player.netWorthLevel < (Config.MODEL_NET_WORTH_REQ[nextV] || 0)) return {error: "Net Worth too low."};

        player.modelVersion = nextV;
        player.reputation = this.clampRep(player.reputation + 1);
        if (player.tempTrainModelPerRegionPowerBonus) {
            player.power = this.clampPower(player.power + player.presenceCount);
            player.tempTrainModelPerRegionPowerBonus = false;
        } else {
            player.power = this.clampPower(player.power + Math.floor(player.presenceCount / 2));
        }
        this.updatePlayerIncome(state, player);
        this.checkReputationTiles(state, playerId);

        // Passive triggers for other players
        const trainingRegions = new Set(player.presenceRegions);
        for (const other of state.players.filter(p => p.id !== playerId)) {
            const otherRegions = new Set(other.presenceRegions);
            const shared = [...trainingRegions].filter(r => otherRegions.has(r));
            if (shared.length === 0) continue;

            // Corporate Espionage
            const espionageCards = state.components.filter(c =>
                c.zone.startsWith(`active_effect_card_slot_`) && c.zone.endsWith(`_p${other.id}`)
            );
            for (const ec of espionageCards) {
                const def = state.cardDefinitions.find(d => d.id === ec.cardDetailsId);
                if (def && def.effectSlug === "corporate_espionage" && other.modelVersion >= 3) {
                    const bonus = other.netWorthLevel >= 2 ? 2 : 1;
                    other.power = this.clampPower(other.power + bonus);
                    this.updatePlayerIncome(state, other);
                }
            }
            // Piggyback
            if (other.tempPiggybackCompetitorModel) {
                const nextCompute = other.computeLevel + 1;
                if (nextCompute <= 7) {
                    const computeCost = Config.COMPUTE_UPGRADE_COSTS[nextCompute] || 999;
                    const otherMods = this.getPlayerModifiers(state, other.id);
                    const cost = Math.max(0, computeCost + otherMods.compute_cost_offset);
                    const nwReq = Config.COMPUTE_NET_WORTH_REQ[nextCompute] || 0;
                    if (other.corporateFunds >= cost && other.netWorthLevel >= nwReq) {
                        other.corporateFunds -= cost;
                        other.computeLevel = nextCompute;
                    }
                }
            }
        }
        return {action: "model_trained", new_version: player.modelVersion, new_power: player.power, new_income: player.income};
    },

    executeMarketing(state, playerId) {
        const player = this.getPlayer(state, playerId);
        const bonus = Config.MARKETING_BONUSES[player.netWorthLevel];
        player.reputation = this.clampRep(player.reputation + bonus.reputation);
        player.power = this.clampPower(player.power + bonus.power);
        this.updatePlayerIncome(state, player);
        this.checkReputationTiles(state, playerId);
        return {action: "marketing_resolved", new_reputation: player.reputation};
    },

    executeScalePresence(state, playerId, targetRegion) {
        const player = this.getPlayer(state, playerId);
        if (player.presenceRegions.includes(targetRegion)) return {error: "Already present in this region."};
        let costIdx = player.presenceCount - 1;
        if (costIdx < 0) costIdx = 0;
        const cost = costIdx < Config.PRESENCE_COSTS.length ? Config.PRESENCE_COSTS[costIdx] : Config.PRESENCE_COSTS[Config.PRESENCE_COSTS.length - 1];
        const finalCost = Math.max(0, cost - player.tempPresenceMonetaryDiscount) + player.tempActionCostIncrease;
        if (player.corporateFunds < finalCost) return {error: `Insufficient funds. Need $${finalCost}.`};
        const adjacent = player.presenceRegions.some(r => (Config.WORLD_MAP[r] || []).includes(targetRegion));
        if (!adjacent) return {error: "Region not adjacent."};
        player.corporateFunds -= finalCost;
        player.presenceRegions.push(targetRegion);
        player.presenceCount += 1;
        const rs = state.regionStates.find(r => r.regionId === targetRegion);
        if (rs && rs.subsidyTokensRemaining > 0) {
            rs.subsidyTokensRemaining -= 1;
            player.subsidyTokens += 1;
            this.updatePlayerIncome(state, player);
        }
        return {action: "presence_scaled", new_region: targetRegion};
    },

    executeIncreaseNetWorth(state, playerId) {
        const player = this.getPlayer(state, playerId);
        const nextNw = player.netWorthLevel + 1;
        if (nextNw > 2) return {error: "Already a Billionaire."};
        const costs = Config.NET_WORTH_COSTS[nextNw];
        const totalMoneyCost = costs.money + player.tempActionCostIncrease;
        if (player.corporateFunds < totalMoneyCost) return {error: `Insufficient funds. Need $${totalMoneyCost}.`};
        if ((player.reputation - costs.reputation) < -3) return {error: "Reputation too low."};
        player.corporateFunds -= totalMoneyCost;
        player.reputation = this.clampRep(player.reputation - costs.reputation);
        player.netWorthLevel = nextNw;
        // VP bonuses
        const playerCount = state.players.length;
        let vpReward = 0;
        if (nextNw === 1) {
            state.game.millionaireCount += 1;
            vpReward = this.calculateNwVp(state.game.millionaireCount, playerCount);
        } else if (nextNw === 2) {
            state.game.billionaireCount += 1;
            vpReward = this.calculateNwVp(state.game.billionaireCount, playerCount);
        }
        player.vp += vpReward;
        this.updatePlayerIncome(state, player);
        this.checkReputationTiles(state, playerId);
        return {action: "net_worth_increased", new_level: player.netWorthLevel, vp_gained: vpReward, total_vp: player.vp};
    },

    executeRecruitWorker(state, playerId, targetAction, targetRegion, targetCardId) {
        const player = this.getPlayer(state, playerId);
        const nextNum = player.totalWorkers + 1;
        if (nextNum > 8) return {error: "Max workers reached."};
        const tier = Config.RECRUIT_COSTS[nextNum] || Config.RECRUIT_COSTS[4];
        const recruitCost = tier.money + player.tempRecruitCostIncrease + player.tempActionCostIncrease;
        if (player.netWorthLevel < tier.min_nw) return {error: "Net Worth too low."};
        if (player.corporateFunds < recruitCost) return {error: `Insufficient funds. Need $${recruitCost}.`};
        player.corporateFunds -= recruitCost;
        player.tempRecruitCostIncrease = 0;
        player.totalWorkers = nextNum;
        state.workerPlacements.push({
            playerId, workerNumber: nextNum, actionType: targetAction,
            targetRegion: targetRegion || null, targetCardId: targetCardId || null, targetSubAction: null,
        });
        return {action: "worker_recruited", new_total: player.totalWorkers, placed_at: targetAction};
    },

    executeRaiseFundsSequence(state, playerId, chunks) {
        const player = this.getPlayer(state, playerId);
        const mods = this.getPlayerModifiers(state, playerId);
        const totalSiphoned = player.corporateFunds;
        player.personalFunds += totalSiphoned;
        player.corporateFunds = 0;
        let totalDrawn = 0;
        const summary = [];
        for (const workerCount of chunks) {
            if (workerCount < 1) continue;
            let cap;
            if (mods.worker_income_efficiency) { cap = 39; }
            else if (workerCount === 1) { cap = 8; }
            else if (workerCount === 2) { cap = 19; }
            else { cap = 39; }
            const drawn = Math.min(player.income, cap);
            totalDrawn += drawn;
            summary.push({workers: workerCount, drawn});
        }
        player.corporateFunds = totalDrawn;
        return {action: "raise_funds_resolved", total_siphoned: totalSiphoned, total_drawn: totalDrawn, sequence: summary};
    },

    calculateNwVp(rank, playerCount) {
        if (playerCount === 2) return rank === 1 ? 1 : 0;
        if (playerCount === 3) return rank === 1 ? 2 : rank === 2 ? 1 : 0;
        if (playerCount >= 4) return rank === 1 ? 2 : (rank === 2 || rank === 3) ? 1 : 0;
        return 0;
    },

    // ==========================================
    // 7. CARD PLAY
    // ==========================================

    playCard(state, playerId, cardId, targetSlot, payload) {
        const card = state.components.find(c => c.id === cardId);
        if (!card || card.ownerId !== playerId) return {error: "Not owner."};
        const player = this.getPlayer(state, playerId);
        const def = state.cardDefinitions.find(d => d.id === card.cardDetailsId);
        if (!def) return {error: "Card definition not found."};

        if (player.ransomwareLocked >= 2) return {error: "Ransomware Lock: You cannot play cards this round."};

        const playCardWorkers = state.workerPlacements.filter(p => p.playerId === playerId && p.actionType === "play_card").length;
        const cost = Math.max(0, def.cost - player.tempCardCostWorkerReduction + player.tempCardCostWorkerIncrease);
        if (cost > 0 && player.workersSpentOnCards + cost > playCardWorkers) {
            return {error: `Insufficient 'Play Card' workers. Need ${cost}.`};
        }
        player.workersSpentOnCards += cost;

        if (def.isEffect) {
            if (!targetSlot || targetSlot < 1 || targetSlot > 3) return {error: "Invalid slot for Effect Card."};
            const targetZone = `active_effect_card_slot_${targetSlot}_p${playerId}`;
            const existing = state.components.find(c => c.zone === targetZone);
            if (existing) { existing.zone = `${existing.subType}_discard`; existing.ownerId = null; }
            card.zone = targetZone;
            const effectRes = this.applyCardEffect(state, playerId, cardId, payload);
            if (effectRes && effectRes.error) return effectRes;
        } else {
            const effectRes = this.applyCardEffect(state, playerId, cardId, payload);
            if (effectRes && effectRes.error) return effectRes;
            card.zone = `${card.subType}_discard`;
            card.ownerId = null;
            if (effectRes && effectRes.requires_choice) {
                return {action: "card_played", new_zone: card.zone, message: effectRes.message, effect_result: effectRes};
            }
        }
        return {action: "card_played", new_zone: card.zone, message: "Card played."};
    },

    applyCardEffect(state, playerId, cardId, payload) {
        const card = state.components.find(c => c.id === cardId);
        if (!card) return {error: "Card not found."};
        const def = state.cardDefinitions.find(d => d.id === card.cardDetailsId);
        if (!def || !def.effectSlug) return {success: true, message: "No effect."};
        const fn = CardEffects[def.effectSlug];
        if (fn) return fn(state, playerId, cardId, payload);
        return {success: true, message: `(WIP) No logic for: ${def.effectSlug}`};
    },

    // ==========================================
    // 8. ROUND RESOLUTION
    // ==========================================

    getSortedPlayers(state) {
        const players = [...state.players];
        const priority = players.find(p => this.getPlayerModifiers(state, p.id).priority_p1);
        const effectiveStart = priority ? priority.playerOrder : state.game.p1TokenIndex;
        const byOrder = players.sort((a, b) => a.playerOrder - b.playerOrder);
        const result = [];
        for (let i = 0; i < byOrder.length; i++) {
            result.push(byOrder[(effectiveStart + i) % byOrder.length]);
        }
        return result;
    },

    executeAction(state, playerId, actionType, workerCount, kwargs) {
        if (actionType === "raise_funds") return this.executeRaiseFundsSequence(state, playerId, [workerCount]);
        if (actionType === "train_model") return this.executeTrainModel(state, playerId, workerCount);
        if (actionType === "buy_chips") return this.executeBuyChips(state, playerId);
        if (actionType === "marketing") return this.executeMarketing(state, playerId);
        if (actionType === "recruit") {
            const target = (kwargs && kwargs.targetSubAction) || "marketing";
            return this.executeRecruitWorker(state, playerId, target, kwargs && kwargs.targetRegion, kwargs && kwargs.targetCardId);
        }
        if (actionType === "increase_net_worth") return this.executeIncreaseNetWorth(state, playerId);
        if (actionType === "scale_presence") return this.executeScalePresence(state, playerId, kwargs && kwargs.targetRegion);
        if (actionType === "play_card") {
            let cardPayload = null;
            const subAction = kwargs && kwargs.targetSubAction;
            if (subAction) {
                if (subAction.startsWith("region:")) cardPayload = {region_id: parseInt(subAction.split(":")[1])};
                else { try { cardPayload = {target_player_id: parseInt(subAction)}; } catch(e) {} }
            }
            let targetSlot = (kwargs && kwargs.targetSlot) || 1;
            const cardId = kwargs && kwargs.targetCardId;
            if (cardId) {
                const cardComp = state.components.find(c => c.id === cardId);
                const cardDef = cardComp && state.cardDefinitions.find(d => d.id === cardComp.cardDetailsId);
                if (cardDef && cardDef.isEffect) {
                    for (let s = 1; s <= 3; s++) {
                        if (!state.components.find(c => c.zone === `active_effect_card_slot_${s}_p${playerId}`)) {
                            targetSlot = s; break;
                        }
                    }
                }
            }
            return this.playCard(state, playerId, cardId, targetSlot, cardPayload);
        }
        return {error: "Action unrecognized"};
    },

    _snapshotPlayerStats(player) {
        return {
            corporate_funds: player.corporateFunds, personal_funds: player.personalFunds,
            power: player.power, reputation: player.reputation,
            compute_level: player.computeLevel, model_version: player.modelVersion,
            total_workers: player.totalWorkers, income: player.income,
            subsidy_tokens: player.subsidyTokens, net_worth_level: player.netWorthLevel,
            presence_count: player.presenceCount, vp: player.vp,
        };
    },

    _computeStatChanges(before, after, playerId) {
        const changes = [];
        for (const key of Object.keys(before)) {
            if (before[key] !== after[key]) {
                changes.push({stat: key, player_id: playerId, from: before[key], to: after[key], delta: after[key] - before[key]});
            }
        }
        return changes;
    },

    _buildResultMessage(actionType, result, playerName, cardName) {
        if (actionType === "raise_funds") return `Siphoned $${result.total_siphoned || 0} to personal, drew $${result.total_drawn || 0} income`;
        if (actionType === "buy_chips") return `Upgraded Compute to Level ${result.new_level || '?'}`;
        if (actionType === "train_model") return `Trained Model to v${result.new_version || '?'}`;
        if (actionType === "marketing") return "Marketing campaign resolved";
        if (actionType === "scale_presence") return `Expanded presence to Region ${result.new_region || '?'}`;
        if (actionType === "increase_net_worth") {
            const label = result.new_level === 1 ? "Millionaire" : "Billionaire";
            let msg = `Became ${label}`;
            if (result.vp_gained > 0) msg += ` (+${result.vp_gained} VP)`;
            return msg;
        }
        if (actionType === "recruit") return `Recruited worker #${result.new_total || '?'}`;
        if (actionType === "play_card") return cardName ? (result.message || `Played ${cardName}`) : (result.message || "Card played");
        return result.message || `${actionType} resolved`;
    },

    resolveEntireRound(state) {
        const actionLog = [];
        const playerLookup = {};
        for (const p of state.players) playerLookup[p.id] = p;

        for (const player of this.getSortedPlayers(state)) {
            const resolved = new Set();
            const allPlacements = state.workerPlacements
                .filter(p => p.playerId === player.id)
                .sort((a, b) => a.workerNumber - b.workerNumber);
            const raiseFundsWorkers = allPlacements.filter(w => w.actionType === "raise_funds");
            const trainModelWorkers = allPlacements.filter(w => w.actionType === "train_model");

            while (true) {
                const p = allPlacements.find(wp => !resolved.has(wp.workerNumber));
                if (!p) break;

                let groupWorkers, workerCount;
                if (p.actionType === "raise_funds" && raiseFundsWorkers.length) {
                    groupWorkers = raiseFundsWorkers; workerCount = raiseFundsWorkers.length;
                } else if (p.actionType === "train_model" && trainModelWorkers.length) {
                    groupWorkers = trainModelWorkers; workerCount = trainModelWorkers.length;
                } else {
                    groupWorkers = [p]; workerCount = 1;
                }

                const beforeSnapshots = {};
                for (const [pid, pl] of Object.entries(playerLookup)) beforeSnapshots[pid] = this._snapshotPlayerStats(pl);

                let cardName = null, cardImage = null, cardIsEffect = false, targets = [];
                if (p.actionType === "play_card" && p.targetCardId) {
                    const cardComp = state.components.find(c => c.id === p.targetCardId);
                    const cardDef = cardComp && state.cardDefinitions.find(d => d.id === cardComp.cardDetailsId);
                    if (cardDef) {
                        cardName = cardDef.name;
                        cardImage = cardDef.image;
                        cardIsEffect = cardDef.isEffect;
                        if (p.targetSubAction) {
                            if (p.targetSubAction.startsWith("region:")) {
                                targets.push({type: "region", region_id: parseInt(p.targetSubAction.split(":")[1]), effect: cardDef.description || ""});
                            } else {
                                try {
                                    const targetPid = parseInt(p.targetSubAction);
                                    const targetPlayer = playerLookup[targetPid];
                                    if (targetPlayer) targets.push({player_id: targetPid, player_name: targetPlayer.userName, effect: cardDef.description || ""});
                                } catch(e) {}
                            }
                        }
                    }
                }

                const result = this.executeAction(state, player.id, p.actionType, workerCount, {
                    targetRegion: p.targetRegion, targetCardId: p.targetCardId, targetSubAction: p.targetSubAction,
                });

                const allStatChanges = [];
                for (const [pid, pl] of Object.entries(playerLookup)) {
                    const afterSnap = this._snapshotPlayerStats(pl);
                    allStatChanges.push(...this._computeStatChanges(beforeSnapshots[pid], afterSnap, parseInt(pid)));
                }

                actionLog.push({
                    player_name: player.userName, player_id: player.id,
                    action_type: p.actionType, worker_number: p.workerNumber,
                    result_message: this._buildResultMessage(p.actionType, result, player.userName, cardName),
                    stat_changes: allStatChanges,
                    card_name: cardName, card_image: cardImage, card_is_effect: cardIsEffect, targets,
                });
                for (const w of groupWorkers) resolved.add(w.workerNumber);
            }
        }
        const leaderboard = this.calculateGameLeaderboard(state);
        return {action: "round_resolved", leaderboard, resolution_log: actionLog};
    },

    // ==========================================
    // 9. ROUND CLEANUP (finish-round)
    // ==========================================

    finishRound(state) {
        if (state.game.gamePhase === "finished") {
            return {status: "game_over", leaderboard: this.calculateGameLeaderboard(state)};
        }

        // P1 rotation
        const p1Stealer = state.players.find(p => p.tempP1Steal);
        if (p1Stealer) {
            state.game.p1TokenIndex = p1Stealer.playerOrder;
            p1Stealer.tempP1Steal = false;
        } else {
            state.game.p1TokenIndex = (state.game.p1TokenIndex + 1) % state.players.length;
        }

        // Process debuff cards
        for (const player of state.players) {
            const debuffs = state.components.filter(c => c.zone === `debuff_p${player.id}`);
            for (const card of debuffs) {
                const def = state.cardDefinitions.find(d => d.id === card.cardDetailsId);
                const slug = def ? def.effectSlug : null;
                if (slug === "content_moderation") player.tempCardCostWorkerIncrease += 1;
                else if (slug === "ransomware") { player.tempWorkerLockCount += 1; player.ransomwareLocked = 2; }
                else if (slug === "supply_chain_meltdown") player.tempActionCostIncrease += 3;
                else if (slug === "poach_engineers") player.totalWorkers = Math.max(1, player.totalWorkers - 1);
                card.zone = `${card.subType}_discard`;
                card.ownerId = null;
            }
        }

        // Clear placements
        state.workerPlacements = [];

        // Clear effect slots (except permanent)
        const permanentSlugs = new Set(["corporate_espionage", "intern_program"]);
        for (const player of state.players) {
            for (let slot = 1; slot <= 3; slot++) {
                const slotCards = state.components.filter(c => c.zone === `active_effect_card_slot_${slot}_p${player.id}`);
                for (const card of slotCards) {
                    const def = state.cardDefinitions.find(d => d.id === card.cardDetailsId);
                    if (def && !permanentSlugs.has(def.effectSlug)) {
                        card.zone = `${card.subType}_discard`;
                        card.ownerId = null;
                    }
                }
            }
        }

        // Reset per-round trackers
        for (const player of state.players) {
            player.workersSpentOnCards = 0;
            player.tempModelCostWorkerReduction = 0;
            player.tempCardCostWorkerReduction = 0;
            player.tempComputeMonetaryDiscount = 0;
            player.tempComputeGainPowerBonus = 0;
            player.tempTrainModelPerRegionPowerBonus = false;
            player.tempPiggybackCompetitorModel = false;
            player.tempPresenceMonetaryDiscount = 0;
            player.tempRecruitCostIncrease = 0;
            player.tempHandLimitIgnore = false;
            player.tempP1Steal = false;
            player.tempCardCostWorkerIncrease = 0;
            player.tempActionCostIncrease = 0;
            player.tempWorkerLockCount = 0;
            player.ransomwareLocked = 0;
        }
        state.game.pendingInteractions = [];

        // Advance round
        state.game.currentRound += 1;
        const leaderboard = this.calculateGameLeaderboard(state);
        if (state.game.currentRound > state.game.maxRounds) {
            state.game.gamePhase = "finished";
            return {status: "game_over", final_round: state.game.currentRound - 1, leaderboard};
        }

        // Draw cards for next round
        state.game.gamePhase = "playing";
        for (const player of state.players) {
            this.executeRoundStartDraw(state, player.id);
        }
        return {status: "round_finished", current_round: state.game.currentRound, max_rounds: state.game.maxRounds, new_p1_index: state.game.p1TokenIndex, leaderboard};
    },

    // ==========================================
    // 10. LEADERBOARD
    // ==========================================

    calculateGameLeaderboard(state) {
        const players = state.players;
        const playerCount = players.length;
        const sortedByFunds = [...players].sort((a, b) => b.personalFunds - a.personalFunds);
        const fundBonuses = {};
        if (playerCount === 2) { fundBonuses[sortedByFunds[0].id] = 3; }
        else if (playerCount === 3) { fundBonuses[sortedByFunds[0].id] = 3; fundBonuses[sortedByFunds[1].id] = 1; }
        else if (playerCount >= 4) { fundBonuses[sortedByFunds[0].id] = 3; fundBonuses[sortedByFunds[1].id] = 2; fundBonuses[sortedByFunds[2].id] = 1; }

        const leaderboard = players.map(p => {
            let totalVp = p.vp;
            totalVp += Math.floor(p.power / 5);
            totalVp += p.modelVersion;
            totalVp += p.presenceCount;
            totalVp += fundBonuses[p.id] || 0;
            return {
                player_id: p.id, user_name: p.userName, total_vp: totalVp,
                breakdown: {race_bonuses: p.vp, power_vp: Math.floor(p.power / 5), model_vp: p.modelVersion, presence_vp: p.presenceCount, funds_bonus: fundBonuses[p.id] || 0},
            };
        });
        return leaderboard.sort((a, b) => b.total_vp - a.total_vp);
    },
};
