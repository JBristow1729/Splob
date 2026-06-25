import { AI_NAMES, COLOR_ORDER, COUNTDOWN_LABELS, GAME_SECONDS, PLAYER_COLORS, POWER_UPS } from "../config.js";
import { Sound } from "../audio/sound.js";

const radius = 72;
const baseSpeed = 296;
const maxMoveSpeed = baseSpeed * 2;
// Movement tuning note:
// - acceleration starts at 0 and reaches maxMoveSpeed in roughly 0.77s per axis
// - released axes decelerate 80% faster than acceleration
// - current acceleration/deceleration are 30% above the previous tuned values
// - wall hits reflect the relevant axis and keep 75% of that axis speed
// - blob hits zero normal movement and use a short knockback, then immobilise
// Keep these constants together if the movement feel needs to be reverted or tuned.
const accelerationPerSecond = (maxMoveSpeed / 2.5) * 2.5 * 1.3;
const decelerationPerSecond = accelerationPerSecond * 1.8;
const wallSpeedRetain = 0.75;
const bounceMs = 800;
const bumpGraceMs = 5000;
const bounceSpeed = baseSpeed * 1.5;
const bounceDistance = radius * 0.8;
const paintSample = 7;
const bodyHalfWidth = radius * 1.18;
const bodyHalfHeight = radius * 0.84;
const powerRadius = 56;
const projectileSpeed = 1140;
const freezeProjectileRadius = 36;
const paintballProjectileRadius = radius * 0.3;
const bananaProjectileLength = 75;
const bananaProjectileWidth = 30;
const spikyProjectileRadius = 45;
const spikyProjectileSpikeRadius = spikyProjectileRadius * 1.28;
const powerBallColors = ["#00b7e8", "#ec159b", "#f4d12f", "#26c95f"];
const arenaWidth = 1280;
const arenaHeight = 720;
const placePowerBands = [
  { place: 1, powers: ["shield", "banana"] },
  { place: 2, powers: ["reverse", "messy", "spiky", "paintball"] },
  { place: 3, powers: ["splat", "boost", "shrink"] },
  { place: 4, powers: ["freeze", "grow", "slow"] }
];
const placePowerWeights = [0.7, 0.18, 0.08, 0.04];
const splatAssetPaths = ["/assets/splats/splat-1.png", "/assets/splats/splat-2.png", "/assets/splats/splat-3.png"];
const splatImages = typeof Image === "undefined" ? [] : splatAssetPaths.map((path) => {
  const image = new Image();
  image.src = path;
  return image;
});
const powerIconImages = typeof Image === "undefined" ? new Map() : new Map(POWER_UPS.map((power) => {
  const image = new Image();
  image.src = power.iconSrc;
  return [power.id, image];
}));

export class SplobGame {
  constructor(canvas, overlay, hud, config = {}, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.overlay = overlay;
    this.hud = hud;
    this.config = config;
    this.hooks = hooks;
    this.keys = new Set();
    this.running = false;
    this.phase = "countdown";
    this.last = 0;
    this.startedAt = 0;
    this.countdownAt = 0;
    this.powerSpawnAt = 0;
    this.roundSeconds = GAME_SECONDS;
    this.suddenDeath = false;
    this.suddenDeathLoops = 0;
    this.powerUps = [];
    this.projectiles = [];
    this.splats = [];
    this.confetti = [];
    this.multiplayer = config.mode === "multiplayer";
    this.authoritative = Boolean(config.authoritative);
    this.rng = seededRandom(config.seed || `${Date.now()}-${Math.random()}`);
    this.remoteInputs = new Map();
    this.lastInputSignature = "";
    this.serverTimeRemainingMs = Number(config.durationMs || GAME_SECONDS * 1000);
    this.serverGameOver = null;
    this.serverStarted = false;
    this.pendingPaintStamps = [];
    this.matchStartAt = Number(config.startAt || 0);
    this.lastPowerShuffleStep = -1;
    this.lastEmergencySecond = null;
    this.winner = null;
    this.positionsInitialized = false;
    this.paint = document.createElement("canvas");
    this.paintCtx = this.paint.getContext("2d", { willReadFrequently: true });
    this.splatTintCanvas = document.createElement("canvas");
    this.splatTintCtx = this.splatTintCanvas.getContext("2d");
    this.players = this.createPlayers(config.players || []);
    this.onKeyDown = (event) => this.handleKey(event, true);
    this.onKeyUp = (event) => this.handleKey(event, false);
  }

  start() {
    this.resize();
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.running = true;
    this.phase = "countdown";
    const now = performance.now();
    this.countdownAt = this.multiplayer && this.matchStartAt ? now + (this.matchStartAt - Date.now()) : now;
    this.last = now;
    this.roundSeconds = GAME_SECONDS;
    this.suddenDeath = false;
    this.suddenDeathLoops = 0;
    if (this.hud.results) this.hud.results.innerHTML = "";
    if (this.authoritative) {
      this.serverStarted = this.countdownAt <= now;
      if (this.serverStarted) {
        this.phase = "playing";
        this.overlay.innerHTML = "";
      }
      this.startedAt = now;
      this.sendInputIfChanged(true);
    }
    this.loop(this.last);
  }

  stop() {
    this.running = false;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  createPlayers(source) {
    const preferred = this.config.preferredColor || "cyan";
    const localColor = COLOR_ORDER.includes(preferred) ? preferred : "cyan";
    const used = new Set();
    const players = [];
    for (const item of source.slice(0, 4)) {
      const fallbackColor = item.local ? localColor : COLOR_ORDER.find((color) => !used.has(color));
      const color = COLOR_ORDER.includes(item.color) && !used.has(item.color) ? item.color : fallbackColor;
      if (color) used.add(color);
      players.push({
        id: item.id || item.socketId || crypto.randomUUID(),
        socketId: item.socketId,
        profileId: item.profileId,
        name: item.name || item.username || (item.local ? "You" : "Guest"),
        color: color || localColor,
        local: Boolean(item.local),
        remote: !item.local && !item.ai,
        ai: Boolean(item.ai)
      });
    }
    if (!players.length) {
      players.push({ id: "local", name: "You", local: true, color: localColor });
      used.add(localColor);
    }
    const aiNames = shuffle(AI_NAMES, () => this.random());
    while (!this.multiplayer && players.length < 4) {
      const color = COLOR_ORDER.find((item) => !used.has(item));
      used.add(color);
      players.push({ id: `ai-${players.length}`, name: aiNames[players.length - 1] || AI_NAMES[players.length % AI_NAMES.length], color, ai: true });
    }
    return players.map((player, index) => ({
      ...player,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      angle: index % 2 === 0 ? 0 : Math.PI,
      lastCollisionAt: 0,
      bounceUntil: 0,
      bounceMoveUntil: 0,
      bounceInvulnerableUntil: 0,
      bounceVx: 0,
      bounceVy: 0,
      power: null,
      rollingPower: null,
      rollEndsAt: 0,
      effects: {},
      deadUntil: 0,
      spawnIndex: index,
      spawnX: 0,
      spawnY: 0,
      spawnAngle: index % 2 === 0 ? 0 : Math.PI,
      shieldUntil: 0,
      mood: "ready",
      aiTarget: null,
      coverage: 0
    }));
  }

  resize() {
    const width = arenaWidth;
    const height = arenaHeight;
    if (this.canvas.width === width && this.canvas.height === height && this.positionsInitialized) return;
    const oldPaint = this.paint;
    this.canvas.width = width;
    this.canvas.height = height;
    this.paint.width = width;
    this.paint.height = height;
    this.paintCtx.drawImage(oldPaint, 0, 0, width, height);
    if (!this.positionsInitialized) {
      this.placePlayersInCorners();
      this.positionsInitialized = true;
      return;
    }
    this.players.forEach((player) => {
      player.x = Math.min(width - bodyHalfWidth, Math.max(bodyHalfWidth, player.x));
      player.y = Math.min(height - bodyHalfHeight, Math.max(bodyHalfHeight, player.y));
      const spawn = this.cornerForIndex(player.spawnIndex);
      player.spawnX = spawn.x;
      player.spawnY = spawn.y;
      player.spawnAngle = spawn.angle;
    });
  }

  cornerForIndex(index) {
    const xMargin = bodyHalfWidth + 18;
    const topMargin = bodyHalfHeight + 18;
    const bottomMargin = bodyHalfHeight + 18;
    const corners = [
      { x: xMargin, y: topMargin, angle: Math.PI * 0.25 },
      { x: this.canvas.width - xMargin, y: topMargin, angle: Math.PI * 0.75 },
      { x: xMargin, y: this.canvas.height - bottomMargin, angle: -Math.PI * 0.25 },
      { x: this.canvas.width - xMargin, y: this.canvas.height - bottomMargin, angle: -Math.PI * 0.75 }
    ];
    return corners[index] || corners[0];
  }

  placePlayersInCorners() {
    this.players.forEach((player, index) => {
      const corner = this.cornerForIndex(index);
      player.x = corner.x;
      player.y = corner.y;
      player.angle = corner.angle;
      player.spawnX = corner.x;
      player.spawnY = corner.y;
      player.spawnAngle = corner.angle;
    });
  }

  handleKey(event, down) {
    if (["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(event.code)) event.preventDefault();
    if (down) this.keys.add(event.code);
    else this.keys.delete(event.code);
    const local = this.localPlayer();
    if (down && event.code === "Space" && local) {
      if (this.authoritative) {
        this.hooks.onInput?.({ type: "input", keys: this.inputKeys(), usePower: true, matchTime: this.matchTime(performance.now()) });
        return;
      }
      const at = performance.now();
      this.usePower(local, at);
      if (this.multiplayer) this.hooks.onInput?.({ type: "input", keys: this.sortedKeys(), usePower: true, matchTime: this.matchTime(at) });
    }
    this.sendInputIfChanged(false);
  }

  setTouchKey(code, down) {
    if (!["KeyW", "KeyA", "KeyS", "KeyD"].includes(code)) return;
    if (down) this.keys.add(code);
    else this.keys.delete(code);
    this.sendInputIfChanged(false);
  }

  triggerPower() {
    const local = this.localPlayer();
    if (!local) return;
    if (this.authoritative) {
      this.hooks.onInput?.({ type: "input", keys: this.inputKeys(), usePower: true, matchTime: this.matchTime(performance.now()) });
      return;
    }
    const at = performance.now();
    this.usePower(local, at);
    if (this.multiplayer) this.hooks.onInput?.({ type: "input", keys: this.sortedKeys(), usePower: true, matchTime: this.matchTime(at) });
  }

  loop(now) {
    if (!this.running) return;
    const dt = Math.min(0.04, (now - this.last) / 1000 || 0);
    this.last = now;
    this.update(now, dt);
    this.draw(now);
    requestAnimationFrame((time) => this.loop(time));
  }

  update(now, dt) {
    if (this.multiplayer) this.sendInputIfChanged(false);
    if (this.authoritative) {
      this.updateAuthoritativeRender(now);
      return;
    }
    if (this.phase === "countdown") {
      const index = Math.max(0, Math.floor((now - this.countdownAt) / 850));
      this.overlay.innerHTML = `<div class="countdown">${COUNTDOWN_LABELS[index] || ""}</div><div class="you-cue">YOU</div>`;
      const local = this.localPlayer() || this.players[0];
      this.overlay.style.setProperty("--you-x", `${(local.x / this.canvas.width) * 100}%`);
      this.overlay.style.setProperty("--you-y", `${(local.y / this.canvas.height) * 100}%`);
      if (index >= COUNTDOWN_LABELS.length) {
        this.overlay.innerHTML = "";
        this.phase = "playing";
        this.startedAt = now;
        this.roundSeconds = this.suddenDeath ? 15 : GAME_SECONDS;
        this.powerSpawnAt = now + 1200;
      }
      return;
    }
    if (this.phase !== "playing") return;

    const secondsLeft = Math.max(0, this.roundSeconds - Math.floor((now - this.startedAt) / 1000));
    this.hud.timer.textContent = formatTime(secondsLeft);
    if (secondsLeft > 0 && secondsLeft <= 5 && secondsLeft !== this.lastEmergencySecond) {
      this.lastEmergencySecond = secondsLeft;
      Sound.play("countdown", secondsLeft);
    }
    if (secondsLeft <= 0) return this.finish(now);
    this.updatePowerSlot(now);
    if (now > this.powerSpawnAt) this.spawnPowerUp(now);
    this.updatePlayers(now, dt);
    this.updateProjectiles(now, dt);
    this.updateSplats(now);
    if (Math.floor(now / 500) !== Math.floor((now - dt * 1000) / 500)) this.computeCoverage();
  }

  updateAuthoritativeRender(now) {
    this.interpolateServerPlayers(now);
    this.flushPendingPaintStamps(now);
    if (this.phase === "countdown") {
      const remaining = Math.max(0, this.matchStartAt - Date.now());
      const index = remaining > 2550 ? 0 : remaining > 1700 ? 1 : remaining > 850 ? 2 : 3;
      this.overlay.innerHTML = `<div class="countdown">${COUNTDOWN_LABELS[index] || ""}</div><div class="you-cue">YOU</div>`;
      const local = this.localPlayer() || this.players[0];
      if (local) {
        this.overlay.style.setProperty("--you-x", `${(local.x / this.canvas.width) * 100}%`);
        this.overlay.style.setProperty("--you-y", `${(local.y / this.canvas.height) * 100}%`);
      }
      if (Date.now() >= this.matchStartAt) {
        this.overlay.innerHTML = "";
        this.phase = "playing";
        this.serverStarted = true;
        this.lastEmergencySecond = null;
      }
      this.hud.timer.textContent = formatTime(Math.ceil(this.serverTimeRemainingMs / 1000));
      this.updatePowerSlot(now);
      return;
    }
    if (this.phase !== "playing") return;
    const secondsLeft = Math.max(0, Math.ceil(this.serverTimeRemainingMs / 1000));
    this.hud.timer.textContent = formatTime(secondsLeft);
    this.updatePowerSlot(now);
    if (secondsLeft > 0 && secondsLeft <= 5 && secondsLeft !== this.lastEmergencySecond) {
      this.lastEmergencySecond = secondsLeft;
      Sound.play("countdown", secondsLeft);
    }
  }

  interpolateServerPlayers(now = performance.now()) {
    for (const player of this.players) {
      const frames = player.serverFrames || [];
      const renderAt = now - 110;
      while (frames.length > 2 && frames[1].receivedAt <= renderAt) frames.shift();
      const previous = frames[0];
      const next = frames[1];
      if (previous && next && next.receivedAt > previous.receivedAt) {
        const t = Math.max(0, Math.min(1, (renderAt - previous.receivedAt) / (next.receivedAt - previous.receivedAt)));
        player.x = lerp(previous.x, next.x, t);
        player.y = lerp(previous.y, next.y, t);
        player.vx = lerp(previous.vx, next.vx, t);
        player.vy = lerp(previous.vy, next.vy, t);
        player.angle = lerpAngle(previous.angle, next.angle, t);
      } else if (previous) {
        const factor = player.local ? 0.32 : 0.22;
        player.x += (previous.x - player.x) * factor;
        player.y += (previous.y - player.y) * factor;
        player.vx = previous.vx;
        player.vy = previous.vy;
        player.angle = previous.angle;
      } else if (typeof player.targetX === "number" && typeof player.targetY === "number") {
        player.x = player.targetX;
        player.y = player.targetY;
      }
      player.coverage = typeof player.targetScore === "number" ? player.targetScore : player.coverage;
    }
  }

  updatePowerSlot(now) {
    this.resolveRollingPowers(now);
    const local = this.localPlayer() || this.players[0];
    const rolling = local.rollingPower;
    const step = Math.floor(now / 110);
    if (rolling) {
      const flicker = POWER_UPS[step % POWER_UPS.length];
      this.setPowerBox(flicker, true);
    } else {
      this.setPowerBox(local.power, false);
    }
    if (this.players.some((player) => player.local && player.rollingPower)) {
      if (step !== this.lastPowerShuffleStep) {
        this.lastPowerShuffleStep = step;
        Sound.play("shuffle");
      }
    }
  }

  setPowerBox(power, shuffling) {
    if (!this.hud.power) return;
    this.hud.power.classList.toggle("shuffling", Boolean(shuffling && power));
    this.hud.power.innerHTML = power ? `<img src="${power.iconSrc}" alt="${power.name}" draggable="false" />` : "";
    if (this.hud.mobilePower) {
      this.hud.mobilePower.textContent = power && !shuffling ? power.name : "POWER-UP";
      this.hud.mobilePower.disabled = !power || Boolean(shuffling);
      this.hud.mobilePower.classList.toggle("ready", Boolean(power && !shuffling));
    }
  }

  resolveRollingPowers(now) {
    for (const player of this.players) {
      if (!player.rollingPower || now < player.rollEndsAt) continue;
      if (!player.power) player.power = player.rollingPower;
      player.rollingPower = null;
      if (player.local) {
        this.lastPowerShuffleStep = -1;
        Sound.play("power");
      }
    }
  }

  updatePlayers(now, dt) {
    for (const player of this.players) {
      if (player.deadUntil > now) continue;
      if (player.deadUntil) this.respawnPlayer(player);
      const input = player.local ? this.localVector(player, now) : player.ai ? this.aiVector(player, now) : this.remoteVector(player, now);
      const bananaSlow = player.effects.bananaSlowUntil > now ? 0.3 : 1;
      const slow = player.effects.slowUntil > now ? 0.5 : 1;
      const boost = player.effects.boostUntil > now ? 1.5 : 1;
      const frozen = player.effects.freezeUntil > now;
      const bounceImmune = this.hasBounceImmunity(player, now);
      if (bounceImmune && player.bounceUntil > now) this.clearBounce(player);
      if (frozen) {
        player.vx = 0;
        player.vy = 0;
      } else if (player.bounceUntil > now && !bounceImmune) {
        player.vx = now < player.bounceMoveUntil ? player.bounceVx : 0;
        player.vy = now < player.bounceMoveUntil ? player.bounceVy : 0;
      } else {
        if (player.bounceUntil && player.bounceUntil <= now) {
          this.clearBounce(player);
        }
        const speedLimit = maxMoveSpeed * slow * bananaSlow * boost;
        player.vx = approachVelocity(player.vx, input.x * speedLimit, dt);
        player.vy = approachVelocity(player.vy, input.y * speedLimit, dt);
        if (Math.hypot(player.vx, player.vy) > 8) player.angle = Math.atan2(player.vy, player.vx);
      }
      const size = playerSizeMultiplier(player, now);
      const nextX = player.x + player.vx * dt;
      const nextY = player.y + player.vy * dt;
      const playerHalfWidth = bodyHalfWidth * size;
      const playerHalfHeight = bodyHalfHeight * size;
      const clampedX = Math.min(this.canvas.width - playerHalfWidth, Math.max(playerHalfWidth, nextX));
      const clampedY = Math.min(this.canvas.height - playerHalfHeight, Math.max(playerHalfHeight, nextY));
      const hitWall = clampedX !== nextX || clampedY !== nextY;
      if (clampedX !== nextX) player.vx = -player.vx * wallSpeedRetain;
      if (clampedY !== nextY) player.vy = -player.vy * wallSpeedRetain;
      player.x = clampedX;
      player.y = clampedY;
      if (hitWall) this.releaseMessySplat(player, now);
      this.paintAt(player, radius * size);
      this.collectPowerUps(player, now);
      if (player.remote && player.inputUsePower) {
        const usePowerAt = player.inputUsePowerAt || now;
        player.inputUsePower = false;
        player.inputUsePowerAt = 0;
        this.usePower(player, usePowerAt);
      }
      if (player.ai && player.power && this.random() < 0.05) this.usePower(player, now);
    }
    this.resolveBlobCollisions(now);
  }

  resolveBlobCollisions(now) {
    for (let i = 0; i < this.players.length; i += 1) {
      for (let j = i + 1; j < this.players.length; j += 1) {
        const a = this.players[i];
        const b = this.players[j];
        if (a.deadUntil > now || b.deadUntil > now) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 1;
        const angle = Math.atan2(dy, dx);
        const minDistance = blobOutlineRadius(angle, playerSizeMultiplier(a, now)) + blobOutlineRadius(angle + Math.PI, playerSizeMultiplier(b, now));
        if (distance >= minDistance) continue;
        const nx = dx / distance;
        const ny = dy / distance;
        const push = (minDistance - distance) / 2;
        a.x = Math.min(this.canvas.width - bodyHalfWidth, Math.max(bodyHalfWidth, a.x - nx * push));
        a.y = Math.min(this.canvas.height - bodyHalfHeight, Math.max(bodyHalfHeight, a.y - ny * push));
        b.x = Math.min(this.canvas.width - bodyHalfWidth, Math.max(bodyHalfWidth, b.x + nx * push));
        b.y = Math.min(this.canvas.height - bodyHalfHeight, Math.max(bodyHalfHeight, b.y + ny * push));
        this.applyBlobBounce(a, b, nx, ny, now);
      }
    }
  }

  applyBlobBounce(a, b, nx, ny, now) {
    const aBoosted = this.hasBounceImmunity(a, now);
    const bBoosted = this.hasBounceImmunity(b, now);
    const aShielded = this.hasCollisionGrace(a, now);
    const bShielded = this.hasCollisionGrace(b, now);
    const aInvulnerable = a.bounceInvulnerableUntil > now;
    const bInvulnerable = b.bounceInvulnerableUntil > now;
    if ((aInvulnerable || bInvulnerable) && !aBoosted && !bBoosted && !aShielded && !bShielded) return;

    const shouldThud = now - Math.max(a.lastCollisionAt || 0, b.lastCollisionAt || 0) > 180;
    // Shielded and boosted splobs behave like moving walls: they stay unaffected while the other splob bounces away.
    if ((aBoosted || aShielded) && !bBoosted && !bShielded) {
      this.startBounce(b, nx, ny, now);
    } else if ((bBoosted || bShielded) && !aBoosted && !aShielded) {
      this.startBounce(a, -nx, -ny, now);
    } else {
      const aDir = oppositeTravelDirection(a, -nx, -ny);
      const bDir = oppositeTravelDirection(b, nx, ny);
      this.startBounce(a, aDir.x, aDir.y, now);
      this.startBounce(b, bDir.x, bDir.y, now);
    }
    a.lastCollisionAt = now;
    b.lastCollisionAt = now;
    this.releaseMessySplat(a, now);
    this.releaseMessySplat(b, now);
    if (shouldThud) Sound.play("thud");
  }

  startBounce(player, dx, dy, now) {
    if (this.hasBounceImmunity(player, now) || this.hasCollisionGrace(player, now)) return;
    const length = Math.hypot(dx, dy) || 1;
    player.bounceVx = (dx / length) * bounceSpeed;
    player.bounceVy = (dy / length) * bounceSpeed;
    player.bounceMoveUntil = now + Math.min(bounceMs, (bounceDistance / bounceSpeed) * 1000);
    player.bounceUntil = now + bounceMs;
    player.bounceInvulnerableUntil = now + bumpGraceMs;
    player.vx = 0;
    player.vy = 0;
  }

  hasCollisionGrace(player, now) {
    return player.shieldUntil > now || (player.bounceInvulnerableUntil > now && player.bounceUntil <= now);
  }

  hasBounceImmunity(player, now) {
    return player.shieldUntil > now || player.effects.bounceImmuneUntil > now;
  }

  releaseMessySplat(player, now) {
    if (!player.effects.messyUntil || player.effects.messyUntil <= now || now - (player.lastMessySplatAt || 0) < 140) return;
    player.lastMessySplatAt = now;
    this.makeSplat(player, radius * 2.2 * playerSizeMultiplier(player, now), now);
  }

  clearBounce(player) {
    player.bounceUntil = 0;
    player.bounceMoveUntil = 0;
    player.bounceVx = 0;
    player.bounceVy = 0;
  }

  localVector(player, now) {
    const x = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    const y = (this.keys.has("KeyS") ? 1 : 0) - (this.keys.has("KeyW") ? 1 : 0);
    return player.effects.reverseUntil > now ? { x: -x, y: -y } : { x, y };
  }

  remoteVector(player, now) {
    const input = this.remoteInputs.get(player.socketId || player.id);
    const keys = new Set(input?.keys || []);
    const x = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
    const y = (keys.has("KeyS") ? 1 : 0) - (keys.has("KeyW") ? 1 : 0);
    return player.effects.reverseUntil > now ? { x: -x, y: -y } : { x, y };
  }

  aiVector(player, now) {
    if (!player.aiTarget || now > player.aiTarget.expires || Math.hypot(player.aiTarget.x - player.x, player.aiTarget.y - player.y) < 42) {
      const power = this.powerUps[0];
      player.aiTarget = power && this.random() < 0.55
        ? { x: power.x, y: power.y, expires: now + 2500 }
        : this.findAiPaintTarget(player, now);
    }
    const dx = player.aiTarget.x - player.x;
    const dy = player.aiTarget.y - player.y;
    const length = Math.hypot(dx, dy) || 1;
    const vector = { x: dx / length, y: dy / length };
    return player.effects.reverseUntil > now ? { x: -vector.x, y: -vector.y } : vector;
  }

  findAiPaintTarget(player, now) {
    for (let i = 0; i < 16; i += 1) {
      const x = 30 + this.random() * (this.canvas.width - 60);
      const y = 30 + this.random() * (this.canvas.height - 60);
      if (this.colorAt(x, y) !== player.color) return { x, y, expires: now + 3600 };
    }
    return { x: this.random() * this.canvas.width, y: this.random() * this.canvas.height, expires: now + 2800 };
  }

  paintAt(player, size = radius) {
    const color = PLAYER_COLORS[player.color].paint;
    this.paintCtx.save();
    this.paintCtx.globalCompositeOperation = "source-over";
    this.paintCtx.fillStyle = color;
    this.paintCtx.beginPath();
    this.paintCtx.arc(player.x, player.y, size, 0, Math.PI * 2);
    this.paintCtx.fill();
    this.paintCtx.restore();
  }

  colorAt(x, y) {
    const pixel = this.paintCtx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
    return COLOR_ORDER.find((color) => closeTo(pixel, PLAYER_COLORS[color].paint)) || "";
  }

  collectPowerUps(player, now) {
    for (const power of [...this.powerUps]) {
      if (Math.hypot(power.x - player.x, power.y - player.y) > radius + powerRadius) continue;
      this.powerUps = this.powerUps.filter((item) => item !== power);
      if (player.power || player.rollingPower) {
        Sound.play("thud");
        continue;
      }
      const won = this.choosePower(player);
      if (this.suddenDeath) {
        player.power = won;
        this.usePower(player, now);
        continue;
      }
      player.rollingPower = won;
      player.rollEndsAt = now + (player.local ? 3000 : 800);
      if (player.local) this.lastPowerShuffleStep = -1;
    }
  }

  choosePower(player) {
    const ranked = [...this.players]
      .map((candidate) => ({ candidate, tieBreaker: this.random() }))
      .sort((a, b) => (b.candidate.coverage - a.candidate.coverage) || (a.tieBreaker - b.tieBreaker))
      .map((entry) => entry.candidate);
    const rankIndex = ranked.findIndex((candidate) => candidate.id === player.id);
    const currentBandIndex = rankIndex === -1 ? placePowerBands.length - 1 : rankIndex;
    const bandOrder = orderedPlaceBands(currentBandIndex);
    const chosenBand = weightedChoice(bandOrder, placePowerWeights, () => this.random());
    const eligibleIds = new Set(chosenBand.powers);
    const eligible = POWER_UPS.filter((power) => eligibleIds.has(power.id));
    return eligible[(this.random() * eligible.length) | 0];
  }

  usePower(player, now = performance.now()) {
    if (this.phase !== "playing" || !player.power || player.rollingPower) return;
    const power = player.power;
    player.power = null;
    this.signalPowerUse(player, power, now);
    if (power.id === "boost") {
      player.effects.boostUntil = now + 5000;
      player.effects.bounceImmuneUntil = now + 5000;
    }
    if (power.id === "grow") {
      player.effects.growUntil = now + 5000;
      player.effects.bounceImmuneUntil = now + 5000;
    }
    if (power.id === "messy") player.effects.messyUntil = now + 10000;
    if (power.id === "splat") this.makeSplat(player, radius * 6 * playerSizeMultiplier(player, now), now);
    if (power.id === "shield") player.shieldUntil = now + 10000;
    if (power.id === "paintball") {
      this.aimAtRandomOpponent(player, now);
      this.launchProjectile(player, power.id, now);
    }
    if (power.id === "slow") {
      player.effects.bounceImmuneUntil = now + 5000;
      this.opponentsOf(player, now).forEach((opponent) => {
        opponent.effects.slowUntil = now + 5000;
      });
    }
    if (power.id === "shrink") {
      this.opponentsOf(player, now).forEach((opponent) => {
        opponent.effects.shrinkUntil = now + 5000;
      });
    }
    if (power.id === "reverse") {
      player.effects.reverseSignalUntil = now + 2000;
      this.opponentsOf(player, now).forEach((opponent) => {
        opponent.effects.reverseUntil = now + 5000;
      });
      Sound.play("swishoo");
    }
    if (power.id === "freeze") {
      this.opponentsOf(player, now).forEach((opponent) => {
        opponent.effects.freezeUntil = now + 5000;
        opponent.vx = 0;
        opponent.vy = 0;
        this.clearBounce(opponent);
      });
    }
    if (power.id === "banana" || power.id === "spiky") {
      this.aimAtRandomOpponent(player, now);
      this.launchProjectile(player, power.id, now);
    }
    if (power.id !== "reverse") Sound.play(power.id === "splat" ? "splat" : "power");
  }

  signalPowerUse(player, power, now) {
    player.effects.powerSignalId = power.id;
    player.effects.powerSignalUntil = now + 1200;
  }

  opponentsOf(player, now = performance.now()) {
    return this.players.filter((opponent) => opponent.id !== player.id && opponent.deadUntil <= now);
  }

  aimAtRandomOpponent(player, now) {
    if (player.local) return;
    const targets = this.players.filter((target) => target.id !== player.id && target.deadUntil <= now);
    const target = targets[(this.random() * targets.length) | 0];
    if (!target) return;
    player.angle = Math.atan2(target.y - player.y, target.x - player.x);
  }

  makeSplat(player, spread, now = performance.now()) {
    this.paintSplatAsset(player.x, player.y, player.color, spread);
    this.splats.push({ x: player.x, y: player.y, color: player.color, born: now });
  }

  paintSplatAsset(x, y, playerColor, spread) {
    const imageIndex = (this.random() * Math.max(1, splatImages.length)) | 0;
    const size = Math.round(spread * (1.45 + this.random() * 0.35));
    const angle = this.random() * Math.PI * 2;
    const image = splatImages[imageIndex];
    if (!image || !image.complete || !image.naturalWidth) {
      this.paintCtx.fillStyle = PLAYER_COLORS[playerColor].paint;
      this.paintCtx.beginPath();
      this.paintCtx.arc(x, y, spread * 0.55, 0, Math.PI * 2);
      this.paintCtx.fill();
      return;
    }
    const color = PLAYER_COLORS[playerColor].paint;
    this.splatTintCanvas.width = size;
    this.splatTintCanvas.height = size;
    this.splatTintCtx.clearRect(0, 0, size, size);
    this.splatTintCtx.drawImage(image, 0, 0, size, size);
    this.splatTintCtx.globalCompositeOperation = "source-in";
    this.splatTintCtx.fillStyle = color;
    this.splatTintCtx.fillRect(0, 0, size, size);
    this.splatTintCtx.globalCompositeOperation = "source-over";
    this.paintCtx.save();
    this.paintCtx.translate(x, y);
    this.paintCtx.rotate(angle);
    this.paintCtx.drawImage(this.splatTintCanvas, -size / 2, -size / 2);
    this.paintCtx.restore();
  }

  launchProjectile(player, type, now = performance.now()) {
    const hitRadius = projectileSize(type);
    this.projectiles.push({
      type,
      owner: player.id,
      color: player.color,
      size: hitRadius,
      x: player.x + Math.cos(player.angle) * (radius + hitRadius),
      y: player.y + Math.sin(player.angle) * (radius + hitRadius),
      vx: Math.cos(player.angle) * projectileSpeed,
      vy: Math.sin(player.angle) * projectileSpeed,
      born: now
    });
  }

  updateProjectiles(now, dt) {
    this.projectiles = this.projectiles.filter((projectile) => {
      projectile.x += projectile.vx * dt;
      projectile.y += projectile.vy * dt;
      if (projectile.type === "paintball") {
        this.paintCtx.fillStyle = PLAYER_COLORS[projectile.color].paint;
        this.paintCtx.beginPath();
        this.paintCtx.arc(projectile.x, projectile.y, projectile.size, 0, Math.PI * 2);
        this.paintCtx.fill();
      }
      const edge = projectile.size;
      if (projectile.x < edge) {
        projectile.x = edge;
        projectile.vx = Math.abs(projectile.vx);
        Sound.play("thud");
      } else if (projectile.x > this.canvas.width - edge) {
        projectile.x = this.canvas.width - edge;
        projectile.vx = -Math.abs(projectile.vx);
        Sound.play("thud");
      }
      if (projectile.y < edge) {
        projectile.y = edge;
        projectile.vy = Math.abs(projectile.vy);
        Sound.play("thud");
      } else if (projectile.y > this.canvas.height - edge) {
        projectile.y = this.canvas.height - edge;
        projectile.vy = -Math.abs(projectile.vy);
        Sound.play("thud");
      }
      if (projectile.type === "paintball") return now - projectile.born < 5000;
      const target = this.players.find((player) => player.id !== projectile.owner && projectileHitsPlayer(projectile, player, now));
      if (!target || target.shieldUntil > now) return true;
      if (projectile.type === "freeze") {
        target.effects.freezeUntil = now + 5000;
        target.vx = 0;
        target.vy = 0;
        this.clearBounce(target);
      } else if (projectile.type === "banana") {
        target.effects.bananaSlowUntil = now + 3000;
        target.effects.spinUntil = now + 650;
      } else {
        this.makeSplat(target, radius * 2.5, now);
        this.killPlayer(target, now);
      }
      Sound.play("splat");
      return false;
    });
  }

  killPlayer(player, now) {
    player.deadUntil = now + 5000;
    player.effects = { splatMessageUntil: now + 5000 };
    player.power = null;
    player.rollingPower = null;
    player.shieldUntil = 0;
    player.vx = 0;
    player.vy = 0;
    this.clearBounce(player);
  }

  respawnPlayer(player) {
    const spawn = this.cornerForIndex(player.spawnIndex);
    player.spawnX = spawn.x;
    player.spawnY = spawn.y;
    player.spawnAngle = spawn.angle;
    player.deadUntil = 0;
    player.x = Math.min(this.canvas.width - bodyHalfWidth, Math.max(bodyHalfWidth, player.spawnX));
    player.y = Math.min(this.canvas.height - bodyHalfHeight, Math.max(bodyHalfHeight, player.spawnY));
    player.angle = player.spawnAngle;
    player.vx = 0;
    player.vy = 0;
    player.effects = {};
    player.shieldUntil = 0;
    this.clearBounce(player);
  }

  updateSplats(now) {
    this.splats = this.splats.filter((splat) => now - splat.born < 700);
  }

  spawnPowerUp(now) {
    if (this.powerUps.length < 5) {
      this.powerUps.push({
        x: powerRadius + 24 + this.random() * (this.canvas.width - (powerRadius + 24) * 2),
        y: powerRadius + 24 + this.random() * (this.canvas.height - (powerRadius + 24) * 2),
        born: now
      });
    }
    const delay = 2500 + this.random() * 2000;
    this.powerSpawnAt = now + (this.suddenDeath ? delay / 4 : delay);
  }

  computeCoverage() {
    const totals = Object.fromEntries(COLOR_ORDER.map((color) => [color, 0]));
    let painted = 0;
    const data = this.paintCtx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    for (let y = 0; y < this.canvas.height; y += paintSample) {
      for (let x = 0; x < this.canvas.width; x += paintSample) {
        const index = (y * this.canvas.width + x) * 4;
        if (data[index + 3] < 20) continue;
        const color = COLOR_ORDER.find((item) => closeTo(data.slice(index, index + 3), PLAYER_COLORS[item].paint));
        if (color) {
          totals[color] += 1;
          painted += 1;
        }
      }
    }
    this.players.forEach((player) => {
      player.coverage = painted ? totals[player.color] / painted : 0;
    });
  }

  finish(now) {
    this.phase = "stop";
    this.computeCoverage();
    const standings = this.standings();
    this.winner = standings[0];
    this.overlay.innerHTML = `<div class="countdown">Stop!</div>`;
    if (this.hud.results) this.hud.results.innerHTML = "";
    this.players.forEach((player) => (player.mood = "expectant"));
    setTimeout(() => this.revealResults(standings), 1200);
  }

  revealResults(standings) {
    if (!this.running || this.phase !== "stop") return;
    this.overlay.innerHTML = `<div class="countdown">Calculating...</div>`;
    this.prepareScoreSlots();
    const revealOrder = [...standings].reverse();
    revealOrder.forEach((player, index) => {
      setTimeout(() => {
        if (!this.running || this.phase !== "stop") return;
        this.addScoreRow(player, standings.indexOf(player) + 1);
        Sound.play("score", index);
        if (index === revealOrder.length - 1) this.resolveWinner(standings);
      }, 900 + index * 1000);
    });
  }

  resolveWinner(standings) {
    const tied = standings.filter((player) => Math.abs(player.coverage - standings[0].coverage) < 0.001);
    if (tied.length > 1) {
      this.beginSuddenDeath();
      return;
    }
    this.phase = "results";
    this.winner = standings[0];
    this.players.forEach((player) => (player.mood = player.id === this.winner.id ? "happy" : "sad"));
    this.releaseConfetti();
    this.overlay.innerHTML = `
      <div class="countdown result-title">${this.winner.local ? "You win!" : `${this.winner.name} wins!`}</div>
      <div class="result-actions">
        <button class="button asset-button result-asset-button" data-game-action="again" aria-label="Play Again"><img src="/assets/ui/play-again.png" alt="" draggable="false" /></button>
        <button class="button asset-button result-asset-button" data-game-action="menu" aria-label="Main Menu"><img src="/assets/ui/main-menu.png" alt="" draggable="false" /></button>
      </div>
    `;
    this.overlay.querySelector('[data-game-action="again"]').addEventListener("click", () => this.hooks.onAgain?.());
    this.overlay.querySelector('[data-game-action="menu"]').addEventListener("click", () => this.hooks.onMenu?.());
    Sound.play("fanfare");
    Sound.play("win");
  }

  standings() {
    return [...this.players].sort((a, b) => (b.coverage - a.coverage) || a.spawnIndex - b.spawnIndex);
  }

  addScoreRow(player, place) {
    if (!this.hud.results) return;
    const color = PLAYER_COLORS[player.color];
    const percent = Math.round(player.coverage * 100);
    const suffix = place === 1 ? "st" : place === 2 ? "nd" : place === 3 ? "rd" : "th";
    const row = this.hud.results.querySelector(`[data-score-place="${place}"]`) || document.createElement("div");
    row.className = "score-row";
    row.dataset.scorePlace = String(place);
    row.style.setProperty("--score-color", color.paint);
    row.style.setProperty("--score-dark", color.dark);
    row.style.setProperty("--score-width", `${percent}%`);
    row.innerHTML = `<span>${place}${suffix}</span><img class="score-blob-img" src="${scoreBlobDataUri(color)}" alt="" draggable="false" /><span class="score-name">${escapeText(player.name)}</span><span class="score-bar"><span class="score-fill"></span></span><span>${percent}%</span>`;
    if (!row.parentNode) this.hud.results.appendChild(row);
  }

  prepareScoreSlots() {
    if (!this.hud.results) return;
    this.hud.results.innerHTML = "";
    for (let place = 1; place <= 4; place += 1) {
      const slot = document.createElement("div");
      slot.className = "score-row score-row-empty";
      slot.dataset.scorePlace = String(place);
      this.hud.results.appendChild(slot);
    }
  }

  beginSuddenDeath() {
    this.suddenDeath = true;
    this.suddenDeathLoops += 1;
    this.phase = "sudden";
    this.overlay.innerHTML = `<div class="countdown result-title">Sudden Splob!</div>`;
    this.players.forEach((player) => {
      player.mood = "ready";
      player.deadUntil = 0;
      player.vx = 0;
      player.vy = 0;
      player.power = null;
      player.rollingPower = null;
      player.effects = {};
      player.shieldUntil = 0;
      this.clearBounce(player);
    });
    setTimeout(() => {
      if (!this.running || this.phase !== "sudden") return;
      if (this.hud.results) this.hud.results.innerHTML = "";
      this.phase = "countdown";
      this.countdownAt = performance.now();
      this.lastEmergencySecond = null;
      this.powerUps = [];
      this.projectiles = [];
    }, 2000);
  }

  releaseConfetti() {
    const colors = Object.values(PLAYER_COLORS).map((color) => color.paint);
    const now = performance.now();
    this.confetti = Array.from({ length: 130 }, () => ({
      x: this.random() * this.canvas.width,
      y: -20 - this.random() * this.canvas.height * 0.4,
      vx: -90 + this.random() * 180,
      vy: 120 + this.random() * 260,
      size: 5 + this.random() * 8,
      spin: this.random() * Math.PI,
      color: colors[(this.random() * colors.length) | 0],
      born: now
    }));
  }

  draw(now) {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawCanvasTexture();
    this.ctx.drawImage(this.paint, 0, 0);
    this.drawPowerUps(now);
    this.drawProjectiles(now);
    this.players.forEach((player) => this.drawPlayer(player, now));
    this.drawConfetti(now);
    this.players.forEach((player) => this.drawPowerLabel(player, now));
    this.drawMiniStatus(now);
  }

  drawCanvasTexture() {
    this.ctx.fillStyle = "#fffdf0";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.save();
    this.ctx.globalAlpha = 0.16;
    const marks = [
      [0.16, 0.2, 42, "#00b7e8"],
      [0.82, 0.19, 58, "#ec159b"],
      [0.21, 0.78, 48, "#f4d12f"],
      [0.78, 0.77, 52, "#26c95f"],
      [0.5, 0.11, 30, "#00b7e8"],
      [0.44, 0.86, 34, "#ec159b"]
    ];
    for (const [x, y, size, color] of marks) {
      const cx = x * this.canvas.width;
      const cy = y * this.canvas.height;
      this.ctx.fillStyle = color;
      this.ctx.beginPath();
      this.ctx.ellipse(cx, cy, size, size * 0.72, x * Math.PI, 0, Math.PI * 2);
      this.ctx.fill();
      for (let i = 0; i < 4; i += 1) {
        const angle = i * 1.65 + x * 4;
        this.ctx.beginPath();
        this.ctx.arc(cx + Math.cos(angle) * size * 0.78, cy + Math.sin(angle) * size * 0.54, size * (0.12 + i * 0.025), 0, Math.PI * 2);
        this.ctx.fill();
      }
    }
    this.ctx.restore();
    this.ctx.globalAlpha = 0.18;
    this.ctx.strokeStyle = "#dfd2b9";
    this.ctx.lineWidth = 1;
    for (let x = 0; x < this.canvas.width; x += 18) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x + this.canvas.height * 0.14, this.canvas.height);
      this.ctx.stroke();
    }
    for (let y = 0; y < this.canvas.height; y += 22) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.canvas.width, y - this.canvas.width * 0.08);
      this.ctx.stroke();
    }
    this.ctx.globalAlpha = 1;
  }

  drawPowerUps(now) {
    for (const power of this.powerUps) {
      const pulse = 1 + Math.sin(now / 220) * 0.055;
      const wiggle = Math.sin((now - power.born) / 125) * 0.13;
      const bob = Math.sin((now - power.born) / 260) * 4;
      this.ctx.save();
      this.ctx.translate(power.x, power.y + bob);
      this.ctx.rotate(-0.18 + wiggle);
      this.ctx.scale(pulse, pulse);
      this.ctx.shadowColor = "rgba(47, 32, 38, 0.25)";
      this.ctx.shadowBlur = 18;
      this.ctx.shadowOffsetY = 10;
      const gradient = this.ctx.createRadialGradient(-powerRadius * 0.22, -powerRadius * 0.36, powerRadius * 0.18, 0, 0, powerRadius * 1.08);
      gradient.addColorStop(0, "#ffd89a");
      gradient.addColorStop(0.62, "#f0ad5c");
      gradient.addColorStop(1, "#b87535");
      this.ctx.fillStyle = gradient;
      this.ctx.strokeStyle = "#70441f";
      this.ctx.lineWidth = 6;
      this.ctx.beginPath();
      this.ctx.moveTo(-powerRadius * 0.94, -powerRadius * 0.05);
      this.ctx.bezierCurveTo(-powerRadius * 0.95, -powerRadius * 0.8, -powerRadius * 0.15, -powerRadius * 0.94, powerRadius * 0.35, -powerRadius * 0.7);
      this.ctx.bezierCurveTo(powerRadius * 1.05, -powerRadius * 0.38, powerRadius * 1.08, powerRadius * 0.42, powerRadius * 0.45, powerRadius * 0.7);
      this.ctx.bezierCurveTo(-powerRadius * 0.12, powerRadius * 0.96, -powerRadius * 0.88, powerRadius * 0.64, -powerRadius * 0.94, -powerRadius * 0.05);
      this.ctx.fill();
      this.ctx.stroke();

      this.ctx.shadowColor = "transparent";
      this.ctx.fillStyle = "#fff9ea";
      this.ctx.strokeStyle = "rgba(112, 68, 31, 0.42)";
      this.ctx.lineWidth = 5;
      this.ctx.beginPath();
      this.ctx.arc(powerRadius * 0.06, -powerRadius * 0.46, powerRadius * 0.25, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();

      powerBallColors.forEach((color, index) => {
        const spots = [
          [-0.45, -0.14, 0.24, -0.2],
          [-0.3, 0.34, 0.22, -0.75],
          [0.25, 0.28, 0.2, 0.08],
          [0.62, -0.18, 0.21, -0.14]
        ];
        const [x, y, size, angle] = spots[index];
        this.ctx.fillStyle = color;
        this.ctx.globalAlpha = 0.86;
        this.ctx.beginPath();
        this.ctx.ellipse(powerRadius * x, powerRadius * y, powerRadius * size, powerRadius * size * 0.58, angle, 0, Math.PI * 2);
        this.ctx.fill();
      });
      this.ctx.globalAlpha = 1;
      this.ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
      this.ctx.beginPath();
      this.ctx.ellipse(-powerRadius * 0.42, -powerRadius * 0.42, powerRadius * 0.18, powerRadius * 0.08, -0.45, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    }
  }

  drawConfetti(now) {
    if (!this.confetti.length) return;
    this.ctx.save();
    this.confetti = this.confetti.filter((piece) => now - piece.born < 5200);
    for (const piece of this.confetti) {
      const age = (now - piece.born) / 1000;
      const x = piece.x + piece.vx * age;
      const y = piece.y + piece.vy * age + age * age * 70;
      this.ctx.save();
      this.ctx.translate(x, y);
      this.ctx.rotate(piece.spin + age * 6);
      this.ctx.globalAlpha = Math.max(0, 1 - age / 5.2);
      this.ctx.fillStyle = piece.color;
      this.ctx.fillRect(-piece.size / 2, -piece.size / 2, piece.size, piece.size * 0.55);
      this.ctx.restore();
    }
    this.ctx.restore();
  }

  drawProjectiles(now) {
    for (const item of this.projectiles) {
      this.ctx.save();
      this.ctx.translate(item.x, item.y);
      this.ctx.rotate(Math.atan2(item.vy, item.vx));
      this.ctx.fillStyle = item.type === "banana" ? "#ffd93d" : item.type === "paintball" ? PLAYER_COLORS[item.color].paint : item.type === "freeze" ? "#bff1ff" : "#3b3745";
      this.ctx.strokeStyle = "#2d1c18";
      this.ctx.lineWidth = 6;
      if (item.type === "banana") {
        this.ctx.shadowColor = "rgba(47, 32, 38, 0.24)";
        this.ctx.shadowBlur = 12;
        this.ctx.shadowOffsetY = 8;
        this.ctx.beginPath();
        this.ctx.ellipse(0, 0, bananaProjectileLength, bananaProjectileWidth, 0.45, 0.2, Math.PI * 1.85);
        this.ctx.lineCap = "round";
        this.ctx.stroke();
        this.ctx.strokeStyle = "#fff1a0";
        this.ctx.lineWidth = 4;
        this.ctx.beginPath();
        this.ctx.ellipse(-8, -5, bananaProjectileLength * 0.62, bananaProjectileWidth * 0.5, 0.45, 0.35, Math.PI * 1.5);
      } else if (item.type === "paintball") {
        this.ctx.shadowColor = "rgba(47, 32, 38, 0.22)";
        this.ctx.shadowBlur = 12;
        this.ctx.shadowOffsetY = 7;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, paintballProjectileRadius, 0, Math.PI * 2);
      } else if (item.type === "freeze") {
        this.ctx.shadowColor = "rgba(47, 32, 38, 0.22)";
        this.ctx.shadowBlur = 12;
        this.ctx.shadowOffsetY = 7;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, freezeProjectileRadius, 0, Math.PI * 2);
      } else {
        this.ctx.shadowColor = "rgba(47, 32, 38, 0.28)";
        this.ctx.shadowBlur = 14;
        this.ctx.shadowOffsetY = 9;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, spikyProjectileRadius, 0, Math.PI * 2);
      }
      this.ctx.fill();
      this.ctx.stroke();
      if (item.type === "freeze") {
        this.ctx.shadowColor = "transparent";
        this.ctx.strokeStyle = "#ffffff";
        this.ctx.lineWidth = 5;
        for (let i = 0; i < 6; i += 1) {
          const angle = (Math.PI * 2 * i) / 6;
          this.ctx.beginPath();
          this.ctx.moveTo(Math.cos(angle) * freezeProjectileRadius * 0.25, Math.sin(angle) * freezeProjectileRadius * 0.25);
          this.ctx.lineTo(Math.cos(angle) * freezeProjectileRadius * 0.9, Math.sin(angle) * freezeProjectileRadius * 0.9);
          this.ctx.stroke();
        }
      }
      if (item.type === "spiky") {
        this.ctx.shadowColor = "transparent";
        this.ctx.strokeStyle = "#2d1c18";
        this.ctx.lineWidth = 7;
        for (let i = 0; i < 10; i += 1) {
          const angle = (Math.PI * 2 * i) / 10 + now / 170;
          this.ctx.beginPath();
          this.ctx.moveTo(Math.cos(angle) * spikyProjectileRadius * 0.74, Math.sin(angle) * spikyProjectileRadius * 0.74);
          this.ctx.lineTo(Math.cos(angle) * spikyProjectileRadius * 1.28, Math.sin(angle) * spikyProjectileRadius * 1.28);
          this.ctx.stroke();
        }
      }
      this.ctx.restore();
    }
  }

  drawPlayer(player, now) {
    if (player.deadUntil > now) return;
    const color = PLAYER_COLORS[player.color];
    const size = playerSizeMultiplier(player, now);
    const spin = player.effects.spinUntil > now ? (now / 70) % (Math.PI * 2) : 0;
    const slowWiggle = player.effects.slowUntil > now ? Math.sin(now / 45) * 0.08 : 0;
    const bounce = 0;
    const shielded = player.shieldUntil > now;
    const bouncing = player.bounceUntil > now && !shielded;
    const immobilisedWiggle = bouncing && now >= player.bounceMoveUntil ? Math.sin(now / 38) * 0.08 : 0;
    this.ctx.save();
    this.ctx.fillStyle = "rgba(47, 32, 38, 0.22)";
    this.ctx.beginPath();
    this.ctx.ellipse(player.x, player.y + bodyHalfHeight * size * 0.84, bodyHalfWidth * size * 0.76, bodyHalfHeight * size * 0.2, 0, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.translate(player.x, player.y + bounce);
    this.ctx.rotate(spin + immobilisedWiggle + slowWiggle);
    if (player.mood === "happy") this.ctx.rotate(Math.sin(now / 90) * 0.18);
    this.ctx.scale(size, size);
    this.drawBlobShape(color, now, player.effects.messyUntil > now);
    if (shielded) this.drawShield();
    this.drawFace(bouncing ? "puzzled" : player.mood, false);
    this.ctx.restore();
    if (player.effects.boostUntil > now) this.drawBoostSparks(player, color, now);
    if (player.effects.reverseSignalUntil > now) this.drawReverseSignal(player, now);
  }

  drawBlobShape(color, now, messy = false) {
    const wobble = Math.sin(now / 420) * 0.04;
    const jig = messy ? Math.sin(now / 54) * 0.12 : 0;
    this.ctx.save();
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";

    this.ctx.fillStyle = color.paint;
    this.ctx.strokeStyle = color.dark;
    this.ctx.lineWidth = 10;
    this.ctx.beginPath();
    this.ctx.moveTo(-bodyHalfWidth * (1 + jig * 0.08), bodyHalfHeight * 0.26);
    this.ctx.bezierCurveTo(-bodyHalfWidth * (1.03 + jig * 0.12), -bodyHalfHeight * 0.46, -bodyHalfWidth * 0.58, -bodyHalfHeight * (1.08 + wobble + jig * 0.16), 0, -bodyHalfHeight * (1 - jig * 0.05));
    this.ctx.bezierCurveTo(bodyHalfWidth * 0.62, -bodyHalfHeight * (1.04 - wobble + jig * 0.1), bodyHalfWidth * (1.03 - jig * 0.1), -bodyHalfHeight * 0.42, bodyHalfWidth * (1 + jig * 0.06), bodyHalfHeight * 0.25);
    this.ctx.bezierCurveTo(bodyHalfWidth * (0.94 + jig * 0.08), bodyHalfHeight * 0.94, bodyHalfWidth * 0.34, bodyHalfHeight * (1.02 + jig * 0.08), 0, bodyHalfHeight);
    this.ctx.bezierCurveTo(-bodyHalfWidth * 0.48, bodyHalfHeight * (1.01 - jig * 0.06), -bodyHalfWidth * 0.94, bodyHalfHeight * 0.9, -bodyHalfWidth * (1 + jig * 0.08), bodyHalfHeight * 0.26);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();

    this.ctx.globalAlpha = 0.2;
    this.ctx.fillStyle = "#ffffff";
    this.ctx.beginPath();
    this.ctx.ellipse(-radius * 0.36, -radius * 0.06, radius * 0.34, radius * 0.72, -0.12, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.globalAlpha = 0.22;
    this.ctx.beginPath();
    this.ctx.ellipse(radius * 0.54, -radius * 0.45, radius * 0.18, radius * 0.34, -0.75, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.globalAlpha = 1;

    this.ctx.restore();
  }

  drawShield() {
    this.ctx.strokeStyle = "rgba(255,255,255,0.9)";
    this.ctx.lineWidth = 6;
    this.ctx.beginPath();
    this.ctx.ellipse(0, radius * 0.02, bodyHalfWidth + 16, bodyHalfHeight + 18, 0, 0, Math.PI * 2);
    this.ctx.stroke();
  }

  drawBoostSparks(player, color, now) {
    const speed = Math.hypot(player.vx, player.vy);
    if (speed < 10) return;
    const angle = player.angle;
    this.ctx.save();
    this.ctx.globalAlpha = 0.78;
    for (let i = 0; i < 7; i += 1) {
      const drift = (i - 3) * 0.22 + Math.sin(now / 75 + i) * 0.12;
      const distance = radius * (0.8 + i * 0.16);
      const x = player.x + Math.cos(angle) * distance + Math.cos(angle + Math.PI / 2) * drift * radius;
      const y = player.y + Math.sin(angle) * distance + Math.sin(angle + Math.PI / 2) * drift * radius;
      this.ctx.fillStyle = i % 2 ? color.light : color.paint;
      this.ctx.beginPath();
      this.ctx.arc(x, y, radius * (0.05 + (i % 3) * 0.018), 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.restore();
  }

  drawReverseSignal(player, now) {
    const progress = Math.max(0, Math.min(1, (player.effects.reverseSignalUntil - now) / 2000));
    const spin = now / 160;
    this.ctx.save();
    this.ctx.translate(player.x, player.y - bodyHalfHeight * playerSizeMultiplier(player, now) * 1.45);
    this.ctx.rotate(spin);
    this.ctx.globalAlpha = Math.min(1, progress * 2);
    this.ctx.strokeStyle = "#ffe77b";
    this.ctx.fillStyle = "#ffe77b";
    this.ctx.lineWidth = 7;
    this.ctx.lineCap = "round";
    for (const direction of [-1, 1]) {
      this.ctx.save();
      this.ctx.scale(direction, 1);
      this.ctx.beginPath();
      this.ctx.arc(0, 0, 30, -0.15, Math.PI * 1.15);
      this.ctx.stroke();
      this.ctx.beginPath();
      this.ctx.moveTo(-26, 25);
      this.ctx.lineTo(-10, 28);
      this.ctx.lineTo(-18, 12);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.restore();
    }
    this.ctx.restore();
  }

  drawPowerLabel(player, now) {
    if (player.deadUntil > now) return;
    const size = playerSizeMultiplier(player, now);
    let power = null;
    let scale = 1;
    if (player.rollingPower) {
      power = POWER_UPS[Math.floor(now / 110) % POWER_UPS.length];
      scale = 1 + Math.sin(now / 80) * 0.08;
    } else if (player.power) {
      power = player.power;
    }
    if (player.effects.powerSignalUntil > now) {
      power = POWER_UPS.find((item) => item.id === player.effects.powerSignalId) || power;
      scale = 1.25 + Math.sin(now / 55) * 0.08;
    }
    if (!power) return;
    const y = player.y - bodyHalfHeight * size - 48;
    this.ctx.save();
    this.ctx.translate(player.x, y);
    this.ctx.scale(scale, scale);
    this.drawPowerIcon(power, 0, 0, 78);
    this.ctx.restore();
  }

  drawPowerIcon(power, x, y, targetSize) {
    const image = powerIconImages.get(power.id);
    if (!image || !image.complete || !image.naturalWidth) return;
    const scale = targetSize / Math.max(image.naturalWidth, image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    this.ctx.drawImage(image, x - width / 2, y - height / 2, width, height);
  }

  drawFace(mood, dead) {
    this.ctx.fillStyle = "#301b23";
    this.ctx.beginPath();
    this.ctx.ellipse(-radius * 0.32, radius * 0.1, radius * 0.12, radius * 0.25, 0.04, 0, Math.PI * 2);
    this.ctx.ellipse(radius * 0.36, radius * 0.1, radius * 0.12, radius * 0.25, -0.04, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.fillStyle = "rgba(255,255,255,0.7)";
    this.ctx.beginPath();
    this.ctx.arc(-radius * 0.37, -radius * 0.02, radius * 0.045, 0, Math.PI * 2);
    this.ctx.arc(radius * 0.31, -radius * 0.02, radius * 0.045, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.strokeStyle = "#301b23";
    this.ctx.lineWidth = 4.2;
    this.ctx.beginPath();
    if (dead || mood === "sad") this.ctx.arc(0, radius * 0.48, radius * 0.16, Math.PI * 1.12, Math.PI * 1.88);
    else if (mood === "expectant" || mood === "puzzled") this.ctx.arc(0, radius * 0.34, radius * 0.075, 0, Math.PI * 2);
    else this.ctx.arc(0, radius * 0.25, radius * 0.2, 0.2, Math.PI - 0.2);
    this.ctx.stroke();
    if (mood === "puzzled") {
      this.ctx.fillStyle = "#301b23";
      this.ctx.font = `bold ${radius * 0.22}px sans-serif`;
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText("?", 0, -radius * 0.38);
    }
  }

  drawMiniStatus(now) {
    const local = this.localPlayer();
    if (!local) return;
    if (local.effects.splatMessageUntil > now) {
      const left = Math.ceil((local.effects.splatMessageUntil - now) / 1000);
      this.overlay.innerHTML = `<div class="splat-message">You went splat! ${left}</div>`;
    } else if (this.phase === "playing" && this.overlay.querySelector(".splat-message")) {
      this.overlay.innerHTML = "";
    }
  }

  localPlayer() {
    return this.players.find((player) => player.local);
  }

  random() {
    return this.rng();
  }

  matchTime(now = performance.now()) {
    return now - this.countdownAt;
  }

  localTimeForMatch(matchTime) {
    return this.countdownAt + Number(matchTime || this.matchTime());
  }

  sortedKeys() {
    return [...this.keys].sort();
  }

  inputKeys() {
    return {
      up: this.keys.has("KeyW"),
      down: this.keys.has("KeyS"),
      left: this.keys.has("KeyA"),
      right: this.keys.has("KeyD")
    };
  }

  receiveRemoteInput(event) {
    if (!this.multiplayer || this.authoritative || event?.type !== "input" || !event.playerSocketId) return;
    this.remoteInputs.set(event.playerSocketId, { keys: event.keys || [] });
    const player = this.players.find((candidate) => candidate.socketId === event.playerSocketId);
    if (player && !player.local && event.usePower) {
      player.inputUsePower = true;
      player.inputUsePowerAt = this.localTimeForMatch(event.matchTime);
    }
  }

  sendInputIfChanged(force) {
    if (!this.multiplayer || !this.hooks.onInput) return;
    const keys = this.authoritative ? this.inputKeys() : this.sortedKeys();
    const signature = this.authoritative ? JSON.stringify(keys) : keys.join("|");
    if (!force && signature === this.lastInputSignature) return;
    this.lastInputSignature = signature;
    this.hooks.onInput({ type: "input", keys, usePower: false, matchTime: this.matchTime() });
  }

  applyServerSnapshot(snapshot) {
    if (!this.authoritative || !snapshot) return;
    this.serverTimeRemainingMs = Number(snapshot.timeRemainingMs ?? this.serverTimeRemainingMs);
    this.powerUps = (snapshot.powerUps || []).map((power) => ({
      id: power.id,
      x: Number(power.x || 0),
      y: Number(power.y || 0),
      born: performance.now() - Math.max(0, Date.now() - Number(power.born || Date.now()))
    }));
    const known = new Map(this.players.map((player) => [player.id, player]));
    const receivedAt = performance.now();
    for (const item of snapshot.players || []) {
      let player = known.get(item.id);
      if (!player) {
        player = this.createPlayers([{ ...item, local: item.socketId === this.config.localSocketId }])[0];
        this.players.push(player);
      }
      player.socketId = item.socketId;
      player.name = item.name || player.name;
      player.color = item.color || player.color;
      player.connected = item.connected !== false;
      player.targetX = Number(item.x || 0);
      player.targetY = Number(item.y || 0);
      player.targetVx = Number(item.vx || 0);
      player.targetVy = Number(item.vy || 0);
      player.targetAngle = Number(item.angle || 0);
      player.targetScore = Number(item.score || 0);
      const previousPower = player.power?.id || null;
      const previousRolling = player.rollingPower?.id || null;
      const previousBounceUntil = player.bounceUntil || 0;
      player.power = powerById(item.power);
      player.rollingPower = powerById(item.rollingPower);
      player.rollEndsAt = localExpiryTime(item.rollEndsAt);
      player.effects = localEffectTimes(item.effects || {});
      player.shieldUntil = localExpiryTime(item.shieldUntil);
      player.bounceUntil = localExpiryTime(item.bounceUntil);
      player.bounceMoveUntil = localExpiryTime(item.bounceMoveUntil);
      if (player.local && !previousRolling && player.rollingPower) {
        this.lastPowerShuffleStep = -1;
      }
      if (player.local && previousRolling && !player.rollingPower && player.power) {
        this.lastPowerShuffleStep = -1;
        Sound.play("power");
      }
      if (player.local && previousPower && !player.power && !player.rollingPower) {
        Sound.play(previousPower === "reverse" ? "swishoo" : previousPower === "splat" ? "splat" : "power");
      }
      if (player.local && previousBounceUntil <= performance.now() && player.bounceUntil > performance.now()) {
        Sound.play("thud");
      }
      player.serverFrames = (player.serverFrames || []).concat({
        receivedAt,
        x: player.targetX,
        y: player.targetY,
        vx: player.targetVx,
        vy: player.targetVy,
        angle: player.targetAngle
      }).slice(-8);
      if (!player.hasServerPosition) {
        player.x = player.targetX;
        player.y = player.targetY;
        player.vx = player.targetVx;
        player.vy = player.targetVy;
        player.angle = player.targetAngle;
        player.hasServerPosition = true;
      }
    }
  }

  applyPaintBatch(batch) {
    if (!this.authoritative || !batch?.stamps?.length) return;
    const receivedAt = performance.now();
    this.pendingPaintStamps.push(...batch.stamps.map((stamp) => ({ ...stamp, receivedAt })));
  }

  flushPendingPaintStamps(now) {
    if (!this.pendingPaintStamps.length) return;
    const ready = [];
    this.pendingPaintStamps = this.pendingPaintStamps.filter((stamp) => {
      if (now - stamp.receivedAt >= 110) {
        ready.push(stamp);
        return false;
      }
      return true;
    });
    for (const stamp of ready) this.drawServerPaintStamp(stamp);
  }

  drawServerPaintStamp(stamp) {
    const color = PLAYER_COLORS[stamp.color]?.paint || PLAYER_COLORS[this.players.find((player) => player.id === stamp.playerId)?.color]?.paint;
    if (!color) return;
    if (stamp.type === "splat") {
      const playerColor = PLAYER_COLORS[stamp.color] ? stamp.color : this.players.find((player) => player.id === stamp.playerId)?.color;
      if (playerColor) this.paintSplatAsset(Number(stamp.x || 0), Number(stamp.y || 0), playerColor, Number(stamp.radius || radius * 6));
      return;
    }
    this.paintCtx.save();
    this.paintCtx.globalCompositeOperation = "source-over";
    this.paintCtx.fillStyle = color;
    this.paintCtx.beginPath();
    this.paintCtx.arc(Number(stamp.x || 0), Number(stamp.y || 0), Number(stamp.radius || radius), 0, Math.PI * 2);
    this.paintCtx.fill();
    this.paintCtx.restore();
  }

  applyScoreUpdate(update) {
    if (!this.authoritative || !update?.scores) return;
    for (const score of update.scores) {
      const player = this.players.find((candidate) => candidate.id === score.playerId);
      if (player) {
        player.coverage = Number(score.score || 0);
        player.targetScore = player.coverage;
      }
    }
  }

  applyGameOver(result) {
    if (!this.authoritative || !result) return;
    this.serverGameOver = result;
    this.phase = "stop";
    this.applyScoreUpdate({ scores: result.finalScores || [] });
    this.winner = this.players.find((player) => player.id === result.winnerPlayerId) || null;
    this.overlay.innerHTML = `<div class="countdown">Stop!</div>`;
    if (this.hud.results) this.hud.results.innerHTML = "";
    this.players.forEach((player) => (player.mood = "expectant"));
    setTimeout(() => this.revealServerResults(result), 1200);
  }

  revealServerResults(result) {
    if (!this.running || this.phase !== "stop") return;
    this.overlay.innerHTML = `<div class="countdown">Calculating...</div>`;
    this.prepareScoreSlots();
    const scoreMap = new Map((result.finalScores || []).map((score) => [score.playerId, Number(score.score || 0)]));
    const standings = [...this.players]
      .map((player) => ({ ...player, coverage: scoreMap.get(player.id) ?? player.coverage }))
      .sort((a, b) => (b.coverage - a.coverage) || a.spawnIndex - b.spawnIndex);
    [...standings].reverse().forEach((player, index) => {
      setTimeout(() => {
        if (!this.running || this.phase !== "stop") return;
        this.addScoreRow(player, standings.findIndex((item) => item.id === player.id) + 1);
        Sound.play("score", index);
        if (index === standings.length - 1) this.resolveServerWinner(result.winnerPlayerId, standings);
      }, 900 + index * 1000);
    });
  }

  resolveServerWinner(winnerPlayerId, standings) {
    this.phase = "results";
    this.winner = this.players.find((player) => player.id === winnerPlayerId) || standings[0] || null;
    this.players.forEach((player) => (player.mood = player.id === this.winner?.id ? "happy" : "sad"));
    this.releaseConfetti();
    const label = this.winner ? (this.winner.local ? "You win!" : `${this.winner.name} wins!`) : "Match over";
    this.overlay.innerHTML = `
      <div class="countdown result-title">${escapeText(label)}</div>
      <div class="result-actions">
        <button class="button asset-button result-asset-button" data-game-action="menu" aria-label="Main Menu"><img src="/assets/ui/main-menu.png" alt="" draggable="false" /></button>
      </div>
    `;
    this.overlay.querySelector('[data-game-action="menu"]').addEventListener("click", () => this.hooks.onMenu?.());
    Sound.play("fanfare");
    if (this.winner?.local) Sound.play("win");
  }

}

function closeTo(pixel, hex) {
  const rgb = hexToRgb(hex);
  return Math.abs(pixel[0] - rgb.r) + Math.abs(pixel[1] - rgb.g) + Math.abs(pixel[2] - rgb.b) < 86;
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function scoreBlobDataUri(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90">
    <ellipse cx="61" cy="78" rx="39" ry="8" fill="rgba(50,24,61,.2)"/>
    <path d="M12 54C10 24 33 9 60 10c29 1 51 16 50 45-1 24-22 31-50 31-30 0-47-8-48-32Z" fill="${color.paint}" stroke="${color.dark}" stroke-width="8" stroke-linejoin="round"/>
    <ellipse cx="36" cy="42" rx="17" ry="30" fill="#fff" opacity=".18" transform="rotate(-10 36 42)"/>
    <ellipse cx="84" cy="28" rx="10" ry="17" fill="#fff" opacity=".22" transform="rotate(-38 84 28)"/>
    <ellipse cx="48" cy="48" rx="5" ry="11" fill="#301b23"/>
    <ellipse cx="74" cy="48" rx="5" ry="11" fill="#301b23"/>
    <circle cx="46" cy="43" r="2.2" fill="#fff" opacity=".72"/>
    <circle cx="72" cy="43" r="2.2" fill="#fff" opacity=".72"/>
    <path d="M55 66q6 7 13 0" fill="none" stroke="#301b23" stroke-width="4" stroke-linecap="round"/>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function shuffle(items, random = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = (random() * (index + 1)) | 0;
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function oppositeTravelDirection(player, fallbackX, fallbackY) {
  const speed = Math.hypot(player.vx, player.vy);
  if (speed > 8) return { x: -player.vx / speed, y: -player.vy / speed };
  const fallbackLength = Math.hypot(fallbackX, fallbackY) || 1;
  return { x: fallbackX / fallbackLength, y: fallbackY / fallbackLength };
}

function orderedPlaceBands(currentIndex) {
  const own = placePowerBands[currentIndex] || placePowerBands[placePowerBands.length - 1];
  const worsePlaces = placePowerBands.slice(currentIndex + 1);
  const betterPlaces = placePowerBands.slice(0, currentIndex).reverse();
  return [own, ...worsePlaces, ...betterPlaces];
}

function weightedChoice(items, weights, random = Math.random) {
  const total = items.reduce((sum, _, index) => sum + (weights[index] || 0), 0);
  let roll = random() * total;
  for (let index = 0; index < items.length; index += 1) {
    roll -= weights[index] || 0;
    if (roll <= 0) return items[index];
  }
  return items[items.length - 1];
}

function powerById(id) {
  return POWER_UPS.find((power) => power.id === id) || null;
}

function localExpiryTime(serverExpiry) {
  const expiry = Number(serverExpiry || 0);
  return expiry > Date.now() ? performance.now() + (expiry - Date.now()) : 0;
}

function localEffectTimes(effects) {
  return Object.fromEntries(Object.entries(effects || {}).map(([key, value]) => [key, localExpiryTime(value)]));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

function seededRandom(seed) {
  let state = hashSeed(String(seed));
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function playerSizeMultiplier(player, now) {
  const grow = player.effects.growUntil > now ? 1.3 : 1;
  const shrink = player.effects.shrinkUntil > now ? 0.7 : 1;
  return grow * shrink;
}

function blobOutlineRadius(angle, size = 1) {
  const x = Math.cos(angle) / (bodyHalfWidth * size);
  const y = Math.sin(angle) / (bodyHalfHeight * size);
  return 1 / Math.hypot(x, y);
}

function pointInsideBlobOutline(x, y, player, now) {
  const size = playerSizeMultiplier(player, now);
  const localX = x - player.x;
  const localY = y - player.y;
  return (localX / (bodyHalfWidth * size)) ** 2 + (localY / (bodyHalfHeight * size)) ** 2 <= 1;
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
    [bodyHalfWidth * size, 0],
    [-bodyHalfWidth * size, 0],
    [0, bodyHalfHeight * size],
    [0, -bodyHalfHeight * size],
    [bodyHalfWidth * size * 0.72, bodyHalfHeight * size * 0.7],
    [-bodyHalfWidth * size * 0.72, bodyHalfHeight * size * 0.7],
    [bodyHalfWidth * size * 0.62, -bodyHalfHeight * size * 0.78],
    [-bodyHalfWidth * size * 0.62, -bodyHalfHeight * size * 0.78]
  ].map(([x, y]) => ({ x: player.x + x, y: player.y + y }));
}

function projectileHitsPlayer(projectile, player, now) {
  if (player.deadUntil > now) return false;
  const broadPhase = Math.hypot(player.x - projectile.x, player.y - projectile.y) <= (bodyHalfWidth * playerSizeMultiplier(player, now)) + projectile.size;
  if (!broadPhase) return false;
  return projectileOutlinePoints(projectile).some((point) => pointInsideBlobOutline(point.x, point.y, player, now))
    || blobOutlinePoints(player, now).some((point) => pointInsideProjectileOutline(point.x, point.y, projectile));
}

function projectileSize(type) {
  if (type === "paintball") return paintballProjectileRadius;
  if (type === "freeze") return freezeProjectileRadius;
  if (type === "banana") return bananaProjectileLength;
  return spikyProjectileSpikeRadius;
}

function approachVelocity(current, target, dt) {
  if (current === target) return current;
  const movingTowardZero = target === 0 || Math.sign(current) !== Math.sign(target);
  const step = (movingTowardZero ? decelerationPerSecond : accelerationPerSecond) * dt;
  if (Math.abs(target - current) <= step) return target;
  return current + Math.sign(target - current) * step;
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  };
}

function lighten(hex) {
  const rgb = hexToRgb(hex);
  const channels = [rgb.r, rgb.g, rgb.b].map((channel) => Math.min(255, Math.round(channel + (255 - channel) * 0.32)));
  return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
