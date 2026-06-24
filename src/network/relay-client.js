export class RelayClient {
  constructor() {
    this.url = localStorage.getItem("splob.relayUrl") || window.SPLOB_RELAY_URL || "";
    this.socket = null;
    this.id = null;
    this.queue = [];
    this.onLobbies = null;
    this.onLobby = null;
    this.onGameStart = null;
    this.onGameEvent = null;
    this.onJoinError = null;
    this.onKicked = null;
  }

  connect() {
    if (!this.url || this.socket?.readyState === WebSocket.OPEN) return;
    try {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener("open", () => {
        this.flush();
        this.send({ type: "lobbies:list" });
      });
      this.socket.addEventListener("message", (event) => this.receive(JSON.parse(event.data)));
    } catch {
      this.socket = null;
    }
  }

  receive(message) {
    if (message.type === "hello") this.id = message.id;
    if (message.type === "lobbies") this.onLobbies?.(message.lobbies);
    if (message.type === "lobby") {
      message.lobby.players = message.lobby.players.map((player) => ({ ...player, local: player.socketId === this.id }));
      this.onLobby?.(message.lobby);
    }
    if (message.type === "game:start") this.onGameStart?.(message.config);
    if (message.type === "game:event") this.onGameEvent?.(message.event);
    if (message.type === "join:error") this.onJoinError?.(message.reason);
    if (message.type === "lobby:kicked") this.onKicked?.();
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (!this.url) return;
    this.queue.push(message);
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) this.connect();
  }

  flush() {
    const queued = this.queue.splice(0);
    queued.forEach((message) => this.send(message));
  }
}
