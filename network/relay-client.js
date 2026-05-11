// Disruptopia P2P - Game-level peer messaging layer.
//
// Wraps the WebRTC transport (network/peer.js) and exposes the same
// `Relay` symbol the rest of the app was already using. Game messages
// flow:
//
//   broadcastAction({kind, args})  →  send({t:'action', a:...})
//   pushStateHash(hash)            →  send({t:'state_hash', h:..., round:..., pid:...})
//   onActionReceived(wrapped)  ← incoming {t:'action'} from any other peer
//   onStateHashMismatch(info)  ← when our hash != peer's for same round
//
// The transport is now true peer-to-peer over WebRTC data channels. No
// HTTP polling — everything is push.

const Relay = {
    gameCode: null,
    playerId: null,
    role: null,           // 'host' | 'join' | null
    connected: false,
    _myStateHash: null,   // {round, hash}
    _peerHashes: {},      // peerKey → {round, hash}

    // Compatibility callbacks (preserved from the HTTP-relay era so
    // app.js can keep its existing wiring).
    onActionReceived: null,         // (wrapped) => {}
    onPlayerJoined: null,           // ({playerId, peerId, ...hello}) => {}
    onPlayerLeft: null,             // (peerId) => {}
    onStateHashMismatch: null,      // ({round, mine, theirs, peerId}) => {}
    onSnapshotRequest: null,        // (peerId, fn) => {}  -- host should call fn(state)
    onSnapshot: null,               // (state) => {}        -- joiner receives host's snapshot

    // ── Configuration ──────────────────────────────────────────────
    // Kept (no-op for legacy callers); the URL arg is ignored — we use
    // PeerJS Cloud as the public signaling broker.
    configure(_unused, gameCode, playerId) {
        this.gameCode = gameCode;
        this.playerId = playerId;
    },

    generateGameCode() {
        return Peer.generateRoomCode();
    },

    // ── Host opens a room ──────────────────────────────────────────
    async createRoom(gameState) {
        if (!this.gameCode) return {error: "No room code"};
        this._installPeerCallbacks();
        try {
            const info = await Peer.host(this.gameCode, {role: 'host', playerId: this.playerId});
            this.role = 'host';
            this.connected = true;
            return {ok: true, hostId: info.hostId};
        } catch (e) {
            const msg = (e && e.type === 'unavailable-id')
                ? 'Room code is already in use (or a previous host is still registered). Try a new code.'
                : (e && e.message) || String(e);
            return {error: msg};
        }
    },

    // ── Joiner connects to the host ────────────────────────────────
    async joinRoom() {
        if (!this.gameCode) return {error: "No room code"};
        this._installPeerCallbacks();
        try {
            const info = await Peer.join(this.gameCode, {role: 'join', playerId: this.playerId});
            this.role = 'join';
            this.connected = true;
            // Request the host's current state snapshot for bootstrap.
            return new Promise((resolve) => {
                const waitMs = 15000;
                const t0 = Date.now();
                const handler = (msg) => {
                    if (msg && msg.t === 'snapshot') {
                        Relay.onSnapshot && Relay.onSnapshot(msg.s);
                        resolve({ok: true, state: msg.s});
                    }
                };
                // Snapshot will be delivered via onMessage → _route below;
                // we stash a one-shot promise resolver.
                this._pendingSnapshot = handler;
                Peer.send({t: 'request_snapshot', pid: this.playerId});
                const poll = setInterval(() => {
                    if (Date.now() - t0 > waitMs) {
                        clearInterval(poll);
                        if (this._pendingSnapshot === handler) {
                            this._pendingSnapshot = null;
                            resolve({error: 'No snapshot from host (timed out)'});
                        }
                    }
                }, 250);
            });
        } catch (e) {
            return {error: (e && e.message) || String(e)};
        }
    },

    _installPeerCallbacks() {
        Peer.onMessage = (msg, fromPeerId) => this._route(msg, fromPeerId);
        Peer.onPeerJoined = (peerId, hello) => {
            if (this.onPlayerJoined) this.onPlayerJoined({peerId, ...(hello || {})});
        };
        Peer.onPeerLeft = (peerId) => {
            if (this.onPlayerLeft) this.onPlayerLeft(peerId);
            delete this._peerHashes[peerId];
        };
        Peer.onDisconnected = () => { this.connected = false; };
        Peer.onError = (err) => { /* surfaced at call sites */ };
    },

    _route(msg, fromPeerId) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'action') {
            if (this.onActionReceived) {
                this.onActionReceived({playerId: msg.pid, action: msg.a});
            }
            return;
        }
        if (msg.t === 'state_hash') {
            this._peerHashes[fromPeerId] = {round: msg.round, hash: msg.h};
            this._checkHash(fromPeerId);
            return;
        }
        if (msg.t === 'request_snapshot') {
            if (this.role === 'host' && this.onSnapshotRequest) {
                this.onSnapshotRequest(fromPeerId, (state) => {
                    Peer.send({t: 'snapshot', s: state, target: fromPeerId});
                });
            }
            return;
        }
        if (msg.t === 'snapshot') {
            if (this._pendingSnapshot) {
                const h = this._pendingSnapshot;
                this._pendingSnapshot = null;
                h(msg);
            } else if (this.onSnapshot) {
                this.onSnapshot(msg.s);
            }
            return;
        }
    },

    _checkHash(peerId) {
        if (!this._myStateHash) return;
        const theirs = this._peerHashes[peerId];
        if (!theirs) return;
        if (theirs.round !== this._myStateHash.round) return;
        if (theirs.hash === this._myStateHash.hash) return;
        if (this.onStateHashMismatch) {
            this.onStateHashMismatch({
                round: theirs.round,
                mine: this._myStateHash.hash,
                theirs: theirs.hash,
                peerId,
            });
        }
    },

    // ── Game-level send helpers ────────────────────────────────────
    sendAction(action) {
        if (!this.connected) return {status: 'offline'};
        Peer.send({t: 'action', pid: this.playerId, a: action});
        return {status: 'sent'};
    },

    pushStateHash(round, hash) {
        this._myStateHash = {round, hash};
        if (!this.connected) return;
        Peer.send({t: 'state_hash', pid: this.playerId, round, h: hash});
        // Re-check against any peer hashes already received.
        for (const peerId of Object.keys(this._peerHashes)) this._checkHash(peerId);
    },

    // ── Compatibility shims for the previous HTTP-relay API ─────────
    // These are kept so callers that haven't been migrated can still
    // compile. They're now no-ops or no-op-equivalents.
    startPolling(_ms) { /* no-op: WebRTC is push, not poll */ },
    stopPolling() { /* no-op */ },

    pushState(_state) { /* no-op: full-state push replaced by hash + snapshot-on-request */ },

    // For joiner reconnect via Persistence: ask the host for a fresh snapshot.
    async getLatestState() {
        if (!this.connected || this.role !== 'join') return null;
        return new Promise((resolve) => {
            const handler = (msg) => resolve(msg.s);
            this._pendingSnapshot = handler;
            Peer.send({t: 'request_snapshot', pid: this.playerId});
            setTimeout(() => {
                if (this._pendingSnapshot === handler) {
                    this._pendingSnapshot = null;
                    resolve(null);
                }
            }, 10000);
        });
    },

    disconnect() {
        Peer.disconnect();
        this.connected = false;
        this.role = null;
        this._peerHashes = {};
        this._myStateHash = null;
    },
};
