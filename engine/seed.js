// Disruptopia P2P - Game Initialization
// Ported from backend/seed.py

const Seed = {
    _nextId: 1,
    _genId() { return this._nextId++; },

    // Simple seeded PRNG (mulberry32)
    _rng(seed) {
        let s = seed | 0;
        return function() {
            s = (s + 0x6D2B79F5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    },

    // Shuffle array using Fisher-Yates with seeded RNG
    _shuffle(arr, rng) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    },

    createGame(playerNames, startingRegions) {
        this._nextId = 1;
        const rng = this._rng(42);
        const playerCount = playerNames.length;

        // 1. Create game state
        const state = {
            game: {
                id: 1,
                currentRound: 1,
                maxRounds: 8,
                gamePhase: "playing",
                p1TokenIndex: 0,
                millionaireCount: 0,
                billionaireCount: 0,
                pendingInteractions: [],
            },
            players: [],
            workerPlacements: [],
            regionStates: [],
            reputationTiles: [],
            cardDefinitions: [],
            components: [],
        };

        // 2. Create players
        for (let i = 0; i < playerCount; i++) {
            state.players.push({
                id: this._genId(),
                userName: playerNames[i],
                playerOrder: i,
                corporateFunds: 3,
                personalFunds: 0,
                reputation: 0,
                netWorthLevel: 0,
                computeLevel: 1,
                modelVersion: 0,
                presenceCount: 1,
                totalWorkers: 3,
                workersSpentOnCards: 0,
                power: 3,
                subsidyTokens: 0,
                income: 3,
                vp: 0,
                presenceRegions: [startingRegions[i]],
                // Temp round modifiers
                tempModelCostWorkerReduction: 0,
                tempCardCostWorkerReduction: 0,
                tempComputeMonetaryDiscount: 0,
                tempComputeGainPowerBonus: 0,
                tempTrainModelPerRegionPowerBonus: false,
                tempPiggybackCompetitorModel: false,
                tempPresenceMonetaryDiscount: 0,
                tempRecruitCostIncrease: 0,
                tempCardCostWorkerIncrease: 0,
                tempActionCostIncrease: 0,
                tempWorkerLockCount: 0,
                tempHandLimitIgnore: false,
                tempP1Steal: false,
                tempFreeHandCardUsed: false,    // Venture Mogul freebie (level-3 tile)
                tempFreeActiveEffectUsed: false, // Infinite Loop freebie (level-3 tile)
                ransomwareLocked: 0,
            });
        }

        // 3. Seed regions
        const tokensPerRegion = playerCount <= 3 ? 1 : 2;
        for (let rId = 1; rId <= 10; rId++) {
            state.regionStates.push({regionId: rId, subsidyTokensRemaining: tokensPerRegion});
        }

        // 4. Seed reputation tiles
        const pool = Config.REPUTATION_TILE_POOL;
        const numToPick = playerCount <= 3 ? 1 : 2;
        for (const [levelStr, tiles] of Object.entries(pool)) {
            const level = parseInt(levelStr);
            if (level === 0) {
                for (let i = 0; i < playerCount; i++) {
                    const tData = tiles[Math.floor(rng() * tiles.length)];
                    state.reputationTiles.push({
                        id: this._genId(), level: 0, name: tData.name,
                        effectCode: tData.effect, ownerId: null,
                    });
                }
            } else {
                const shuffled = this._shuffle(tiles, rng);
                const selected = shuffled.slice(0, Math.min(tiles.length, numToPick));
                for (const tData of selected) {
                    state.reputationTiles.push({
                        id: this._genId(), level, name: tData.name,
                        effectCode: tData.effect, ownerId: null,
                    });
                }
            }
        }

        // 5. Seed card definitions and deck components
        const allDecks = [
            {cards: Cards.RESEARCH, deck: "research", deckZone: "research_deck"},
            {cards: Cards.INFLUENCE, deck: "influence", deckZone: "influence_deck"},
            {cards: Cards.SABOTAGE, deck: "sabotage", deckZone: "sabotage_deck"},
        ];
        for (const {cards, deck, deckZone} of allDecks) {
            for (const cardData of cards) {
                const defId = this._genId();
                state.cardDefinitions.push({
                    id: defId,
                    name: cardData.title,
                    isEffect: cardData.isEffect,
                    cost: cardData.cost,
                    deck,
                    effectSlug: cardData.effectSlug,
                    description: cardData.description,
                    requirements: cardData.requirements,
                    image: cardData.image,
                });
                for (let i = 0; i < cardData.qty; i++) {
                    state.components.push({
                        id: this._genId(),
                        cardDetailsId: defId,
                        zone: deckZone,
                        subType: deck,
                        ownerId: null,
                        isFaceUp: false,
                    });
                }
            }
        }

        // 6. Shuffle each deck
        for (const deckZone of ["research_deck", "influence_deck", "sabotage_deck"]) {
            const deckCards = state.components.filter(c => c.zone === deckZone);
            const shuffled = this._shuffle(deckCards.map(c => c.id), rng);
            // Reorder by reassigning IDs doesn't work - instead shuffle zone order
            // Since drawCard picks the first match, we reorder the components array
            const nonDeck = state.components.filter(c => c.zone !== deckZone);
            const deckObjs = deckCards.sort((a, b) => shuffled.indexOf(a.id) - shuffled.indexOf(b.id));
            state.components = [...nonDeck, ...deckObjs];
        }

        // 7. Initial card draw (1 from each deck per player)
        for (const player of state.players) {
            Engine.drawCard(state, player.id, "research_deck");
            Engine.drawCard(state, player.id, "influence_deck");
            Engine.drawCard(state, player.id, "sabotage_deck");
        }

        return state;
    },
};
