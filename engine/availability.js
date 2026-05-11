// Disruptopia P2P - Action Availability Validator
// Ported from backend/availability.py

const Availability = {
    getReport(projectedState, workersRemaining, mods, ignoreWorkerCheck) {
        mods = mods || {
            model_worker_cost_offset: 0, compute_cost_offset: 0, hand_limit: 5,
            income_offset: 0, draw_bonus: 0, worker_income_efficiency: false,
            free_card_play: false, priority_p1: false,
        };
        const _funds = () => projectedState.corporate_funds || 0;
        const _nw = () => projectedState.net_worth_level || 0;
        const _rep = () => projectedState.reputation || 0;
        const _checkWorker = () => {
            if (ignoreWorkerCheck) return null;
            if (workersRemaining <= 0) return {available: false, reason: "No Workers Remaining"};
            return null;
        };

        return {
            raise_funds: _checkWorker() || {available: true},
            play_card: _checkWorker() || {available: true},
            marketing: _checkWorker() || {available: true},
            buy_chips: (() => {
                const wc = _checkWorker(); if (wc) return wc;
                const nextLevel = (projectedState.compute_level || 0) + 1;
                if (nextLevel > 7) return {available: false, reason: "Max Compute Level Reached"};
                const baseCost = Config.COMPUTE_UPGRADE_COSTS[nextLevel] || 999;
                const cost = Math.max(0, baseCost + mods.compute_cost_offset);
                if (_funds() < cost) return {available: false, reason: `Insufficient Funds ($${cost})`};
                const reqNw = Config.COMPUTE_NET_WORTH_REQ[nextLevel] || 0;
                if (_nw() < reqNw) return {available: false, reason: "Net Worth Too Low"};
                return {available: true};
            })(),
            recruit: (() => {
                const wc = _checkWorker(); if (wc) return wc;
                const nextNum = (projectedState.total_workers || 3) + 1;
                if (nextNum > 8) return {available: false, reason: "Max Workers Reached"};
                const tier = Config.RECRUIT_COSTS[nextNum] || Config.RECRUIT_COSTS[4];
                if (_funds() < tier.money) return {available: false, reason: `Insufficient Funds ($${tier.money})`};
                if (_nw() < tier.min_nw) return {available: false, reason: "Net Worth Too Low"};
                return {available: true};
            })(),
            train_model: (() => {
                const wc = _checkWorker(); if (wc) return wc;
                const nextV = (projectedState.model_version || 0) + 1;
                if (nextV > 7) return {available: false, reason: "Max Model Version Reached"};
                if (_nw() < (Config.MODEL_NET_WORTH_REQ[nextV] || 0)) return {available: false, reason: "Net Worth Too Low"};
                if ((projectedState.compute_level || 0) < nextV) return {available: false, reason: `Compute Level ${nextV} Required`};
                return {available: true};
            })(),
            increase_net_worth: (() => {
                const wc = _checkWorker(); if (wc) return wc;
                const nextNw = _nw() + 1;
                if (nextNw > 2) return {available: false, reason: "Max Net Worth Reached"};
                const costs = Config.NET_WORTH_COSTS[nextNw];
                if (!costs) return {available: false, reason: "Unknown NW Tier"};
                if (_funds() < costs.money) return {available: false, reason: `Insufficient Funds ($${costs.money})`};
                if ((_rep() - costs.reputation) < -3) return {available: false, reason: "Reputation Too Low"};
                return {available: true};
            })(),
            scale_presence: (() => {
                const wc = _checkWorker(); if (wc) return wc;
                const currentCount = projectedState.presence_count || 0;
                if (currentCount >= 10) return {available: false, reason: "Max Presence Reached"};
                let costIdx = currentCount - 1;
                if (costIdx < 0) costIdx = 0;
                if (costIdx >= Config.PRESENCE_COSTS.length) return {available: false, reason: "Max Expansion Limit"};
                const cost = Config.PRESENCE_COSTS[costIdx];
                if (_funds() < cost) return {available: false, reason: `Insufficient Funds ($${cost})`};
                const ownedIds = new Set(projectedState.presence_regions || []);
                const neighbors = new Set();
                for (const rId of ownedIds) {
                    for (const a of (Config.WORLD_MAP[rId] || [])) {
                        if (!ownedIds.has(a)) neighbors.add(a);
                    }
                }
                if (neighbors.size === 0) return {available: false, reason: "No Valid Expansion Targets"};
                return {available: true};
            })(),
        };
    },
};
