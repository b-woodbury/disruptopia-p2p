// Disruptopia P2P - WebRTC peer connection layer (PeerJS)
//
// Star topology: host is the source of truth and fans out messages to all
// joiners. Joiners only talk to host. Both ends are real browsers — no
// server holds game state, just the public PeerJS broker mediates the
// initial WebRTC handshake (data is end-to-end encrypted via DTLS).
//
// Peer IDs:
//   Host:    "disruptopia-<ROOMCODE>-host"
//   Joiners: ephemeral random IDs assigned by the broker
//
// Public API:
//   Peer.host(roomCode, hello)             -> opens broker registration as host
//   Peer.join(roomCode, hello)             -> connects to host's peer ID
//   Peer.send(msg)                         -> broadcast (host fans out; joiner sends to host)
//   Peer.onMessage = (msg, fromPeerId) => {}
//   Peer.onPeerJoined = (peerId, hello) => {}    // host only
//   Peer.onPeerLeft = (peerId) => {}             // host only
//   Peer.onConnected = () => {}
//   Peer.onDisconnected = () => {}
//   Peer.disconnect()
//
// All messages are JSON-serializable. The transport doesn't interpret
// them — game-level semantics (action kinds, hashes, etc.) live in
// network/relay-client.js (which wraps this module for app.js).

const Peer_ = (typeof window !== 'undefined' && window.Peer)  // PeerJS global
    ? window.Peer
    : null;

const Peer = {
    role: null,             // 'host' | 'join'
    roomCode: null,
    peer: null,             // PeerJS instance
    conns: [],              // host: all incoming conns; joiner: [hostConn]
    hostConn: null,         // joiner's connection to host
    helloPayload: null,     // small intro packet sent on every new conn

    onMessage: null,
    onPeerJoined: null,
    onPeerLeft: null,
    onConnected: null,
    onDisconnected: null,
    onError: null,

    _hostPeerId(roomCode) {
        // Broker namespace is shared with all PeerJS users — disruptopia
        // prefix lowers collision risk to negligible.
        return `disruptopia-${roomCode}-host`;
    },

    async host(roomCode, hello) {
        if (!Peer_) throw new Error("PeerJS library not loaded.");
        this._reset();
        this.role = 'host';
        this.roomCode = roomCode;
        this.helloPayload = hello;
        const hostId = this._hostPeerId(roomCode);
        this.peer = new Peer_(hostId, {debug: 1});
        return new Promise((resolve, reject) => {
            const onOpen = () => {
                this.peer.off('error', onErr);
                if (this.onConnected) this.onConnected();
                resolve({hostId});
            };
            const onErr = (err) => {
                this.peer.off('open', onOpen);
                reject(err);
            };
            this.peer.once('open', onOpen);
            this.peer.once('error', onErr);
            this.peer.on('connection', (conn) => this._acceptIncoming(conn));
            this.peer.on('disconnected', () => {
                // Auto-reconnect to broker (data channels survive briefly).
                try { this.peer.reconnect(); } catch (e) {}
            });
        });
    },

    async join(roomCode, hello) {
        if (!Peer_) throw new Error("PeerJS library not loaded.");
        this._reset();
        this.role = 'join';
        this.roomCode = roomCode;
        this.helloPayload = hello;
        this.peer = new Peer_({debug: 1});
        return new Promise((resolve, reject) => {
            this.peer.once('open', () => {
                // Default 'binary' serialization auto-chunks messages,
                // which we need because the host's initial state snapshot
                // (cardDefinitions + components) exceeds the 16KB SCTP
                // single-message limit.
                const conn = this.peer.connect(this._hostPeerId(roomCode), {
                    reliable: true,
                });
                let resolved = false;
                conn.on('open', () => {
                    this.hostConn = conn;
                    this.conns = [conn];
                    if (hello) conn.send({type: '__hello__', payload: hello});
                    if (this.onConnected) this.onConnected();
                    resolved = true;
                    resolve({hostId: conn.peer});
                });
                conn.on('data', (msg) => this._dispatch(msg, conn.peer));
                conn.on('close', () => {
                    this.hostConn = null;
                    if (this.onDisconnected) this.onDisconnected();
                });
                conn.on('error', (err) => {
                    if (!resolved) reject(err);
                    if (this.onError) this.onError(err);
                });
                // Hard timeout — if the host peer ID isn't registered, the
                // broker errors quickly; otherwise we'll never see 'open'.
                setTimeout(() => {
                    if (!resolved) reject(new Error("Connect to host timed out (host may not be online)."));
                }, 15000);
            });
            this.peer.once('error', (err) => reject(err));
        });
    },

    _acceptIncoming(conn) {
        // Host side: a joiner just connected.
        conn.on('open', () => {
            this.conns.push(conn);
        });
        conn.on('data', (msg) => {
            if (msg && msg.type === '__hello__') {
                if (this.onPeerJoined) this.onPeerJoined(conn.peer, msg.payload);
                return;
            }
            this._dispatch(msg, conn.peer);
            // Host fans out to all OTHER joiners so they see each other's actions.
            for (const other of this.conns) {
                if (other === conn) continue;
                if (other.open) other.send(msg);
            }
        });
        conn.on('close', () => {
            this.conns = this.conns.filter(c => c !== conn);
            if (this.onPeerLeft) this.onPeerLeft(conn.peer);
        });
        conn.on('error', (err) => {
            if (this.onError) this.onError(err);
        });
    },

    _dispatch(msg, fromPeerId) {
        if (this.onMessage) {
            try { this.onMessage(msg, fromPeerId); }
            catch (e) { console.error('Peer.onMessage handler threw:', e); }
        }
    },

    send(msg) {
        if (this.role === 'host') {
            for (const c of this.conns) {
                if (c.open) c.send(msg);
            }
        } else if (this.role === 'join' && this.hostConn && this.hostConn.open) {
            this.hostConn.send(msg);
        }
    },

    isConnected() {
        if (this.role === 'host') return !!this.peer && !this.peer.destroyed;
        if (this.role === 'join') return !!this.hostConn && this.hostConn.open;
        return false;
    },

    peerCount() {
        return this.conns.length;
    },

    disconnect() {
        try {
            for (const c of this.conns) try { c.close(); } catch (e) {}
            if (this.peer) try { this.peer.destroy(); } catch (e) {}
        } finally {
            this._reset();
        }
    },

    _reset() {
        this.role = null;
        this.roomCode = null;
        this.peer = null;
        this.conns = [];
        this.hostConn = null;
    },

    // ── Room code generator (10 chars, ~50 bits entropy) ────────────
    generateRoomCode() {
        // Avoid look-alike characters (0/O, 1/I/L) for share-by-voice friendliness.
        const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
        const out = new Array(10);
        const buf = new Uint32Array(10);
        crypto.getRandomValues(buf);
        for (let i = 0; i < 10; i++) out[i] = chars[buf[i] % chars.length];
        return out.join('');
    },
};
