// Disruptopia P2P - Relay Client
// Communicates with the lightweight relay server for async multiplayer
// The relay is just a mailbox — it stores actions and forwards them when players come online

const Relay = {
    serverUrl: null,
    gameCode: null,
    playerId: null,
    _pollInterval: null,
    _lastActionIndex: 0,
    onActionReceived: null,  // Callback: (action) => {}
    onPlayerJoined: null,    // Callback: (playerInfo) => {}
    connected: false,

    configure(serverUrl, gameCode, playerId) {
        this.serverUrl = serverUrl;
        this.gameCode = gameCode;
        this.playerId = playerId;
    },

    // --- Host creates a game room on the relay ---
    async createRoom(gameState) {
        if (!this.serverUrl) return {error: "No relay server configured"};
        try {
            const res = await fetch(`${this.serverUrl}/room`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    gameCode: this.gameCode,
                    initialState: gameState,
                    hostPlayerId: this.playerId,
                }),
                timeout: 10000,
            });
            if (!res.ok) return {error: `Server error: ${res.status}`};
            const data = await res.json();
            this.connected = true;
            return data;
        } catch (e) {
            return {error: `Cannot reach relay: ${e.message}`};
        }
    },

    // --- Player joins an existing room ---
    async joinRoom() {
        if (!this.serverUrl) return {error: "No relay server configured"};
        try {
            const res = await fetch(`${this.serverUrl}/room/${this.gameCode}/join`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({playerId: this.playerId}),
                timeout: 10000,
            });
            if (!res.ok) return {error: `Join failed: ${res.status}`};
            const data = await res.json();
            this.connected = true;
            this._lastActionIndex = data.actionCount || 0;
            return data;
        } catch (e) {
            return {error: `Cannot reach relay: ${e.message}`};
        }
    },

    // --- Send an action to the relay for other players ---
    async sendAction(action) {
        if (!this.serverUrl || !this.connected) {
            // Offline mode — action is applied locally only
            return {status: "offline"};
        }
        try {
            const res = await fetch(`${this.serverUrl}/room/${this.gameCode}/action`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    playerId: this.playerId,
                    action,
                    timestamp: Date.now(),
                }),
                timeout: 10000,
            });
            if (!res.ok) return {error: `Send failed: ${res.status}`};
            return await res.json();
        } catch (e) {
            return {error: `Send failed: ${e.message}`};
        }
    },

    // --- Poll for new actions from other players ---
    async pollActions() {
        if (!this.serverUrl || !this.connected) return [];
        try {
            const res = await fetch(
                `${this.serverUrl}/room/${this.gameCode}/actions?since=${this._lastActionIndex}`,
                {timeout: 10000}
            );
            if (!res.ok) return [];
            const data = await res.json();
            const newActions = data.actions || [];
            if (newActions.length > 0) {
                this._lastActionIndex = data.lastIndex;
                // Filter out our own actions
                const otherActions = newActions.filter(a => a.playerId !== this.playerId);
                for (const action of otherActions) {
                    if (this.onActionReceived) this.onActionReceived(action);
                }
            }
            return newActions;
        } catch (e) {
            return [];
        }
    },

    // --- Get the full game state from the relay (for joining players) ---
    async getLatestState() {
        if (!this.serverUrl) return null;
        try {
            const res = await fetch(`${this.serverUrl}/room/${this.gameCode}/state`, {timeout: 10000});
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        }
    },

    // --- Push full state snapshot (host periodically syncs) ---
    async pushState(gameState) {
        if (!this.serverUrl || !this.connected) return;
        try {
            await fetch(`${this.serverUrl}/room/${this.gameCode}/state`, {
                method: "PUT",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({state: gameState, playerId: this.playerId}),
                timeout: 10000,
            });
        } catch (e) {
            // Silently fail — relay is optional
        }
    },

    // --- Start polling loop ---
    startPolling(intervalMs) {
        this.stopPolling();
        this._pollInterval = setInterval(() => this.pollActions(), intervalMs || 3000);
    },

    stopPolling() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
        }
    },

    // --- Generate a short room code ---
    generateGameCode() {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code = "";
        for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
        return code;
    },
};
