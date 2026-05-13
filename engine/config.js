// Disruptopia P2P - Game Constants
// Ported from backend/config.py

const Config = {
    COMPUTE_UPGRADE_COSTS: {2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7},
    COMPUTE_NET_WORTH_REQ: {3: 1, 4: 1, 5: 2, 6: 2, 7: 2},
    MODEL_WORKER_COSTS: {1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 4, 7: 4},
    MODEL_NET_WORTH_REQ: {3: 1, 4: 1, 5: 2, 6: 2, 7: 2},
    // Geographic adjacencies (15 edges).
    //  1 Silicon Valley (N. America)        — adj: 2 ElDorado, 3 Spotify (Atlantic), 8 Fab (Bering)
    //  2 El Dorado (S. America)             — adj: 1, 5 Cobalt Mine (Atlantic)
    //  3 Spotify (N. Europe)                — adj: 1, 4 Yacht, 6 Bot Farm
    //  4 Yacht Goes Here (Mediterranean)    — adj: 3, 5, 6
    //  5 Cobalt Mine (Sub-Saharan Africa)   — adj: 2, 4, 7 PhDistan (Indian Ocean)
    //  6 Bot Farm (Eurasian interior)       — adj: 3, 4, 7, 8
    //  7 PhDistan (S. Asia)                 — adj: 5, 6, 8, 9 Coworking Bali
    //  8 The Fab (E. Asia)                  — adj: 1, 6, 7, 9
    //  9 Coworking Bali (SE Asia)           — adj: 7, 8, 10 Bunkers
    // 10 Post-Apocalypse Bunkers (Oceania)  — adj: 9
    WORLD_MAP: {
        1: [2, 3, 8],
        2: [1, 5],
        3: [1, 4, 6],
        4: [3, 5, 6],
        5: [2, 4, 7],
        6: [3, 4, 7, 8],
        7: [5, 6, 8, 9],
        8: [1, 6, 7, 9],
        9: [7, 8, 10],
        10: [9],
    },
    NET_WORTH_COSTS: {
        1: {money: 3, reputation: 2},
        2: {money: 5, reputation: 4},
    },
    RECRUIT_COSTS: {
        4: {money: 2, min_nw: 0}, 5: {money: 3, min_nw: 1},
        6: {money: 4, min_nw: 1}, 7: {money: 5, min_nw: 2}, 8: {money: 6, min_nw: 2},
    },
    PRESENCE_COSTS: [1, 3, 4, 5, 6, 8, 10, 12, 14],
    MARKETING_BONUSES: {
        0: {reputation: 3, power: 0}, 1: {reputation: 1, power: 1}, 2: {reputation: 0, power: 2},
    },
    // Pastel palette — soft, distinct hues over the cream board background.
    PLAYER_COLORS: {1: "#f87171", 2: "#93c5fd", 3: "#86efac", 4: "#fcd34d", 5: "#c4b5fd"},
    REPUTATION_TILE_POOL: {
        0: [
            {name: "Inefficient R&D", effect: "model_cost_plus_1"}, {name: "Legacy Tax", effect: "compute_cost_plus_3"},
            {name: "Information Leak", effect: "discard_per_round"}, {name: "Security Audit", effect: "hand_limit_3"},
            {name: "Power Drain", effect: "lose_2_power_round"},
        ],
        1: [
            {name: "Subsidy Bonus", effect: "income_plus_1"}, {name: "Rapid Intel", effect: "draw_extra_card"},
            {name: "Expanded Library", effect: "hand_limit_6"}, {name: "Hardware Discount", effect: "compute_minus_1"},
        ],
        2: [
            {name: "Market Leader", effect: "income_plus_2"}, {name: "Cloud Partnership", effect: "compute_minus_2"},
            {name: "Streamlined Ops", effect: "play_card_worker_minus_1"}, {name: "Optimized Training", effect: "model_worker_minus_1"},
        ],
        3: [
            {name: "Venture Mogul", effect: "free_hand_card"}, {name: "Board Chairman", effect: "perma_p1"},
            {name: "Infinite Loop", effect: "free_active_effect"}, {name: "Automated Finance", effect: "one_worker_income"},
        ],
    },
    ACTIONS: ["Buy Chips", "Recruit", "Train New Model", "Increase Net Worth", "Marketing", "Scale Presence", "Play Card", "Raise Funds"],
    ACTION_DESCRIPTIONS: {
        buy_chips: "Upgrade Compute Level (required for Model)", recruit: "Hire a new Tech Worker",
        train_model: "Train next Model version (+Power, +Rep)", increase_net_worth: "Upgrade to Millionaire/Billionaire (costs $ and Rep)",
        marketing: "Startup: +3 Rep | Millionaire: +1 Rep +1 Pwr | Billionaire: +2 Pwr", scale_presence: "Expand to adjacent region (earn Subsidy Tokens)",
        play_card: "Play a card from your hand", raise_funds: "Siphon corp funds to personal, draw income",
    },
    REGIONS: ["Silicon Valley", "El Dorado", "Spotify", "Yacht Goes Here", "The Cobalt Mine", "The Bot Farm", "PhDistan", "The Fab", "Coworking Bali", "Bunkers"],
    // Geographic centers in % of the world-map.svg (1603x742 viewBox).
    // Derived from the user's hand-positioned labels in
    // images/labeled-world-map.jpg (OCR'd to pixel centers, then offset
    // ~24px DOWN so the worker-token row sits just under each label).
    REGION_LAYOUT: [
        {id:1,  x:12.91, y:33.15}, // Silicon Valley
        {id:2,  x:22.65, y:70.35}, // El Dorado
        {id:3,  x:46.85, y:17.52}, // Spotify
        {id:4,  x:45.98, y:35.04}, // Yacht Goes Here
        {id:5,  x:49.97, y:58.49}, // The Cobalt Mine
        {id:6,  x:60.07, y:27.76}, // The Bot Farm
        {id:7,  x:65.25, y:45.28}, // PhDistan
        {id:8,  x:77.04, y:29.78}, // The Fab
        {id:9,  x:75.98, y:53.10}, // Coworking Bali
        {id:10, x:80.54, y:78.98}, // Bunkers
    ],
};
