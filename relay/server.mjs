import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT || 8787);
const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "splob-relay" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Splob relay is awake.");
});

const wss = new WebSocketServer({ server });
const clients = new Map();
const lobbies = new Map();

wss.on("connection", (socket) => {
  const id = randomUUID();
  clients.set(id, { id, socket, lobbyCode: null });
  socket.send(JSON.stringify({ type: "hello", id }));
  socket.on("message", (raw) => {
    try {
      handle(id, JSON.parse(raw));
    } catch {
      return;
    }
  });
  socket.on("close", () => {
    const client = clients.get(id);
    if (client?.lobbyCode) leaveLobby(id, client.lobbyCode);
    clients.delete(id);
    broadcastLobbies();
  });
});

function handle(id, message) {
  if (message.type === "lobbies:list") return send(id, { type: "lobbies", lobbies: publicLobbies() });
  if (message.type === "lobby:create") return createLobby(id, message);
  if (message.type === "lobby:join") return joinLobby(id, message.code, message.player);
  if (message.type === "lobby:update") return updateLobby(id, message.lobby);
  if (message.type === "lobby:kick") return kickPlayer(id, message.playerId);
  if (message.type === "game:start") return startGame(id, message);
  if (message.type === "game:event") return relayToLobby(id, message);
}

function createLobby(id, message) {
  const code = uniqueCode();
  const lobby = {
    code,
    hostId: id,
    public: Boolean(message.public),
    players: [{ ...message.player, socketId: id, ready: false, local: false }]
  };
  lobbies.set(code, lobby);
  clients.get(id).lobbyCode = code;
  send(id, { type: "lobby", lobby });
  broadcastLobbies();
}

function joinLobby(id, code, player) {
  const lobby = lobbies.get(code);
  if (!lobby || lobby.players.length >= 4) return send(id, { type: "join:error", reason: "not-found" });
  const used = new Set(lobby.players.map((item) => item.color));
  const color = used.has(player.color) ? ["cyan", "magenta", "yellow", "green"].find((item) => !used.has(item)) : player.color;
  lobby.players.push({ ...player, color, socketId: id, ready: false, local: false });
  clients.get(id).lobbyCode = code;
  broadcastLobby(lobby);
  broadcastLobbies();
}

function updateLobby(id, nextLobby) {
  const code = clients.get(id)?.lobbyCode || nextLobby?.code;
  const lobby = lobbies.get(code);
  if (!lobby) return;
  if (id === lobby.hostId) lobby.public = Boolean(nextLobby.public);
  const incoming = nextLobby.players?.find((player) => player.socketId === id || player.local);
  const player = lobby.players.find((item) => item.socketId === id);
  if (player && incoming) {
    player.ready = Boolean(incoming.ready);
    if (!lobby.players.some((item) => item.socketId !== id && item.color === incoming.color)) player.color = incoming.color;
  }
  broadcastLobby(lobby);
  broadcastLobbies();
}

function kickPlayer(id, playerId) {
  const lobby = lobbies.get(clients.get(id)?.lobbyCode);
  if (!lobby || lobby.hostId !== id) return;
  const kicked = lobby.players.find((player) => String(player.socketId) === String(playerId) || String(player.id) === String(playerId));
  if (!kicked || kicked.socketId === id) return;
  send(kicked.socketId, { type: "lobby:kicked" });
  clients.get(kicked.socketId).lobbyCode = null;
  lobby.players = lobby.players.filter((player) => player.socketId !== kicked.socketId);
  broadcastLobby(lobby);
  broadcastLobbies();
}

function startGame(id, message) {
  const lobby = lobbies.get(clients.get(id)?.lobbyCode);
  if (!lobby || lobby.hostId !== id) return;
  if (lobby.players.some((player) => !player.ready)) {
    send(id, { type: "game:error", reason: "not-ready" });
    return;
  }
  lobby.started = true;
  lobby.public = false;
  const config = {
    ...(message.config || {}),
    mode: "multiplayer",
    seed: randomUUID(),
    startAt: Date.now() + 1800,
    protocol: 2,
    players: lobby.players.map((player) => ({ ...player, local: false }))
  };
  relayToLobby(id, { type: "game:start", config });
  broadcastLobbies();
}

function relayToLobby(id, message) {
  const lobby = lobbies.get(clients.get(id)?.lobbyCode);
  if (!lobby) return;
  if (message.type === "game:event") message.event = { ...(message.event || {}), serverAt: Date.now() };
  for (const player of lobby.players) send(player.socketId, message);
}

function leaveLobby(id, code) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  lobby.players = lobby.players.filter((player) => player.socketId !== id);
  if (!lobby.players.length || lobby.hostId === id) lobbies.delete(code);
  else broadcastLobby(lobby);
}

function broadcastLobby(lobby) {
  for (const player of lobby.players) send(player.socketId, { type: "lobby", lobby });
}

function broadcastLobbies() {
  const payload = { type: "lobbies", lobbies: publicLobbies() };
  for (const client of clients.values()) {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(payload));
  }
}

function publicLobbies() {
  return [...lobbies.values()]
    .filter((lobby) => lobby.public && !lobby.started && lobby.players.length < 4)
    .map((lobby) => ({ code: lobby.code, host: lobby.players[0]?.name || "Host", players: lobby.players.length, capacity: 4 }));
}

function send(id, message) {
  const socket = clients.get(id)?.socket;
  if (socket?.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function uniqueCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (lobbies.has(code));
  return code;
}

server.listen(port, () => console.log(`Splob relay listening on ${port}`));
