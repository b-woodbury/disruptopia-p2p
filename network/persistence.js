// Disruptopia P2P - IndexedDB Persistence Layer
// Stores game state locally so server restarts don't affect gameplay

const Persistence = {
    DB_NAME: "disruptopia_p2p",
    DB_VERSION: 1,
    STORE_NAME: "game_states",
    _db: null,

    async open() {
        if (this._db) return this._db;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, {keyPath: "gameId"});
                }
            };
            req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
            req.onerror = (e) => reject(e.target.error);
        });
    },

    async saveState(gameState) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, "readwrite");
            const store = tx.objectStore(this.STORE_NAME);
            const record = {
                gameId: gameState.game.id,
                state: JSON.parse(JSON.stringify(gameState)),
                savedAt: Date.now(),
            };
            const req = store.put(record);
            req.onsuccess = () => resolve();
            req.onerror = (e) => reject(e.target.error);
        });
    },

    async loadState(gameId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, "readonly");
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.get(gameId);
            req.onsuccess = () => resolve(req.result ? req.result.state : null);
            req.onerror = (e) => reject(e.target.error);
        });
    },

    async deleteState(gameId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, "readwrite");
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.delete(gameId);
            req.onsuccess = () => resolve();
            req.onerror = (e) => reject(e.target.error);
        });
    },

    async listGames() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, "readonly");
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result.map(r => ({
                gameId: r.gameId,
                savedAt: r.savedAt,
                round: r.state.game.currentRound,
                phase: r.state.game.gamePhase,
                players: r.state.players.map(p => p.userName),
            })));
            req.onerror = (e) => reject(e.target.error);
        });
    },
};
