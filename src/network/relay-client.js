export class RelayClient {
  constructor() {
    this.url = localStorage.getItem("splob.relayUrl") || window.SPLOB_RELAY_URL || "";
    this.socket = null;
    this.id = null;
    this.queue = [];
    this.connecting = false;
    this.connectTimeout = null;
    this.onStatus = null;
    this.onLobbies = null;
    this.onLobby = null;
    this.onGameStart = null;
    this.onGameEvent = null;
    this.onJoined = null;
    this.onMatchStart = null;
    this.onSnapshot = null;
    this.onPaintBatch = null;
    this.onScoreUpdate = null;
    this.onGameOver = null;
    this.onPlayAgainUpdate = null;
    this.onPlayAgainAlone = null;
    this.onInviteChallenge = null;
    this.onInviteUnavailable = null;
    this.onInviteSent = null;
    this.onInviteDeclined = null;
    this.onProfileStatuses = null;
    this.onServerError = null;
    this.onJoinError = null;
    this.onKicked = null;
    this.onGameError = null;
  }

  connect() {
    if (!this.url) {
      this.onStatus?.({ state: "missing-url", message: "Multiplayer is not configured yet. Add SPLOB_RELAY_URL in Netlify." });
      return false;
    }
    if (this.socket?.readyState === WebSocket.OPEN) return true;
    if (this.connecting && this.socket?.readyState === WebSocket.CONNECTING) return true;
    try {
      this.connecting = true;
      this.onStatus?.({ state: "connecting", message: "Connecting to multiplayer. This can take up to 60 seconds if the relay is waking up." });
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener("open", () => {
        this.connecting = false;
        window.clearTimeout(this.connectTimeout);
        this.onStatus?.({ state: "connected", message: "Connected to multiplayer." });
        this.flush();
        this.send({ type: "lobbies:list" });
      });
      this.socket.addEventListener("message", (event) => this.receive(JSON.parse(event.data)));
      this.socket.addEventListener("error", () => {
        this.connecting = false;
        window.clearTimeout(this.connectTimeout);
        this.onStatus?.({ state: "error", message: "Could not reach the multiplayer relay. Check the Render service URL and that the service is running." });
      });
      this.socket.addEventListener("close", () => {
        const wasConnecting = this.connecting;
        this.connecting = false;
        window.clearTimeout(this.connectTimeout);
        if (wasConnecting) {
          this.onStatus?.({ state: "error", message: "The multiplayer relay did not respond. Render may still be waking up, or the relay URL is incorrect." });
        } else {
          this.onStatus?.({ state: "closed", message: "Disconnected from multiplayer." });
        }
      });
      this.connectTimeout = window.setTimeout(() => {
        if (this.socket?.readyState === WebSocket.CONNECTING) {
          this.socket.close();
          this.onStatus?.({ state: "error", message: "The multiplayer relay took longer than 60 seconds to respond." });
        }
      }, 60000);
      return true;
    } catch {
      this.connecting = false;
      window.clearTimeout(this.connectTimeout);
      this.socket = null;
      this.onStatus?.({ state: "error", message: "Could not open a multiplayer connection." });
      return false;
    }
  }

  receive(message) {
    if (message.type === "hello") this.id = message.id;
    if (message.type === "lobbies") this.onLobbies?.(message.lobbies);
    if (message.type === "lobby") {
      message.lobby.players = message.lobby.players.map((player) => ({ ...player, local: player.socketId === this.id }));
      this.onLobby?.(message.lobby);
    }
    if (message.type === "game:start") {
      message.config.players = (message.config.players || []).map((player) => ({ ...player, local: player.socketId === this.id }));
      message.config.syncedSimulation = true;
      this.onGameStart?.(message.config);
    }
    if (message.type === "joined") this.onJoined?.(message);
    if (message.type === "match:start") {
      const config = {
        ...(message.config || {}),
        mode: "multiplayer",
        authoritative: true,
        localSocketId: this.id,
        matchId: message.matchId,
        startAt: message.startAt,
        players: (message.players || message.config?.players || []).map((player) => ({ ...player, local: player.socketId === this.id }))
      };
      this.onMatchStart?.({ ...message, config });
      this.onGameStart?.(config);
    }
    if (message.type === "snapshot") this.onSnapshot?.(message);
    if (message.type === "paintBatch") this.onPaintBatch?.(message);
    if (message.type === "scoreUpdate") this.onScoreUpdate?.(message);
    if (message.type === "gameOver") this.onGameOver?.(message);
    if (message.type === "playAgain:update") this.onPlayAgainUpdate?.(message);
    if (message.type === "playAgain:alone") this.onPlayAgainAlone?.(message);
    if (message.type === "inviteChallenge") this.onInviteChallenge?.(message);
    if (message.type === "inviteUnavailable") this.onInviteUnavailable?.(message.reason);
    if (message.type === "inviteSent") this.onInviteSent?.(message);
    if (message.type === "inviteDeclined") this.onInviteDeclined?.(message);
    if (message.type === "profileStatuses") this.onProfileStatuses?.(message.statuses || {});
    if (message.type === "serverError") this.onServerError?.(message);
    if (message.type === "game:event") this.onGameEvent?.(message.event);
    if (message.type === "join:error") this.onJoinError?.(message.reason);
    if (message.type === "lobby:kicked") this.onKicked?.();
    if (message.type === "game:error") this.onGameError?.(message.reason);
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return true;
    }
    if (!this.url) {
      this.onStatus?.({ state: "missing-url", message: "Multiplayer is not configured yet. Add SPLOB_RELAY_URL in Netlify." });
      return false;
    }
    this.queue.push(message);
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) this.connect();
    return true;
  }

  flush() {
    const queued = this.queue.splice(0);
    queued.forEach((message) => this.send(message));
  }
}
