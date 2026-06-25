import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  ACCELERATION_PER_SECOND,
  ARENA_HEIGHT,
  ARENA_WIDTH,
  BODY_HALF_HEIGHT,
  BODY_HALF_WIDTH,
  COLOR_ORDER,
  DECELERATION_PER_SECOND,
  GAME_SECONDS,
  MAX_MOVE_SPEED,
  PAINT_BATCH_RATE,
  PLAYER_COLORS,
  PLAYER_RADIUS,
  SCORE_GRID_HEIGHT,
  SCORE_GRID_WIDTH,
  SCORE_UPDATE_RATE,
  SERVER_TICK_RATE,
  SNAPSHOT_RATE
} from "../src/shared/game-constants.js";

const port = Number(process.env.PORT || 8787);
const tickMs = 1000 / SERVER_TICK_RATE;
const snapshotEvery = Math.max(1, Math.round(SERVER_TICK_RATE / SNAPSHOT_RATE));
const paintEvery = Math.max(1, Math.round(SERVER_TICK_RATE / PAINT_BATCH_RATE));
const scoreEvery = Math.max(1, Math.round(SERVER_TICK_RATE / SCORE_UPDATE_RATE));
const countdownMs = 3400;
const powerRadius = 56;
const maxPowerUps = 5;
const powerIds = ["boost", "grow", "messy", "splat", "shield", "paintball", "slow", "shrink", "reverse", "freeze", "banana", "spiky"];
const placePowerBands = [
  { place: 1, powers: ["shield", "banana"] },
  { place: 2, powers: ["reverse", "messy", "spiky", "paintball"] },
  { place: 3, powers: ["splat", "boost", "shrink"] },
  { place: 4, powers: ["freeze", "grow", "slow"] }
];
const placePowerWeights = [0.7, 0.18, 0.08, 0.04];
const wallSpeedRetain = 0.75;
const bounceMs = 800;
const bumpGraceMs = 5000;
const bounceSpeed = 444;
const bounceDistance = PLAYER_RADIUS * 0.8;
const projectileSpeed = 1140;
const paintballProjectileRadius = PLAYER_RADIUS * 0.3;
const bananaProjectileLength = 75;
const bananaProjectileWidth = 30;
const spikyProjectileRadius = 45;
const spikyProjectileSpikeRadius = spikyProjectileRadius * 1.28;

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "splob-authoritative-server" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Splob authoritative server is awake.");
});

const wss = new WebSocketServer({ server });
const clients = new Map();
const lobbies = new Map();
const matches = new Map();

wss.on("connection", (socket) => {
  const id = randomUUID();
  clients.set(id, { id, socket, lobbyCode: null, matchId: null });
  socket.send(JSON.stringify({ type: "hello", id }));
  socket.on("message", (raw) => {
    try {
      handle(id, JSON.parse(raw));
    } catch (error) {
      send(id, { type: "serverError", message: "Malformed message." });
    }
  });
  socket.on("close", () => {
    const client = clients.get(id);
    if (client?.matchId) markDisconnected(id, client.matchId);
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
  if (message.type === "game:start") return startGame(id);
  if (message.type === "ready") return setReady(id, true);
  if (message.type === "input") return receiveInput(id, message);
  if (message.type === "usePower") return receiveUsePower(id, message);
}

function createLobby(id, message) {
  const code = uniqueCode();
  const lobby = {
    code,
    hostId: id,
    public: Boolean(message.public),
    players: [normalizeLobbyPlayer(message.player, id, 0)]
  };
  lobbies.set(code, lobby);
  clients.get(id).lobbyCode = code;
  send(id, { type: "lobby", lobby });
  broadcastLobbies();
}

function joinLobby(id, code, player) {
  const lobby = lobbies.get(code);
  if (!lobby || lobby.players.length >= 4 || lobby.started) return send(id, { type: "join:error", reason: "not-found" });
  const used = new Set(lobby.players.map((item) => item.color));
  const preferred = COLOR_ORDER.includes(player?.color) ? player.color : COLOR_ORDER[0];
  const color = used.has(preferred) ? COLOR_ORDER.find((item) => !used.has(item)) : preferred;
  lobby.players.push(normalizeLobbyPlayer({ ...player, color }, id, lobby.players.length));
  clients.get(id).lobbyCode = code;
  broadcastLobby(lobby);
  broadcastLobbies();
}

function normalizeLobbyPlayer(player = {}, socketId, index) {
  const fallbackColor = COLOR_ORDER[index % COLOR_ORDER.length];
  return {
    id: player.id || player.profileId || socketId,
    profileId: player.profileId,
    hash: player.hash,
    name: String(player.name || player.username || "Guest").slice(0, 24),
    color: COLOR_ORDER.includes(player.color) ? player.color : fallbackColor,
    socketId,
    ready: false,
    local: false
  };
}

function updateLobby(id, nextLobby) {
  const code = clients.get(id)?.lobbyCode || nextLobby?.code;
  const lobby = lobbies.get(code);
  if (!lobby || lobby.started) return;
  if (id === lobby.hostId) lobby.public = Boolean(nextLobby.public);
  const incoming = nextLobby.players?.find((player) => player.socketId === id || player.local);
  const player = lobby.players.find((item) => item.socketId === id);
  if (player && incoming) {
    player.ready = Boolean(incoming.ready);
    if (COLOR_ORDER.includes(incoming.color) && !lobby.players.some((item) => item.socketId !== id && item.color === incoming.color)) {
      player.color = incoming.color;
    }
  }
  broadcastLobby(lobby);
  broadcastLobbies();
}

function setReady(id, ready) {
  const lobby = lobbies.get(clients.get(id)?.lobbyCode);
  const player = lobby?.players.find((item) => item.socketId === id);
  if (!player || lobby.started) return;
  player.ready = Boolean(ready);
  broadcastLobby(lobby);
  broadcastLobbies();
}

function kickPlayer(id, playerId) {
  const lobby = lobbies.get(clients.get(id)?.lobbyCode);
  if (!lobby || lobby.hostId !== id || lobby.started) return;
  const kicked = lobby.players.find((player) => String(player.socketId) === String(playerId) || String(player.id) === String(playerId));
  if (!kicked || kicked.socketId === id) return;
  send(kicked.socketId, { type: "lobby:kicked" });
  clients.get(kicked.socketId).lobbyCode = null;
  lobby.players = lobby.players.filter((player) => player.socketId !== kicked.socketId);
  broadcastLobby(lobby);
  broadcastLobbies();
}

function startGame(id) {
  const lobby = lobbies.get(clients.get(id)?.lobbyCode);
  if (!lobby || lobby.hostId !== id || lobby.started) return;
  if (lobby.players.length < 2) {
    send(id, { type: "game:error", reason: "not-enough-players" });
    return;
  }
  if (lobby.players.some((player) => !player.ready)) {
    send(id, { type: "game:error", reason: "not-ready" });
    return;
  }
  lobby.started = true;
  lobby.public = false;
  const match = createMatch(lobby);
  matches.set(match.id, match);
  lobby.matchId = match.id;
  for (const player of lobby.players) {
    const client = clients.get(player.socketId);
    if (client) client.matchId = match.id;
    send(player.socketId, {
      type: "joined",
      playerId: player.id,
      socketId: player.socketId,
      matchId: match.id,
      serverTick: match.tick,
      matchConfig: matchConfig()
    });
  }
  broadcastMatch(match, {
    type: "match:start",
    matchId: match.id,
    serverTick: match.tick,
    startAt: match.startsAt,
    players: serializePlayers(match),
    config: { mode: "multiplayer", authoritative: true, players: serializePlayers(match), ...matchConfig() }
  });
  match.interval = setInterval(() => tickMatch(match.id), tickMs);
  broadcastLobbies();
}

function createMatch(lobby) {
  const now = Date.now();
  const playerIds = new Map();
  const players = lobby.players.map((item, index) => {
    const spawn = cornerForIndex(index);
    const playerId = uniquePlayerId(item.id, playerIds);
    playerIds.set(playerId, true);
    return {
      id: playerId,
      socketId: item.socketId,
      profileId: item.profileId,
      name: item.name,
      color: item.color,
      x: spawn.x,
      y: spawn.y,
      spawnX: spawn.x,
      spawnY: spawn.y,
      spawnAngle: spawn.angle,
      vx: 0,
      vy: 0,
      angle: spawn.angle,
      connected: true,
      score: 0,
      spawnIndex: index,
      lastPaintTick: -99,
      power: null,
      effects: {},
      shieldUntil: 0,
      lastPowerSeq: 0,
      rollingPower: null,
      rollEndsAt: 0,
      deadUntil: 0,
      bounceUntil: 0,
      bounceMoveUntil: 0,
      bounceInvulnerableUntil: 0,
      bounceVx: 0,
      bounceVy: 0,
      lastCollisionAt: 0
    };
  });
  return {
    id: randomUUID(),
    lobbyCode: lobby.code,
    players,
    inputs: new Map(players.map((player) => [player.socketId, emptyInput()])),
    tick: 0,
    createdAt: now,
    startsAt: now + countdownMs,
    startedAt: now + countdownMs,
    durationMs: GAME_SECONDS * 1000,
    ended: false,
    powerUps: [],
    projectiles: [],
    nextPowerSpawnAt: now + countdownMs + scaledPowerDelay(lobby.players.length, 1200),
    paintQueue: [],
    scoreGrid: new Uint16Array(SCORE_GRID_WIDTH * SCORE_GRID_HEIGHT),
    scoreCounts: new Map(players.map((player) => [player.id, 0])),
    paintedCells: 0,
    interval: null
  };
}

function uniquePlayerId(id, used) {
  const base = String(id || randomUUID());
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function receiveInput(id, message) {
  const match = matches.get(clients.get(id)?.matchId);
  if (!match || match.ended) return;
  const previous = match.inputs.get(id) || emptyInput();
  match.inputs.set(id, {
    seq: Number(message.seq || 0),
    keys: normalizeInputKeys(message.keys),
    clientTime: Number(message.clientTime || 0),
    usePowerSeq: previous.usePowerSeq
  });
}

function receiveUsePower(id, message) {
  const match = matches.get(clients.get(id)?.matchId);
  if (!match || match.ended) return;
  const input = match.inputs.get(id) || emptyInput();
  match.inputs.set(id, { ...input, usePowerSeq: Number(message.seq || 0), clientTime: Number(message.clientTime || 0) });
}

function tickMatch(matchId) {
  const match = matches.get(matchId);
  if (!match || match.ended) return;
  const dt = 1 / SERVER_TICK_RATE;
  const now = Date.now();
  match.tick += 1;
  if (now < match.startsAt) {
    if (match.tick % snapshotEvery === 0) broadcastSnapshot(match);
    return;
  }
  if (now > match.nextPowerSpawnAt) spawnPowerUp(match, now);
  for (const player of match.players) {
    if (!player.connected) continue;
    if (player.deadUntil > now) continue;
    if (player.deadUntil) respawnPlayer(player);
    expireEffects(player, now);
    resolveRollingPower(player, now);
    consumePowerUse(match, player, match.inputs.get(player.socketId) || emptyInput(), now);
    movePlayer(player, match.inputs.get(player.socketId) || emptyInput(), dt, now);
    collectPowerUps(match, player, now);
    if (match.tick - player.lastPaintTick >= 2 && (Math.hypot(player.vx, player.vy) > 4 || player.lastPaintTick < 0)) {
      player.lastPaintTick = match.tick;
      addPaintStamp(match, player, PLAYER_RADIUS * playerSizeMultiplier(player, now));
    }
  }
  updateProjectiles(match, now, dt);
  resolveBlobCollisions(match, now);
  if (match.tick % paintEvery === 0) flushPaint(match);
  if (match.tick % scoreEvery === 0) broadcastScore(match);
  if (match.tick % snapshotEvery === 0) broadcastSnapshot(match);
  if (now - match.startedAt >= match.durationMs) finishMatch(match);
}

function respawnPlayer(player) {
  player.deadUntil = 0;
  player.x = player.spawnX;
  player.y = player.spawnY;
  player.angle = player.spawnAngle;
  player.vx = 0;
  player.vy = 0;
  player.effects = {};
  player.shieldUntil = 0;
  clearBounce(player);
}

function movePlayer(player, input, dt, now) {
  const keys = input.keys || emptyInput().keys;
  const xAxis = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const yAxis = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  const slow = player.effects.slowUntil > now ? 0.5 : 1;
  const boost = player.effects.boostUntil > now ? 1.5 : 1;
  const reversed = player.effects.reverseUntil > now;
  const frozen = player.effects.freezeUntil > now;
  const bounceImmune = hasBounceImmunity(player, now);
  if (bounceImmune && player.bounceUntil > now) clearBounce(player);
  const speedLimit = MAX_MOVE_SPEED * slow * boost;
  if (frozen) {
    player.vx = 0;
    player.vy = 0;
  } else if (player.bounceUntil > now && !bounceImmune) {
    player.vx = now < player.bounceMoveUntil ? player.bounceVx : 0;
    player.vy = now < player.bounceMoveUntil ? player.bounceVy : 0;
  } else {
    if (player.bounceUntil && player.bounceUntil <= now) clearBounce(player);
    const targetX = (reversed ? -xAxis : xAxis) * speedLimit;
    const targetY = (reversed ? -yAxis : yAxis) * speedLimit;
    player.vx = approachVelocity(player.vx, targetX, dt);
    player.vy = approachVelocity(player.vy, targetY, dt);
  }
  if (Math.hypot(player.vx, player.vy) > 8) player.angle = Math.atan2(player.vy, player.vx);
  const size = playerSizeMultiplier(player, now);
  const halfWidth = BODY_HALF_WIDTH * size;
  const halfHeight = BODY_HALF_HEIGHT * size;
  const nextX = player.x + player.vx * dt;
  const nextY = player.y + player.vy * dt;
  const clampedX = clamp(nextX, halfWidth, ARENA_WIDTH - halfWidth);
  const clampedY = clamp(nextY, halfHeight, ARENA_HEIGHT - halfHeight);
  if (clampedX !== nextX) player.vx = -player.vx * wallSpeedRetain;
  if (clampedY !== nextY) player.vy = -player.vy * wallSpeedRetain;
  player.x = clampedX;
  player.y = clampedY;
}

function resolveBlobCollisions(match, now) {
  for (let i = 0; i < match.players.length; i += 1) {
    for (let j = i + 1; j < match.players.length; j += 1) {
      const a = match.players[i];
      const b = match.players[j];
      if (!a.connected || !b.connected || a.deadUntil > now || b.deadUntil > now) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const minDistance = PLAYER_RADIUS * 1.55 * (playerSizeMultiplier(a, now) + playerSizeMultiplier(b, now)) * 0.5;
      if (distance >= minDistance) continue;
      const nx = dx / distance;
      const ny = dy / distance;
      const push = (minDistance - distance) / 2;
      a.x = clamp(a.x - nx * push, BODY_HALF_WIDTH, ARENA_WIDTH - BODY_HALF_WIDTH);
      a.y = clamp(a.y - ny * push, BODY_HALF_HEIGHT, ARENA_HEIGHT - BODY_HALF_HEIGHT);
      b.x = clamp(b.x + nx * push, BODY_HALF_WIDTH, ARENA_WIDTH - BODY_HALF_WIDTH);
      b.y = clamp(b.y + ny * push, BODY_HALF_HEIGHT, ARENA_HEIGHT - BODY_HALF_HEIGHT);
      applyBlobBounce(a, b, nx, ny, now);
    }
  }
}

function applyBlobBounce(a, b, nx, ny, now) {
  const aBoosted = hasBounceImmunity(a, now);
  const bBoosted = hasBounceImmunity(b, now);
  const aShielded = hasCollisionGrace(a, now);
  const bShielded = hasCollisionGrace(b, now);
  const aInvulnerable = a.bounceInvulnerableUntil > now;
  const bInvulnerable = b.bounceInvulnerableUntil > now;
  if ((aInvulnerable || bInvulnerable) && !aBoosted && !bBoosted && !aShielded && !bShielded) return;
  if ((aBoosted || aShielded) && !bBoosted && !bShielded) {
    startBounce(b, nx, ny, now);
  } else if ((bBoosted || bShielded) && !aBoosted && !aShielded) {
    startBounce(a, -nx, -ny, now);
  } else {
    const aDir = oppositeTravelDirection(a, -nx, -ny);
    const bDir = oppositeTravelDirection(b, nx, ny);
    startBounce(a, aDir.x, aDir.y, now);
    startBounce(b, bDir.x, bDir.y, now);
  }
  a.lastCollisionAt = now;
  b.lastCollisionAt = now;
}

function startBounce(player, dx, dy, now) {
  if (hasBounceImmunity(player, now) || hasCollisionGrace(player, now)) return;
  const length = Math.hypot(dx, dy) || 1;
  player.bounceVx = (dx / length) * bounceSpeed;
  player.bounceVy = (dy / length) * bounceSpeed;
  player.bounceMoveUntil = now + Math.min(bounceMs, (bounceDistance / bounceSpeed) * 1000);
  player.bounceUntil = now + bounceMs;
  player.bounceInvulnerableUntil = now + bumpGraceMs;
  player.vx = 0;
  player.vy = 0;
}

function clearBounce(player) {
  player.bounceUntil = 0;
  player.bounceMoveUntil = 0;
  player.bounceVx = 0;
  player.bounceVy = 0;
}

function hasCollisionGrace(player, now) {
  return player.shieldUntil > now || (player.bounceInvulnerableUntil > now && player.bounceUntil <= now);
}

function hasBounceImmunity(player, now) {
  return player.shieldUntil > now || player.effects.bounceImmuneUntil > now;
}

function oppositeTravelDirection(player, fallbackX, fallbackY) {
  const speed = Math.hypot(player.vx, player.vy);
  if (speed > 8) return { x: -player.vx / speed, y: -player.vy / speed };
  const fallbackLength = Math.hypot(fallbackX, fallbackY) || 1;
  return { x: fallbackX / fallbackLength, y: fallbackY / fallbackLength };
}

function spawnPowerUp(match, now) {
  if (match.powerUps.length < maxPowerUps) {
    match.powerUps.push({
      id: randomUUID(),
      x: round(powerRadius + 24 + Math.random() * (ARENA_WIDTH - (powerRadius + 24) * 2)),
      y: round(powerRadius + 24 + Math.random() * (ARENA_HEIGHT - (powerRadius + 24) * 2)),
      born: now
    });
  }
  match.nextPowerSpawnAt = now + scaledPowerDelay(match.players.length, 2500 + Math.random() * 2000);
}

function collectPowerUps(match, player, now) {
  const hit = match.powerUps.find((power) => Math.hypot(power.x - player.x, power.y - player.y) <= PLAYER_RADIUS + powerRadius);
  if (!hit) return;
  match.powerUps = match.powerUps.filter((power) => power.id !== hit.id);
  if (player.power || player.rollingPower) return;
  player.rollingPower = choosePower(match, player);
  player.rollEndsAt = now + 3000;
}

function choosePower(match, player) {
  const ranked = [...match.players]
    .map((candidate) => ({ candidate, tieBreaker: Math.random() }))
    .sort((a, b) => (b.candidate.score - a.candidate.score) || (a.tieBreaker - b.tieBreaker))
    .map((entry) => entry.candidate);
  const rankIndex = ranked.findIndex((candidate) => candidate.id === player.id);
  const currentBandIndex = rankIndex === -1 ? placePowerBands.length - 1 : rankIndex;
  const bandOrder = orderedPlaceBands(currentBandIndex);
  const chosenBand = weightedChoice(bandOrder, placePowerWeights);
  const eligibleIds = new Set(chosenBand.powers);
  const eligible = powerIds.filter((power) => eligibleIds.has(power));
  return eligible[(Math.random() * eligible.length) | 0];
}

function orderedPlaceBands(currentIndex) {
  const own = placePowerBands[currentIndex] || placePowerBands[placePowerBands.length - 1];
  const worsePlaces = placePowerBands.slice(currentIndex + 1);
  const betterPlaces = placePowerBands.slice(0, currentIndex).reverse();
  return [own, ...worsePlaces, ...betterPlaces];
}

function weightedChoice(items, weights) {
  const total = items.reduce((sum, _, index) => sum + (weights[index] || 0), 0);
  let roll = Math.random() * total;
  for (let index = 0; index < items.length; index += 1) {
    roll -= weights[index] || 0;
    if (roll <= 0) return items[index];
  }
  return items[items.length - 1];
}

function scaledPowerDelay(playerCount, baseDelay) {
  const scale = playerCount >= 4 ? 1 : playerCount === 3 ? 0.75 : 0.5;
  return baseDelay / scale;
}

function resolveRollingPower(player, now) {
  if (!player.rollingPower || now < player.rollEndsAt) return;
  if (!player.power) player.power = player.rollingPower;
  player.rollingPower = null;
  player.rollEndsAt = 0;
}

function consumePowerUse(match, player, input, now) {
  if (!player.power || player.rollingPower || !input.usePowerSeq || input.usePowerSeq === player.lastPowerSeq) return;
  player.lastPowerSeq = input.usePowerSeq;
  const power = player.power;
  player.power = null;
  if (power === "boost") {
    player.effects.boostUntil = now + 5000;
    player.effects.bounceImmuneUntil = now + 5000;
    return;
  }
  if (power === "grow") {
    player.effects.growUntil = now + 5000;
    player.effects.bounceImmuneUntil = now + 5000;
    return;
  }
  if (power === "messy") {
    player.effects.messyUntil = now + 10000;
    return;
  }
  if (power === "shield") {
    player.shieldUntil = now + 10000;
    return;
  }
  if (power === "splat") {
    addPaintStamp(match, player, PLAYER_RADIUS * 6, { type: "splat" });
    return;
  }
  if (power === "paintball" || power === "banana" || power === "spiky") {
    launchProjectile(match, player, power, now);
    return;
  }
  const opponents = match.players.filter((opponent) => opponent.id !== player.id && opponent.connected && opponent.shieldUntil <= now);
  if (power === "slow") opponents.forEach((opponent) => (opponent.effects.slowUntil = now + 5000));
  if (power === "shrink") opponents.forEach((opponent) => (opponent.effects.shrinkUntil = now + 5000));
  if (power === "reverse") opponents.forEach((opponent) => (opponent.effects.reverseUntil = now + 5000));
  if (power === "freeze") opponents.forEach((opponent) => {
    opponent.effects.freezeUntil = now + 5000;
    opponent.vx = 0;
    opponent.vy = 0;
    clearBounce(opponent);
  });
}

function launchProjectile(match, player, type, now) {
  const hitRadius = projectileSize(type);
  match.projectiles.push({
    id: randomUUID(),
    type,
    owner: player.id,
    color: player.color,
    size: hitRadius,
    x: player.x + Math.cos(player.angle) * (PLAYER_RADIUS + hitRadius),
    y: player.y + Math.sin(player.angle) * (PLAYER_RADIUS + hitRadius),
    vx: Math.cos(player.angle) * projectileSpeed,
    vy: Math.sin(player.angle) * projectileSpeed,
    born: now
  });
}

function updateProjectiles(match, now, dt) {
  match.projectiles = match.projectiles.filter((projectile) => {
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    if (projectile.type === "paintball") {
      addPaintProjectileStamp(match, projectile);
    }
    const edge = projectile.size;
    if (projectile.x < edge) {
      projectile.x = edge;
      projectile.vx = Math.abs(projectile.vx);
    } else if (projectile.x > ARENA_WIDTH - edge) {
      projectile.x = ARENA_WIDTH - edge;
      projectile.vx = -Math.abs(projectile.vx);
    }
    if (projectile.y < edge) {
      projectile.y = edge;
      projectile.vy = Math.abs(projectile.vy);
    } else if (projectile.y > ARENA_HEIGHT - edge) {
      projectile.y = ARENA_HEIGHT - edge;
      projectile.vy = -Math.abs(projectile.vy);
    }
    if (projectile.type === "paintball") return now - projectile.born < 5000;
    const target = match.players.find((player) => player.id !== projectile.owner && projectileHitsPlayer(projectile, player, now));
    if (!target || target.shieldUntil > now) return true;
    if (projectile.type === "banana") {
      target.effects.bananaSlowUntil = now + 3000;
      target.effects.spinUntil = now + 650;
    } else {
      addPaintStamp(match, target, PLAYER_RADIUS * 2.5, { type: "splat", color: target.color });
      killPlayer(target, now);
    }
    return false;
  });
}

function addPaintProjectileStamp(match, projectile) {
  const owner = match.players.find((player) => player.id === projectile.owner);
  if (!owner) return;
  const stamp = {
    playerId: owner.id,
    x: round(projectile.x),
    y: round(projectile.y),
    radius: projectile.size,
    color: projectile.color,
    tick: match.tick
  };
  applyStampToScoreGrid(match, stamp);
  match.paintQueue.push(stamp);
}

function killPlayer(player, now) {
  player.deadUntil = now + 5000;
  player.effects = { splatMessageUntil: now + 5000 };
  player.power = null;
  player.rollingPower = null;
  player.rollEndsAt = 0;
  player.shieldUntil = 0;
  player.vx = 0;
  player.vy = 0;
  clearBounce(player);
}

function expireEffects(player, now) {
  for (const key of Object.keys(player.effects)) {
    if (player.effects[key] <= now) delete player.effects[key];
  }
  if (player.shieldUntil <= now) player.shieldUntil = 0;
}

function playerSizeMultiplier(player, now) {
  const grow = player.effects.growUntil > now ? 1.3 : 1;
  const shrink = player.effects.shrinkUntil > now ? 0.7 : 1;
  return grow * shrink;
}

function addPaintStamp(match, player, radius, options = {}) {
  const stamp = { playerId: player.id, x: round(player.x), y: round(player.y), radius, color: player.color, tick: match.tick, ...options };
  applyStampToScoreGrid(match, stamp);
  match.paintQueue.push(stamp);
}

function applyStampToScoreGrid(match, stamp) {
  const ownerIndex = match.players.findIndex((player) => player.id === stamp.playerId) + 1;
  if (!ownerIndex) return;
  const cellWidth = ARENA_WIDTH / SCORE_GRID_WIDTH;
  const cellHeight = ARENA_HEIGHT / SCORE_GRID_HEIGHT;
  const minX = clamp(Math.floor((stamp.x - stamp.radius) / cellWidth), 0, SCORE_GRID_WIDTH - 1);
  const maxX = clamp(Math.ceil((stamp.x + stamp.radius) / cellWidth), 0, SCORE_GRID_WIDTH - 1);
  const minY = clamp(Math.floor((stamp.y - stamp.radius) / cellHeight), 0, SCORE_GRID_HEIGHT - 1);
  const maxY = clamp(Math.ceil((stamp.y + stamp.radius) / cellHeight), 0, SCORE_GRID_HEIGHT - 1);
  const radiusSq = stamp.radius * stamp.radius;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const cx = (x + 0.5) * cellWidth;
      const cy = (y + 0.5) * cellHeight;
      if ((cx - stamp.x) ** 2 + (cy - stamp.y) ** 2 > radiusSq) continue;
      const index = y * SCORE_GRID_WIDTH + x;
      const previous = match.scoreGrid[index];
      if (previous === ownerIndex) continue;
      if (previous > 0) {
        const previousPlayer = match.players[previous - 1];
        match.scoreCounts.set(previousPlayer.id, Math.max(0, (match.scoreCounts.get(previousPlayer.id) || 0) - 1));
      } else {
        match.paintedCells += 1;
      }
      match.scoreGrid[index] = ownerIndex;
      match.scoreCounts.set(stamp.playerId, (match.scoreCounts.get(stamp.playerId) || 0) + 1);
    }
  }
  updatePlayerScores(match);
}

function updatePlayerScores(match) {
  const painted = Math.max(1, match.paintedCells);
  for (const player of match.players) {
    player.score = (match.scoreCounts.get(player.id) || 0) / painted;
  }
}

function flushPaint(match) {
  if (!match.paintQueue.length) return;
  broadcastMatch(match, { type: "paintBatch", serverTick: match.tick, stamps: match.paintQueue.splice(0) });
}

function broadcastSnapshot(match) {
  broadcastMatch(match, {
    type: "snapshot",
    serverTick: match.tick,
    serverTime: Date.now(),
    players: serializePlayers(match),
    powerUps: serializePowerUps(match),
    projectiles: serializeProjectiles(match),
    timeRemainingMs: timeRemainingMs(match)
  });
}

function broadcastScore(match) {
  updatePlayerScores(match);
  broadcastMatch(match, {
    type: "scoreUpdate",
    serverTick: match.tick,
    scores: match.players.map((player) => ({ playerId: player.id, score: player.score }))
  });
}

function finishMatch(match) {
  if (match.ended) return;
  match.ended = true;
  clearInterval(match.interval);
  flushPaint(match);
  broadcastScore(match);
  updatePlayerScores(match);
  const standings = [...match.players].sort((a, b) => (b.score - a.score) || a.spawnIndex - b.spawnIndex);
  broadcastMatch(match, {
    type: "gameOver",
    winnerPlayerId: standings[0]?.id || null,
    finalScores: standings.map((player) => ({ playerId: player.id, score: player.score }))
  });
  setTimeout(() => cleanupMatch(match.id), 30000).unref?.();
}

function cleanupMatch(matchId) {
  const match = matches.get(matchId);
  if (!match) return;
  clearInterval(match.interval);
  for (const player of match.players) {
    const client = clients.get(player.socketId);
    if (client?.matchId === matchId) client.matchId = null;
  }
  matches.delete(matchId);
}

function markDisconnected(socketId, matchId) {
  const match = matches.get(matchId);
  const player = match?.players.find((item) => item.socketId === socketId);
  if (!player) return;
  player.connected = false;
  match.inputs.set(socketId, emptyInput());
}

function leaveLobby(id, code) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  if (lobby.started) {
    lobby.players = lobby.players.map((player) => player.socketId === id ? { ...player, connected: false } : player);
    return;
  }
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

function broadcastMatch(match, message) {
  for (const player of match.players) send(player.socketId, message);
}

function send(id, message) {
  const socket = clients.get(id)?.socket;
  if (socket?.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function serializePlayers(match) {
  return match.players.map((player) => ({
    id: player.id,
    socketId: player.socketId,
    profileId: player.profileId,
    name: player.name,
    color: player.color,
    x: round(player.x),
    y: round(player.y),
    spawnIndex: player.spawnIndex,
    vx: round(player.vx),
    vy: round(player.vy),
    angle: round(player.angle, 4),
    connected: player.connected,
    score: player.score,
    power: player.power,
    rollingPower: player.rollingPower,
    rollEndsAt: player.rollEndsAt,
    deadUntil: player.deadUntil,
    effects: player.effects,
    shieldUntil: player.shieldUntil,
    bounceUntil: player.bounceUntil,
    bounceMoveUntil: player.bounceMoveUntil
  }));
}

function serializeProjectiles(match) {
  return match.projectiles.map((projectile) => ({
    id: projectile.id,
    type: projectile.type,
    owner: projectile.owner,
    color: projectile.color,
    size: projectile.size,
    x: round(projectile.x),
    y: round(projectile.y),
    vx: round(projectile.vx),
    vy: round(projectile.vy),
    born: projectile.born
  }));
}

function projectileHitsPlayer(projectile, player, now) {
  if (!player.connected || player.deadUntil > now) return false;
  const broadPhase = Math.hypot(player.x - projectile.x, player.y - projectile.y) <= (BODY_HALF_WIDTH * playerSizeMultiplier(player, now)) + projectile.size;
  if (!broadPhase) return false;
  return projectileOutlinePoints(projectile).some((point) => pointInsideBlobOutline(point.x, point.y, player, now))
    || blobOutlinePoints(player, now).some((point) => pointInsideProjectileOutline(point.x, point.y, projectile));
}

function pointInsideBlobOutline(x, y, player, now) {
  const size = playerSizeMultiplier(player, now);
  const localX = x - player.x;
  const localY = y - player.y;
  return (localX / (BODY_HALF_WIDTH * size)) ** 2 + (localY / (BODY_HALF_HEIGHT * size)) ** 2 <= 1;
}

function pointInsideProjectileOutline(x, y, projectile) {
  const angle = Math.atan2(projectile.vy, projectile.vx);
  const dx = x - projectile.x;
  const dy = y - projectile.y;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  if (projectile.type === "banana") {
    return (localX / bananaProjectileLength) ** 2 + (localY / bananaProjectileWidth) ** 2 <= 1;
  }
  return Math.hypot(localX, localY) <= projectile.size;
}

function projectileOutlinePoints(projectile) {
  const angle = Math.atan2(projectile.vy, projectile.vx);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const localPoints = projectile.type === "banana"
    ? [
        [0, 0],
        [bananaProjectileLength, 0],
        [-bananaProjectileLength, 0],
        [0, bananaProjectileWidth],
        [0, -bananaProjectileWidth],
        [bananaProjectileLength * 0.65, bananaProjectileWidth * 0.72],
        [-bananaProjectileLength * 0.65, -bananaProjectileWidth * 0.72]
      ]
    : Array.from({ length: 12 }, (_, index) => {
        const pointAngle = (Math.PI * 2 * index) / 12;
        return [Math.cos(pointAngle) * projectile.size, Math.sin(pointAngle) * projectile.size];
      }).concat([[0, 0]]);
  return localPoints.map(([x, y]) => ({
    x: projectile.x + x * cos - y * sin,
    y: projectile.y + x * sin + y * cos
  }));
}

function blobOutlinePoints(player, now) {
  const size = playerSizeMultiplier(player, now);
  return [
    [0, 0],
    [BODY_HALF_WIDTH * size, 0],
    [-BODY_HALF_WIDTH * size, 0],
    [0, BODY_HALF_HEIGHT * size],
    [0, -BODY_HALF_HEIGHT * size],
    [BODY_HALF_WIDTH * size * 0.72, BODY_HALF_HEIGHT * size * 0.7],
    [-BODY_HALF_WIDTH * size * 0.72, BODY_HALF_HEIGHT * size * 0.7],
    [BODY_HALF_WIDTH * size * 0.62, -BODY_HALF_HEIGHT * size * 0.78],
    [-BODY_HALF_WIDTH * size * 0.62, -BODY_HALF_HEIGHT * size * 0.78]
  ].map(([x, y]) => ({ x: player.x + x, y: player.y + y }));
}

function projectileSize(type) {
  if (type === "paintball") return paintballProjectileRadius;
  if (type === "banana") return bananaProjectileLength;
  return spikyProjectileSpikeRadius;
}

function serializePowerUps(match) {
  return match.powerUps.map((power) => ({
    id: power.id,
    x: power.x,
    y: power.y,
    born: power.born
  }));
}

function matchConfig() {
  return {
    arena: { width: ARENA_WIDTH, height: ARENA_HEIGHT },
    durationMs: GAME_SECONDS * 1000,
    tickRate: SERVER_TICK_RATE,
    colors: PLAYER_COLORS,
    scoreGrid: { width: SCORE_GRID_WIDTH, height: SCORE_GRID_HEIGHT }
  };
}

function timeRemainingMs(match) {
  if (Date.now() < match.startsAt) return match.durationMs;
  return Math.max(0, match.durationMs - (Date.now() - match.startedAt));
}

function normalizeInputKeys(keys) {
  if (Array.isArray(keys)) {
    const set = new Set(keys);
    return {
      up: set.has("KeyW") || set.has("ArrowUp"),
      down: set.has("KeyS") || set.has("ArrowDown"),
      left: set.has("KeyA") || set.has("ArrowLeft"),
      right: set.has("KeyD") || set.has("ArrowRight")
    };
  }
  return {
    up: Boolean(keys?.up),
    down: Boolean(keys?.down),
    left: Boolean(keys?.left),
    right: Boolean(keys?.right)
  };
}

function emptyInput() {
  return { seq: 0, keys: { up: false, down: false, left: false, right: false }, clientTime: 0, usePowerSeq: 0 };
}

function cornerForIndex(index) {
  const xMargin = BODY_HALF_WIDTH + 18;
  const topMargin = BODY_HALF_HEIGHT + 18;
  const bottomMargin = BODY_HALF_HEIGHT + 18;
  const corners = [
    { x: xMargin, y: topMargin, angle: Math.PI * 0.25 },
    { x: ARENA_WIDTH - xMargin, y: topMargin, angle: Math.PI * 0.75 },
    { x: xMargin, y: ARENA_HEIGHT - bottomMargin, angle: -Math.PI * 0.25 },
    { x: ARENA_WIDTH - xMargin, y: ARENA_HEIGHT - bottomMargin, angle: -Math.PI * 0.75 }
  ];
  return corners[index] || corners[0];
}

function approachVelocity(current, target, dt) {
  if (current === target) return current;
  const movingTowardZero = target === 0 || Math.sign(current) !== Math.sign(target);
  const step = (movingTowardZero ? DECELERATION_PER_SECOND : ACCELERATION_PER_SECOND) * dt;
  if (Math.abs(target - current) <= step) return target;
  return current + Math.sign(target - current) * step;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function uniqueCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (lobbies.has(code));
  return code;
}

server.listen(port, () => console.log(`Splob authoritative server listening on ${port}`));
