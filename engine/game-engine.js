// Disruptopia P2P - Game Engine
// Ported from backend/game_engine.py
// Operates on a plain JS game state object (no database)

const Engine = {

    // ==========================================
    // 1. CORE UTILITIES & HELPERS
    // ==========================================

    clampRep(val) { return Math.max(-3, Math.min(10, val)); },
    clampPower(val) { return Math.max(1, Math.min(30, val)); },  // rulebook p.14

    // ── State hash for desync detection ─────────────────────────────
    // Deterministic FNV-1a hash over a canonical (key-sorted) projection
    // of the game state. Skips ephemeral fields (animation queues, MP
    // metadata) that legitimately differ between peers.
    hashState(state) {
        const canonical = this._canonicalize({
            game: {
                currentRound: state.game.currentRound,
                gamePhase: state.game.gamePhase,
                p1TokenIndex: state.game.p1TokenIndex,
                millionaireCount: state.game.millionaireCount,
                billionaireCount: state.game.billionaireCount,
            },
            players: state.players.map(p => ({
                id: p.id, userName: p.userName, playerOrder: p.playerOrder,
                corporateFunds: p.corporateFunds, personalFunds: p.personalFunds,
                power: p.power, reputation: p.reputation,
                computeLevel: p.computeLevel, modelVersion: p.modelVersion,
                netWorthLevel: p.netWorthLevel, presenceCount: p.presenceCount,
                presenceRegions: [...p.presenceRegions].sort((a, b) => a - b),
                subsidyTokens: p.subsidyTokens, totalWorkers: p.totalWorkers,
                income: p.income, vp: p.vp,
                workerBoardSlots: [...(p.workerBoardSlots || [])].sort((a, b) => a - b),
                presenceBoardSlots: [...(p.presenceBoardSlots || [])].sort((a, b) => a - b),
            })),
            regionStates: [...state.regionStates].sort((a, b) => a.regionId - b.regionId),
            reputationTiles: state.reputationTiles.map(t => ({
                id: t.id, level: t.level, effectCode: t.effectCode, ownerId: t.ownerId,
            })).sort((a, b) => a.id - b.id),
            // Card components — only zone + owner matters for sync (id is the key).
            components: state.components.map(c => ({
                id: c.id, zone: c.zone, ownerId: c.ownerId,
            })).sort((a, b) => a.id - b.id),
        });
        return this._fnv1a(JSON.stringify(canonical));
    },

    _canonicalize(v) {
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(x => this._canonicalize(x));
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = this._canonicalize(v[k]);
        return out;
    },

    _fnv1a(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    },

    getPlayer(state, playerId) {
        return state.players.find(p => p.id === playerId);
    },

    // ── BOARD-SLOT HELPERS (rulebook p.14) ─────────────────────────
    // Workers occupy slots 4-8 on the Net Worth Tracking Board; presence
    // occupies slots 2-10. Recruiting takes the lowest-numbered token
    // currently on the board (sequential); losing returns a token to the
    // most expensive empty board slot. After multiple lose/refill cycles
    // these two rules together produce non-sequential cost charges that
    // the naive "next slot = count + 1" formula gets wrong.

    _ensureSlotState(player) {
        // Legacy save / older saves may not have these fields. Fill in
        // consistently with the player's current count (assume nothing has
        // been lost — best we can do without history).
        if (!player.workerBoardSlots) {
            const filled = Math.min(8, Math.max(3, player.totalWorkers || 3));
            player.workerBoardSlots = [];
            for (let s = filled + 1; s <= 8; s++) player.workerBoardSlots.push(s);
        }
        if (!player.presenceBoardSlots) {
            const filled = Math.min(10, Math.max(1, player.presenceCount || 1));
            player.presenceBoardSlots = [];
            for (let s = filled + 1; s <= 10; s++) player.presenceBoardSlots.push(s);
        }
    },

    nextWorkerSlot(player) {
        this._ensureSlotState(player);
        if (player.workerBoardSlots.length === 0) return null;
        return Math.min(...player.workerBoardSlots);
    },

    nextWorkerCost(player) {
        const slot = this.nextWorkerSlot(player);
        if (slot == null) return null;
        const tier = Config.RECRUIT_COSTS[slot] || Config.RECRUIT_COSTS[4];
        return tier ? tier.money : 0;
    },

    nextWorkerTier(player) {
        const slot = this.nextWorkerSlot(player);
        if (slot == null) return null;
        return Config.RECRUIT_COSTS[slot] || Config.RECRUIT_COSTS[4];
    },

    // Mutates: removes lowest-numbered token from the board and bumps
    // totalWorkers. Returns {slot, cost} on success or null if no room.
    recruitWorkerFromBoard(player) {
        const slot = this.nextWorkerSlot(player);
        if (slot == null) return null;
        player.workerBoardSlots = player.workerBoardSlots.filter(s => s !== slot);
        player.totalWorkers += 1;
        const tier = Config.RECRUIT_COSTS[slot] || Config.RECRUIT_COSTS[4];
        return {slot, cost: tier ? tier.money : 0};
    },

    // Mutates: returns the player's highest-numbered owned worker token to
    // the most expensive empty board slot. Respects rulebook p.14 min 3.
    // Returns the slot that was filled, or null if no loss occurred.
    returnWorkerToBoard(player) {
        this._ensureSlotState(player);
        if (player.totalWorkers <= 3) return null;
        const onBoard = new Set(player.workerBoardSlots);
        for (let s = 8; s >= 4; s--) {
            if (!onBoard.has(s)) {
                player.workerBoardSlots.push(s);
                player.totalWorkers -= 1;
                return s;
            }
        }
        return null;
    },

    nextPresenceSlot(player) {
        this._ensureSlotState(player);
        if (player.presenceBoardSlots.length === 0) return null;
        return Math.min(...player.presenceBoardSlots);
    },

    nextPresenceCost(player) {
        const slot = this.nextPresenceSlot(player);
        if (slot == null) return null;
        return Config.PRESENCE_COSTS[slot - 2];
    },

    // Mutates: removes lowest-numbered token from the board and adds the
    // region to the player's presenceRegions. Returns {slot, cost} or null.
    scalePresenceFromBoard(player, regionId) {
        const slot = this.nextPresenceSlot(player);
        if (slot == null) return null;
        player.presenceBoardSlots = player.presenceBoardSlots.filter(s => s !== slot);
        player.presenceCount += 1;
        if (regionId != null && !player.presenceRegions.includes(regionId)) {
            player.presenceRegions.push(regionId);
        }
        return {slot, cost: Config.PRESENCE_COSTS[slot - 2]};
    },

    // Mutates: returns a presence token to the most expensive empty board
    // slot. If regionId given, also removes it from the player's
    // presenceRegions. Returns the slot that was filled, or null.
    returnPresenceToBoard(player, regionId) {
        this._ensureSlotState(player);
        if (player.presenceCount <= 0) return null;
        const onBoard = new Set(player.presenceBoardSlots);
        for (let s = 10; s >= 2; s--) {
            if (!onBoard.has(s)) {
                player.presenceBoardSlots.push(s);
                player.presenceCount -= 1;
                if (regionId != null) {
                    const idx = player.presenceRegions.indexOf(regionId);
                    if (idx >= 0) player.presenceRegions.splice(idx, 1);
                }
                return s;
            }
        }
        return null;
    },

    getPlayerModifiers(state, playerId) {
        const mods = {
            model_worker_cost_offset: 0,
            compute_cost_offset: 0,
            hand_limit: 5,
            income_offset: 0,
            draw_bonus: 0,
            worker_income_efficiency: false,
            card_cost_worker_reduction: 0,   // Streamlined Ops
            free_hand_card: false,            // Venture Mogul
            free_active_effect: false,        // Infinite Loop
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
            else if (code === "play_card_worker_minus_1") mods.card_cost_worker_reduction += 1;
            else if (code === "free_hand_card") mods.free_hand_card = true;
            else if (code === "free_active_effect") mods.free_active_effect = true;
        }
        return mods;
    },

    updatePlayerIncome(state, player) {
        const mods = this.getPlayerModifiers(state, player.id);
        const multiplier = player.netWorthLevel;
        const baseIncome = player.power + (player.subsidyTokens * multiplier);
        player.income = Math.min(39, baseIncome + mods.income_offset);
    },

    // ── Active-effect lookup ────────────────────────────────────────
    _playerHasActiveEffect(state, playerId, slug) {
        return state.components.some(c => {
            if (c.ownerId !== playerId) return false;
            if (!c.zone || !c.zone.startsWith("active_effect_card_slot_")) return false;
            if (!c.zone.endsWith(`_p${playerId}`)) return false;
            const def = state.cardDefinitions.find(d => d.id === c.cardDetailsId);
            return def && def.effectSlug === slug;
        });
    },

    // ── Centralized power gain (fires Consulting Fees on shared-presence
    // opponents who hold the card; opts.suppressTriggers skips them). ─
    gainPower(state, player, amount, opts) {
        if (!amount) return 0;
        const before = player.power;
        player.power = this.clampPower(player.power + amount);
        const actual = player.power - before;
        this.updatePlayerIncome(state, player);
        if (actual > 0 && !(opts && opts.suppressTriggers)) {
            this._triggerConsultingFees(state, player, actual);
        }
        return actual;
    },

    losePower(state, player, amount) {
        if (!amount) return 0;
        const before = player.power;
        player.power = this.clampPower(player.power - amount);
        this.updatePlayerIncome(state, player);
        return before - player.power;
    },

    _triggerConsultingFees(state, gainer, powerGained) {
        const gainerRegions = new Set(gainer.presenceRegions);
        for (const opp of state.players) {
            if (opp.id === gainer.id) continue;
            if (!opp.presenceRegions.some(r => gainerRegions.has(r))) continue;
            if (!this._playerHasActiveEffect(state, opp.id, "consulting_fees")) continue;
            const charge = Math.min(powerGained, gainer.corporateFunds);
            if (charge <= 0) continue;
            gainer.corporateFunds -= charge;
            opp.corporateFunds += charge;
        }
    },

    // ── Centralized compute gain (fires Big Compute Energy on the
    // increaser and GPU Price Hike on shared-presence opponents). ─────
    gainCompute(state, player, amount, opts) {
        if (!amount) return 0;
        const before = player.computeLevel;
        player.computeLevel = Math.min(7, player.computeLevel + amount);
        const actual = player.computeLevel - before;
        if (actual > 0 && !(opts && opts.suppressTriggers)) {
            if (player.tempComputeGainPowerBonus > 0) {
                this.gainPower(state, player, player.tempComputeGainPowerBonus * actual);
            }
            this._triggerGpuPriceHike(state, player, actual);
        }
        return actual;
    },

    // Pick an active-effect slot for player. Prefers empty slots, then
    // any non-intern occupied slot. Returns the slot number (1-3) or null
    // if all 3 slots hold intern_program.
    findOpenEffectSlot(state, playerId) {
        for (let s = 1; s <= 3; s++) {
            if (!state.components.find(c => c.zone === `active_effect_card_slot_${s}_p${playerId}`)) return s;
        }
        for (let s = 1; s <= 3; s++) {
            const occ = state.components.find(c => c.zone === `active_effect_card_slot_${s}_p${playerId}`);
            if (!occ) continue;
            const def = state.cardDefinitions.find(d => d.id === occ.cardDetailsId);
            if (def && def.effectSlug === "intern_program") continue;
            return s;
        }
        return null;
    },

    _triggerGpuPriceHike(state, increaser, computeIncreased) {
        const regions = new Set(increaser.presenceRegions);
        for (const opp of state.players) {
            if (opp.id === increaser.id) continue;
            if (!opp.presenceRegions.some(r => regions.has(r))) continue;
            if (!this._playerHasActiveEffect(state, opp.id, "gpu_price_hike")) continue;
            const charge = Math.min(computeIncreased, increaser.corporateFunds);
            if (charge <= 0) continue;
            increaser.corporateFunds -= charge;
            opp.corporateFunds += charge;
        }
    },

    checkReputationTiles(state, playerId) {
        // Whichever player's stats changed, rebalance the WHOLE table — the
        // rulebook (p.13) is symmetric: highest-rep player(s) hold the tiles,
        // and a drop forces a transfer to anyone who now exceeds them.
        this.rebalanceReputationTiles(state);
    },

    rebalanceReputationTiles(state) {
        const players = state.players;
        // How many tiles per level exist: 1 in 2-3p, 2 in 4-5p (rulebook p.13).
        const tilesPerLevel = players.length <= 3 ? 1 : 2;
        // Net Worth required to *hold* a tile.
        const nwReq = {1: 0, 2: 1, 3: 2};
        // Rep needed to claim a tile FRESH (i.e. when none are in circulation
        // yet). Once any tile is in circulation, ownership tracks by relative
        // rep only — see "sticky" rule for tiles 2 & 3 below.
        const initialRepThresh = {1: 1, 2: 6, 3: 10};

        // ── Level 0 (penalty): rulebook p.13 — must be claimed if your
        // reputation drops to -3, and only returned when reputation reaches
        // 0 again. So between -2 and -1 the player KEEPS holding it.
        for (const player of players) {
            const tile = state.reputationTiles.find(t => t.ownerId === player.id && t.level === 0);
            if (player.reputation <= -3) {
                if (!tile) {
                    const available = state.reputationTiles.find(t => t.level === 0 && t.ownerId === null);
                    if (available) available.ownerId = player.id;
                }
            } else if (tile && player.reputation >= 0) {
                tile.ownerId = null;
            }
        }

        // ── Levels 1-3 ───────────────────────────────────────────────────
        for (const level of [1, 2, 3]) {
            const tiles = state.reputationTiles.filter(t => t.level === level);
            if (tiles.length === 0) continue;

            // Decide whether tiles at this level are "in circulation".
            // Once any single tile has been claimed, the sticky rule applies
            // forever (you don't drop below the rep threshold to lose it).
            // Until then, *initial* claim requires rep ≥ initialRepThresh.
            const anyOwned = tiles.some(t => t.ownerId !== null);
            const anyCanFirstClaim = players.some(p =>
                p.netWorthLevel >= nwReq[level] && p.reputation >= initialRepThresh[level]
            );
            const inCirculation = anyOwned || anyCanFirstClaim;

            // Eligible holders: meet NW requirement. (Rep threshold doesn't
            // gate holding once in circulation.)
            let eligible = players.filter(p => p.netWorthLevel >= nwReq[level]);
            if (!inCirculation) eligible = [];  // tile sits unclaimed

            // Sort eligibility by rep desc; ties keep current holder, then
            // lowest player id for determinism.
            eligible.sort((a, b) => {
                if (b.reputation !== a.reputation) return b.reputation - a.reputation;
                const aHolds = tiles.some(t => t.ownerId === a.id);
                const bHolds = tiles.some(t => t.ownerId === b.id);
                if (aHolds && !bHolds) return -1;
                if (!aHolds && bHolds) return 1;
                return a.id - b.id;
            });

            const winners = eligible.slice(0, Math.min(tilesPerLevel, eligible.length));
            const winnerIds = new Set(winners.map(p => p.id));

            // Strip ownership from anyone no longer a winner.
            for (const t of tiles) {
                if (t.ownerId !== null && !winnerIds.has(t.ownerId)) {
                    t.ownerId = null;
                }
            }
            // Assign tiles to winners who don't already hold one.
            const unowned = tiles.filter(t => t.ownerId === null);
            let idx = 0;
            for (const w of winners) {
                const alreadyHolds = tiles.some(t => t.ownerId === w.id);
                if (!alreadyHolds && idx < unowned.length) {
                    unowned[idx].ownerId = w.id;
                    idx += 1;
                }
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
        this._ensureSlotState(player);
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
            // power evolves through marketing / train_model / buy_chips-with-BCE
            // AND through play_card (via CardProjections) so validators that
            // gate on power (patent_troll: ≥5, phishing: ≥10) see the right
            // value for later-worker placements in a multi-action turn.
            power: player.power,
            // Projected board slots, so the next recruit/scale cost reflects
            // multi-action sequences and any prior losses.
            worker_board_slots: [...(player.workerBoardSlots || [])],
            presence_board_slots: [...(player.presenceBoardSlots || [])],
            // Read-only hint for projection functions that need to know which
            // player's perspective they're computing (e.g. hire_ethicist scans
            // opponent regions).
            _playerId: playerId,
        };
        // Big Compute Energy adds +N power per compute increase this round
        // (set on the player when the card is played; persists for the round).
        const computePowerBonus = player.tempComputeGainPowerBonus || 0;
        const hypeActive = !!player.tempTrainModelPerRegionPowerBonus;
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
                        // Big Compute Energy: +N power per compute increase this round.
                        if (computePowerBonus > 0) {
                            projected.power = this.clampPower(projected.power + computePowerBonus);
                        }
                    }
                }
            } else if (p.actionType === "marketing") {
                const bonus = Config.MARKETING_BONUSES[projected.net_worth_level];
                if (bonus) {
                    projected.reputation = Math.min(10, projected.reputation + bonus.reputation);
                    if (bonus.power) projected.power = this.clampPower(projected.power + bonus.power);
                }
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
                // Take the lowest-numbered worker token from the projected
                // board (rulebook p.7 + p.14 most-expensive-empty-slot model).
                if (projected.worker_board_slots.length > 0) {
                    const slot = Math.min(...projected.worker_board_slots);
                    const tier = Config.RECRUIT_COSTS[slot] || Config.RECRUIT_COSTS[4];
                    if (projected.corporate_funds >= tier.money && projected.net_worth_level >= tier.min_nw) {
                        projected.corporate_funds -= tier.money;
                        projected.total_workers += 1;
                        projected.worker_board_slots = projected.worker_board_slots.filter(s => s !== slot);
                    }
                }
            } else if (p.actionType === "scale_presence") {
                if (projected.presence_board_slots.length > 0) {
                    const slot = Math.min(...projected.presence_board_slots);
                    const cost = Config.PRESENCE_COSTS[slot - 2];
                    if (projected.corporate_funds >= cost) {
                        projected.corporate_funds -= cost;
                        projected.presence_count += 1;
                        projected.presence_board_slots = projected.presence_board_slots.filter(s => s !== slot);
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
                        // Each upgrade: +1 power per 2 regions (per per-region if Model Hype active).
                        const pgain = hypeActive ? projected.presence_count : Math.floor(projected.presence_count / 2);
                        projected.power = this.clampPower(projected.power + pgain);
                    }
                }
            } else if (p.actionType === "play_card" && p.targetCardId != null) {
                // Look up the card def and apply its registered projection,
                // if any. Cards that lack a CardProjections entry are
                // "dynamic" (target-only, draws, passive mods) and don't
                // affect projected state — their requirements are validated
                // at resolution time only.
                const card = state.components.find(c => c.id === p.targetCardId);
                const def = card && state.cardDefinitions.find(d => d.id === card.cardDetailsId);
                const slug = def && def.effectSlug;
                const projFn = (typeof CardProjections !== "undefined") && slug ? CardProjections[slug] : null;
                if (projFn) {
                    try {
                        projFn(projected, state, def, p.targetSubAction);
                    } catch (e) {
                        // Projection should never throw; if it does, skip so
                        // validation falls back to base state rather than
                        // crashing the placement flow.
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
        // Use the *projected* board slots if available (set by
        // getProjectedPlayerState); otherwise fall back to the player's
        // live slots so direct callers (cards, tests) also get accurate
        // costs.
        let slot;
        if (projectedState.worker_board_slots && projectedState.worker_board_slots.length > 0) {
            slot = Math.min(...projectedState.worker_board_slots);
        } else {
            const player = this.getPlayer(state, playerId);
            slot = this.nextWorkerSlot(player);
        }
        if (slot == null) return {error: "Max workers reached."};
        const tier = Config.RECRUIT_COSTS[slot] || Config.RECRUIT_COSTS[4];
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
        // Rulebook p.9: presence cap by Net Worth tier — Startup 2, Millionaire 6, Billionaire 10.
        const nwPresenceCap = {0: 2, 1: 6, 2: 10};
        const cap = nwPresenceCap[projectedState.net_worth_level] ?? 10;
        if (projectedState.presence_count >= cap) {
            const tier = ["Startup", "Millionaire", "Billionaire"][projectedState.net_worth_level] || "current tier";
            return {error: `${tier} can hold at most ${cap} regions. Increase Net Worth first.`};
        }
        if (projectedState.presence_count >= 10) return {error: "Maximum presence reached."};
        // Cost from the projected board (rulebook p.14 most-expensive-empty-slot).
        let slot;
        if (projectedState.presence_board_slots && projectedState.presence_board_slots.length > 0) {
            slot = Math.min(...projectedState.presence_board_slots);
        } else {
            const player = this.getPlayer(state, playerId);
            slot = this.nextPresenceSlot(player);
        }
        if (slot == null) return {error: "Max Expansion Limit"};
        const cost = Config.PRESENCE_COSTS[slot - 2];
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

    validateActionRequirements(state, playerId, actionType, workerNumber, targetRegion, targetCardId) {
        const projected = this.getProjectedPlayerState(state, playerId, workerNumber);
        if (actionType === "buy_chips") return this.validateBuyChips(state, playerId, projected);
        if (actionType === "recruit") return this.validateRecruit(state, playerId, projected);
        if (actionType === "train_model") return this.validateTrainModel(state, playerId, projected);
        if (actionType === "increase_net_worth") return this.validateIncreaseNetWorth(state, playerId, projected);
        if (actionType === "scale_presence") return this.validateScalePresence(state, playerId, projected, targetRegion);
        if (actionType === "play_card") return this.validatePlayCard(state, playerId, projected, targetCardId);
        return null;
    },

    // Rulebook p.12: "You must meet all card requirements at the time
    // that you play it." Static (player-stat) requirements are checked
    // here so the engine refuses the placement rather than consuming
    // the worker and discarding state mid-effect.
    validatePlayCard(state, playerId, projected, cardId) {
        if (cardId == null) return null;  // Card-less placement is rejected later in playCard.
        const card = state.components.find(c => c.id === cardId);
        if (!card) return {error: "Card not found."};
        if (card.ownerId !== playerId && !card.zone.startsWith("active_effect_card_slot_")) {
            return {error: "Card not owned by player."};
        }
        const def = state.cardDefinitions.find(d => d.id === card.cardDetailsId);
        if (!def || !def.effectSlug) return null;
        const validator = (typeof CardValidators !== 'undefined') ? CardValidators[def.effectSlug] : null;
        if (!validator) return null;  // No static requirements registered → defer to effect-time check.
        return validator(state, playerId, projected);
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
        const reqErr = this.validateActionRequirements(state, playerId, actionType, workerNumber, targetRegion, targetCardId);
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
        // Route through gainCompute so Big Compute Energy and GPU Price
        // Hike both fire (card text says "every time you increase Compute").
        this.gainCompute(state, player, 1);
        return {action: "compute_upgraded", new_level: player.computeLevel};
    },

    // Apply one Model Version upgrade with all the usual side-effects
    // (rep +1, power per region or per /2, tile rebalance, espionage on
    // shared-presence opponents, piggyback on shared-presence opponents).
    // Used by executeTrainModel's loop AND by hack_competitor_model, which
    // pays $4 instead of workers but is supposed to fire the same triggers.
    _applyOneModelUpgrade(state, player) {
        const playerId = player.id;
        player.modelVersion += 1;
        player.reputation = this.clampRep(player.reputation + 1);
        const powerGain = player.tempTrainModelPerRegionPowerBonus
            ? player.presenceCount
            : Math.floor(player.presenceCount / 2);
        if (player.tempTrainModelPerRegionPowerBonus) player.tempTrainModelPerRegionPowerBonus = false;
        this.gainPower(state, player, powerGain);
        this.checkReputationTiles(state, playerId);

        const trainingRegions = new Set(player.presenceRegions);
        for (const other of state.players.filter(p => p.id !== playerId)) {
            if (!other.presenceRegions.some(r => trainingRegions.has(r))) continue;
            // Corporate Espionage
            if (this._playerHasActiveEffect(state, other.id, "corporate_espionage") && other.modelVersion >= 3) {
                const bonus = other.netWorthLevel >= 2 ? 2 : 1;
                this.gainPower(state, other, bonus);
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
                        this.gainCompute(state, other, 1);
                    }
                }
            }
        }
    },

    executeTrainModel(state, playerId, workerCount) {
        const player = this.getPlayer(state, playerId);
        const mods = this.getPlayerModifiers(state, playerId);
        const startV = player.modelVersion;

        // Validate at least the first upgrade up front so we return the
        // same "Insufficient ..." messages the projection assumed.
        const firstNext = startV + 1;
        if (firstNext > 7) return {error: "Maximum Model Version reached."};
        const firstReq = Math.max(0, (Config.MODEL_WORKER_COSTS[firstNext] || 1) + mods.model_worker_cost_offset - player.tempModelCostWorkerReduction);
        if (workerCount < firstReq) return {error: `Insufficient Tech Workers. Need ${firstReq}.`};
        if (player.computeLevel < firstNext) return {error: `Insufficient Compute Level. Need ${firstNext}.`};
        if (player.netWorthLevel < (Config.MODEL_NET_WORTH_REQ[firstNext] || 0)) return {error: "Net Worth too low."};

        // Rulebook p.8 example shows a player jumping multiple Model
        // Versions in one round if they place enough workers (e.g., 2
        // workers to go from V2 to V4 since the cost from V3→V4 is 2).
        // Keep upgrading while workers cover the next req AND Net Worth /
        // Compute thresholds for the new version are still met.
        let remaining = workerCount;
        let upgradesApplied = 0;
        while (player.modelVersion < 7) {
            const nextV = player.modelVersion + 1;
            const baseReq = Config.MODEL_WORKER_COSTS[nextV] || 1;
            const finalReq = Math.max(0, baseReq + mods.model_worker_cost_offset - player.tempModelCostWorkerReduction);
            if (remaining < finalReq) break;
            if (player.computeLevel < nextV) break;
            if (player.netWorthLevel < (Config.MODEL_NET_WORTH_REQ[nextV] || 0)) break;

            remaining -= finalReq;
            upgradesApplied += 1;
            this._applyOneModelUpgrade(state, player);
        }
        return {
            action: "model_trained",
            upgrades_applied: upgradesApplied,
            start_version: startV,
            new_version: player.modelVersion,
            new_power: player.power,
            new_income: player.income,
        };
    },

    executeMarketing(state, playerId) {
        const player = this.getPlayer(state, playerId);
        const bonus = Config.MARKETING_BONUSES[player.netWorthLevel];
        player.reputation = this.clampRep(player.reputation + bonus.reputation);
        if (bonus.power) this.gainPower(state, player, bonus.power);
        this.checkReputationTiles(state, playerId);
        return {action: "marketing_resolved", new_reputation: player.reputation};
    },

    executeScalePresence(state, playerId, targetRegion) {
        const player = this.getPlayer(state, playerId);
        // Rulebook p.9 presence cap by Net Worth tier.
        const nwCap = {0: 2, 1: 6, 2: 10}[player.netWorthLevel] ?? 10;
        if (player.presenceCount >= nwCap) {
            const tier = ["Startup", "Millionaire", "Billionaire"][player.netWorthLevel] || "tier";
            return {error: `${tier} can hold at most ${nwCap} regions.`};
        }
        if (player.presenceRegions.includes(targetRegion)) return {error: "Already present in this region."};
        // Cost from the next presence board slot (rulebook p.14).
        const baseCost = this.nextPresenceCost(player);
        if (baseCost == null) return {error: "No presence tokens available."};
        const finalCost = Math.max(0, baseCost - player.tempPresenceMonetaryDiscount) + player.tempActionCostIncrease;
        if (player.corporateFunds < finalCost) return {error: `Insufficient funds. Need $${finalCost}.`};
        const adjacent = player.presenceRegions.some(r => (Config.WORLD_MAP[r] || []).includes(targetRegion));
        if (!adjacent) return {error: "Region not adjacent."};
        player.corporateFunds -= finalCost;
        this.scalePresenceFromBoard(player, targetRegion);
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
        const tier = this.nextWorkerTier(player);
        if (!tier) return {error: "Max workers reached."};
        const slot = this.nextWorkerSlot(player);
        const recruitCost = tier.money + player.tempRecruitCostIncrease + player.tempActionCostIncrease;
        if (player.netWorthLevel < tier.min_nw) return {error: "Net Worth too low."};
        if (player.corporateFunds < recruitCost) return {error: `Insufficient funds. Need $${recruitCost}.`};
        player.corporateFunds -= recruitCost;
        player.tempRecruitCostIncrease = 0;
        // Pull the worker token from the board (rulebook p.14 — uses the
        // most-expensive-empty-slot model so multi-loss-then-rebuy
        // sequences charge the right slot).
        this.recruitWorkerFromBoard(player);
        // Only auto-place the new worker if (a) the player gave it a target
        // and (b) they didn't already pre-place a placement for this worker
        // number themselves (e.g. by clicking a tile after Recruit).
        const existing = state.workerPlacements.find(wp => wp.playerId === playerId && wp.workerNumber === slot);
        let placedAt = null;
        if (!existing && targetAction) {
            state.workerPlacements.push({
                playerId, workerNumber: slot, actionType: targetAction,
                targetRegion: targetRegion || null, targetCardId: targetCardId || null, targetSubAction: null,
            });
            placedAt = targetAction;
        } else if (existing) {
            placedAt = existing.actionType;
        }
        return {action: "worker_recruited", new_total: player.totalWorkers, placed_at: placedAt};
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
        const mods = this.getPlayerModifiers(state, playerId);
        // If Venture Mogul (free_hand_card) is available and this is a hand
        // card (not a re-played effect from an active slot), spend it.
        const isHandCard = card.zone === `hand_p${playerId}`;
        let venturePopped = false;
        let baseCost = def.cost;
        if (isHandCard && mods.free_hand_card && !player.tempFreeHandCardUsed) {
            baseCost = 0;
            venturePopped = true;
        }
        const cost = Math.max(0, baseCost - player.tempCardCostWorkerReduction - mods.card_cost_worker_reduction + player.tempCardCostWorkerIncrease);
        if (cost > 0 && player.workersSpentOnCards + cost > playCardWorkers) {
            return {error: `Insufficient 'Play Card' workers. Need ${cost}.`};
        }
        player.workersSpentOnCards += cost;
        if (venturePopped) player.tempFreeHandCardUsed = true;

        if (def.isEffect) {
            if (!targetSlot || targetSlot < 1 || targetSlot > 3) return {error: "Invalid slot for Effect Card."};
            const targetZone = `active_effect_card_slot_${targetSlot}_p${playerId}`;
            const existing = state.components.find(c => c.zone === targetZone);
            if (existing) {
                const exDef = state.cardDefinitions.find(d => d.id === existing.cardDetailsId);
                if (exDef && exDef.effectSlug === "intern_program") {
                    // Card text: "Once played, this card cannot be discarded."
                    return {error: "Intern Volunteer Program cannot be displaced. Pick a different slot."};
                }
                existing.zone = `${existing.subType}_discard`;
                existing.ownerId = null;
            }
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

    // Infinite Loop (free_active_effect tile): re-fire one of the player's
    // active-effect cards for free, once per round. The card stays in its
    // slot — only its effect is re-applied. Costs zero workers and the
    // freebie flag is consumed.
    replayActiveEffect(state, playerId, cardId, payload) {
        const card = state.components.find(c => c.id === cardId);
        if (!card || card.ownerId !== playerId) return {error: "Not owner."};
        if (!card.zone || !card.zone.startsWith("active_effect_card_slot_")) {
            return {error: "Card is not in an active effect slot."};
        }
        const player = this.getPlayer(state, playerId);
        const mods = this.getPlayerModifiers(state, playerId);
        if (!mods.free_active_effect) return {error: "Requires the Infinite Loop reputation tile."};
        if (player.tempFreeActiveEffectUsed) return {error: "Already used Infinite Loop this round."};
        if (player.ransomwareLocked >= 2) return {error: "Ransomware Lock: You cannot play cards this round."};

        const def = state.cardDefinitions.find(d => d.id === card.cardDetailsId);
        if (!def || !def.isEffect) return {error: "Card is not a re-playable effect card."};

        player.tempFreeActiveEffectUsed = true;
        const effectRes = this.applyCardEffect(state, playerId, cardId, payload);
        if (effectRes && effectRes.error) {
            // Roll back the flag if effect application failed.
            player.tempFreeActiveEffectUsed = false;
            return effectRes;
        }
        return {action: "active_effect_replayed", card_id: cardId};
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
                    // Prefer empty slots; then any non-intern occupied slot.
                    let chosen = null;
                    for (let s = 1; s <= 3; s++) {
                        if (!state.components.find(c => c.zone === `active_effect_card_slot_${s}_p${playerId}`)) {
                            chosen = s; break;
                        }
                    }
                    if (chosen == null) {
                        for (let s = 1; s <= 3; s++) {
                            const occ = state.components.find(c => c.zone === `active_effect_card_slot_${s}_p${playerId}`);
                            if (!occ) continue;
                            const occDef = state.cardDefinitions.find(d => d.id === occ.cardDetailsId);
                            if (occDef && occDef.effectSlug === "intern_program") continue;
                            chosen = s; break;
                        }
                    }
                    if (chosen != null) targetSlot = chosen;
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
        // Surface engine-side rejections (e.g. "Requirement not met: Power
        // must be at least 5", "Insufficient Tech Workers. Need 2") so the
        // resolution log + agent-test audit can flag them. Without this,
        // failed card effects show as "Played {cardName}" or similar,
        // silently masking real strategic mistakes / engine errors.
        if (result && result.error) return result.error;
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

            while (true) {
                // Re-read placements each iteration so workers spawned by
                // Recruit during this player's turn execute their action
                // this round (rulebook p.7).
                const livePlacements = state.workerPlacements
                    .filter(p => p.playerId === player.id)
                    .sort((a, b) => a.workerNumber - b.workerNumber);
                const p = livePlacements.find(wp => !resolved.has(wp.workerNumber));
                if (!p) break;

                // Re-collect group workers from the LIVE list so a recruited
                // worker added mid-resolution joins its group.
                //
                // Rulebook p.5/p.10 says Train Model and Raise Funds count
                // *consecutive* Tech Workers — workers 1+2 form a group,
                // workers 1+3 do not. Gather a contiguous run of same-action
                // workers starting at p; any gap (different action or
                // missing worker number) ends the group.
                const remaining = livePlacements.filter(wp => !resolved.has(wp.workerNumber));
                let groupWorkers, workerCount;
                if (p.actionType === "raise_funds" || p.actionType === "train_model") {
                    groupWorkers = [p];
                    let lastNum = p.workerNumber;
                    for (let i = 1; i < remaining.length; i++) {
                        const next = remaining[i];
                        if (next.actionType !== p.actionType) break;
                        if (next.workerNumber !== lastNum + 1) break;
                        groupWorkers.push(next);
                        lastNum = next.workerNumber;
                    }
                    workerCount = groupWorkers.length;
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
                    card_id: p.targetCardId, card_name: cardName, card_image: cardImage, card_is_effect: cardIsEffect, targets,
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
                // Card description: "They lose 1 Worker next round." Apply
                // the loss now (start of next round), routed through the
                // board-slot helper so the freed token sits on the most
                // expensive empty slot for re-purchase (rulebook p.14).
                else if (slug === "ransomware") this.returnWorkerToBoard(player);
                else if (slug === "supply_chain_meltdown") player.tempActionCostIncrease += 3;
                else if (slug === "poach_engineers") this.returnWorkerToBoard(player);  // rulebook p.14 min 3 + most-expensive-empty-slot
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
            player.tempFreeHandCardUsed = false;
            player.tempFreeActiveEffectUsed = false;
        }
        state.game.pendingInteractions = [];

        // Game-end check: rulebook p.14 — when any player reaches Model
        // Version 7, the round just played is the final round.
        const reachedV7 = state.players.some(p => p.modelVersion >= 7);
        if (reachedV7) {
            // End-of-game siphon: all players move remaining Corporate Funds
            // to Personal Funds before scoring (rulebook p.14).
            for (const player of state.players) {
                if (player.corporateFunds > 0) {
                    player.personalFunds += player.corporateFunds;
                    player.corporateFunds = 0;
                }
            }
            state.game.gamePhase = "finished";
            const leaderboard = this.calculateGameLeaderboard(state);
            return {status: "game_over", final_round: state.game.currentRound, leaderboard};
        }

        // Advance round
        state.game.currentRound += 1;
        const leaderboard = this.calculateGameLeaderboard(state);
        if (state.game.currentRound > state.game.maxRounds) {
            // Safety cap: if nobody hit V7 within maxRounds (rare), end anyway
            // with the same end-of-game siphon.
            for (const player of state.players) {
                if (player.corporateFunds > 0) {
                    player.personalFunds += player.corporateFunds;
                    player.corporateFunds = 0;
                }
            }
            state.game.gamePhase = "finished";
            return {status: "game_over", final_round: state.game.currentRound - 1, leaderboard: this.calculateGameLeaderboard(state)};
        }

        // Apply round-start penalty tiles (only owners of these tiles, i.e.
        // players currently at -3 reputation, are affected). Other penalty
        // effects — model_cost_plus_1, compute_cost_plus_3, hand_limit_3 —
        // are read via getPlayerModifiers and don't need to fire here.
        for (const player of state.players) {
            const tiles = state.reputationTiles.filter(t => t.ownerId === player.id);
            for (const tile of tiles) {
                if (tile.effectCode === "lose_2_power_round") {
                    player.power = this.clampPower(player.power - 2);
                    this.updatePlayerIncome(state, player);
                } else if (tile.effectCode === "discard_per_round") {
                    // Auto-discard the first non-protected card in hand.
                    const hand = state.components.filter(
                        c => c.zone === `hand_p${player.id}` && c.ownerId === player.id
                    );
                    for (const c of hand) {
                        const def = state.cardDefinitions.find(d => d.id === c.cardDetailsId);
                        if (def && def.effectSlug === "intern_program") continue;
                        c.zone = `${c.subType}_discard`;
                        c.ownerId = null;
                        break;
                    }
                }
            }
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
                // Carry the tie-break fields so the sort can reach them.
                _model: p.modelVersion, _power: p.power,
                _personal: p.personalFunds, _reputation: p.reputation,
                breakdown: {race_bonuses: p.vp, power_vp: Math.floor(p.power / 5), model_vp: p.modelVersion, presence_vp: p.presenceCount, funds_bonus: fundBonuses[p.id] || 0},
            };
        });
        // Rulebook p.14 tie-break order: VP → model → power → personal funds
        // → reputation. Any remaining tie is a "shared failure" — we mark
        // those entries with `shared_failure` so the UI can surface it.
        leaderboard.sort((a, b) =>
            b.total_vp - a.total_vp
            || b._model - a._model
            || b._power - a._power
            || b._personal - a._personal
            || b._reputation - a._reputation
        );
        // Mark any group that ties through all tie-breaks (true co-leaders).
        for (let i = 0; i < leaderboard.length; i++) {
            for (let j = i + 1; j < leaderboard.length; j++) {
                if (leaderboard[i].total_vp === leaderboard[j].total_vp
                    && leaderboard[i]._model === leaderboard[j]._model
                    && leaderboard[i]._power === leaderboard[j]._power
                    && leaderboard[i]._personal === leaderboard[j]._personal
                    && leaderboard[i]._reputation === leaderboard[j]._reputation) {
                    leaderboard[i].shared_failure = true;
                    leaderboard[j].shared_failure = true;
                }
            }
        }
        // Strip the tie-break helpers so the public shape stays compatible.
        for (const row of leaderboard) {
            delete row._model; delete row._power; delete row._personal; delete row._reputation;
        }
        return leaderboard;
    },
};
