// Disruptopia P2P - Game Constants
// Ported from backend/config.py

const Config = {
    COMPUTE_UPGRADE_COSTS: {2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7},
    COMPUTE_NET_WORTH_REQ: {3: 1, 4: 1, 5: 2, 6: 2, 7: 2},
    MODEL_WORKER_COSTS: {1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 4, 7: 4},
    MODEL_NET_WORTH_REQ: {3: 1, 4: 1, 5: 2, 6: 2, 7: 2},
    WORLD_MAP: {
        1: [2, 6], 2: [1, 3, 7], 3: [2, 4, 8], 4: [3, 5, 9], 5: [4, 10],
        6: [1, 7], 7: [2, 6, 8], 8: [3, 7, 9], 9: [4, 8, 10], 10: [5, 9],
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
    PLAYER_COLORS: {1: "#ff0000", 2: "#ffffff", 3: "#ffff00", 4: "#0000ff", 5: "#ffc0cb"},
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
    REGIONS: ["NW Americas", "NE Americas", "W Europe", "E Europe", "NE Asia", "W Americas", "S America", "Africa", "Middle East", "SE Asia"],
    REGION_LAYOUT: [
        {id:1,x:10,y:25,w:20,h:48},{id:2,x:30,y:25,w:20,h:48},{id:3,x:50,y:25,w:20,h:48},{id:4,x:70,y:25,w:20,h:48},{id:5,x:90,y:25,w:20,h:48},
        {id:6,x:10,y:75,w:20,h:48},{id:7,x:30,y:75,w:20,h:48},{id:8,x:50,y:75,w:20,h:48},{id:9,x:70,y:75,w:20,h:48},{id:10,x:90,y:75,w:20,h:48}
    ],
};
