import { COLOR_ORDER, PLAYER_COLORS, POWER_UPS } from "../config.js";
import { escapeHtml, fittedTextStyle } from "../utils/html.js";

const APP_VERSION = "0.8.1";

const assetButtons = {
  "Singleplayer": "/assets/ui/singleplayer.png",
  "Multiplayer": "/assets/ui/multiplayer.png",
  "Host Game": "/assets/ui/host-game.png",
  "Join Game": "/assets/ui/join-game.png",
  "Play Again": "/assets/ui/play-again.png",
  "Main Menu": "/assets/ui/main-menu.png"
};

export function button(label, action, extra = "") {
  const asset = !extra && assetButtons[label];
  if (asset) {
    return `<button class="button asset-button" data-action="${action}" aria-label="${escapeHtml(label)}"><img src="${asset}" alt="" draggable="false" /></button>`;
  }
  return `<button class="button ${extra}" data-action="${action}"><span>${escapeHtml(label)}</span></button>`;
}

export function renderTitle(state) {
  return `
    <main class="screen menu-screen">
      ${menuSplats()}
      ${splobTitle()}
      <nav class="menu-stack" aria-label="Main menu">
        ${button("Singleplayer", "singleplayer")}
        ${button("Multiplayer", "multiplayer")}
      </nav>
      <div class="version-label">Version: ${APP_VERSION}</div>
      ${cornerButtons(state)}
      ${state.modal ? modal(state.modal) : ""}
    </main>
  `;
}

export function renderMultiplayer(state) {
  return `
    <main class="screen menu-screen">
      ${menuSplats()}
      ${splobTitle()}
      <nav class="menu-stack" aria-label="Multiplayer menu">
        ${button("Host Game", "host")}
        ${button("Join Game", "join")}
      </nav>
      ${button("Back", "back", "button-small back-button")}
      ${cornerButtons(state)}
      ${state.modal ? modal(state.modal) : ""}
    </main>
  `;
}

export function renderLobby(state) {
  const lobby = state.lobby;
  const isHost = lobby?.players?.[0]?.local;
  const slots = Array.from({ length: 4 }, (_, index) => lobby?.players?.[index] || null);
  return `
    <main class="screen lobby-screen">
      ${menuSplats()}
      <section class="panel lobby-panel">
        <div class="panel-heading">
          <span>Lobby Code</span>
          <strong class="lobby-code">${lobby?.code || "----"}</strong>
        </div>
        <label class="toggle-row">
          <input type="checkbox" name="public" ${lobby?.public ? "checked" : ""} ${isHost ? "" : "disabled"} />
          <span>Public game</span>
        </label>
        <div class="slot-grid">
          ${slots.map((player, index) => playerSlot(player, index, isHost)).join("")}
        </div>
        <div class="dialog-actions">
          ${button("Leave", "back", "button-small button-secondary")}
          ${button(slots.find((slot) => slot?.local)?.ready ? "Not Ready" : "Ready-Up", "ready", "button-small")}
          ${button("Start Game", "startMultiplayer", `button-small ${isHost ? "" : "disabled"}`)}
        </div>
      </section>
      ${state.modal ? modal(state.modal) : ""}
    </main>
  `;
}

export function renderJoin(state) {
  return `
    <main class="screen join-screen">
      ${menuSplats()}
      <section class="panel join-panel">
        <div class="join-grid">
          <section>
            <h2>Private Lobby</h2>
            <div class="code-inputs">
              ${[0, 1, 2, 3].map((index) => `<input data-code-index="${index}" maxlength="1" inputmode="numeric" />`).join("")}
            </div>
            ${button("Join Code", "joinPrivate", "button-small")}
          </section>
          <section>
            <div class="section-title">
              <h2>Public Lobbies</h2>
              ${button("Refresh", "refreshLobbies", "button-small")}
            </div>
            <div class="public-list">
              ${state.lobbies.length ? state.lobbies.map(publicLobby).join("") : `<p class="empty">No public games are waiting.</p>`}
            </div>
          </section>
        </div>
      </section>
      ${button("Back", "back", "button-small back-button")}
      ${state.modal ? modal(state.modal) : ""}
    </main>
  `;
}

export function renderGame(state) {
  const showDebug = Boolean(state?.settings?.debugPanel);
  return `
    <main class="screen game-screen">
      <div class="game-hud">
        <div class="score-panel" id="scorePanel" aria-live="polite"></div>
        <div class="timer-pill" id="timerPill">1:00</div>
      </div>
      <section class="canvas-frame">
        <canvas id="gameCanvas"></canvas>
        <div class="game-overlay" id="gameOverlay"></div>
      </section>
      ${showDebug ? debugPanel() : ""}
      <button class="button button-small button-secondary leave-game" data-action="leaveGame">Leave</button>
      <div class="power-stack">
        <button class="power-box" id="powerBox" type="button" aria-label="Use power-up"></button>
        <div class="fart-meter" id="fartMeter" aria-label="Fart meter"><span></span></div>
        <button class="fart-button" id="fartButton" type="button" aria-label="Fart">Fart</button>
      </div>
      ${state.modal ? modal(state.modal) : ""}
    </main>
  `;
}

export function optionsDialog(settings, profile) {
  return `
    <section class="dialog paint-dialog options-dialog" role="dialog" aria-modal="true" aria-labelledby="optionsTitle">
      <div class="dialog-heading">
        <span>Paint Bench</span>
        <h2 id="optionsTitle">Options</h2>
      </div>
      <label class="field">
        <span>Music</span>
        <input name="music" type="range" min="0" max="100" value="${settings.music}" />
      </label>
      <label class="field">
        <span>SFX</span>
        <input name="sfx" type="range" min="0" max="100" value="${settings.sfx}" />
      </label>
      <label class="field">
        <span>Username</span>
        <input name="username" maxlength="16" value="${escapeHtml(settings.username)}" placeholder="Player" />
      </label>
      <div class="field">
        <span>Preferred Splob Colour</span>
        <div class="swatch-row">
          ${COLOR_ORDER.map((color) => `<button class="swatch ${settings.preferredColor === color ? "active" : ""}" data-action="color:${color}" aria-label="${PLAYER_COLORS[color].name}" style="--swatch:${PLAYER_COLORS[color].paint}"></button>`).join("")}
        </div>
      </div>
      <div class="profile-row">
        <div>
          <span>Wholegrain Account</span>
          <strong ${fittedTextStyle(profile ? `${profile.username} #${profile.hash}` : "Not linked")}>${profile ? `${escapeHtml(profile.username)} #${profile.hash}` : "Not linked"}</strong>
        </div>
        ${button(profile?.identityId ? "Linked" : "Link Account", "linkAccount", "button-small")}
      </div>
      <div class="dialog-actions">${button("OK", "closeModal", "button-small")}</div>
    </section>
  `;
}

function debugPanel() {
  return `
    <aside class="debug-panel" aria-label="Debug controls">
      <div class="debug-heading">
        <span>Debug</span>
        <strong>Match Tools</strong>
      </div>
      <button class="debug-button" type="button" data-debug-action="togglePause">Pause timer</button>
      <div class="debug-power-grid" aria-label="Grant power-up">
        ${POWER_UPS.map((power) => `
          <button class="debug-power-button" type="button" data-debug-action="power:${power.id}" title="${escapeHtml(power.name)}" aria-label="Give ${escapeHtml(power.name)}">
            <img src="${power.iconSrc}" alt="" draggable="false" />
          </button>
        `).join("")}
      </div>
      <button class="debug-button debug-danger" type="button" data-debug-action="endMatch">End match</button>
    </aside>
  `;
}

export function usernameDialog(state) {
  const value = escapeHtml(state.settings.username || state.profile?.username || "");
  return `
    <section class="dialog paint-dialog username-dialog" role="dialog" aria-modal="true" aria-labelledby="usernameTitle">
      <div class="dialog-heading">
        <span>Profile</span>
        <h2 id="usernameTitle">Choose a username</h2>
      </div>
      <p class="empty">Multiplayer and friends need a Splob profile before they can connect.</p>
      <label class="field">
        <span>Username</span>
        <input name="usernamePrompt" maxlength="16" value="${value}" placeholder="Player" />
      </label>
      ${state.profileError ? `<p class="error">${escapeHtml(state.profileError)}</p>` : ""}
      <div class="dialog-actions">
        ${button("Cancel", "closeModal", "button-small button-secondary")}
        ${button("Save", "saveUsername", "button-small")}
      </div>
    </section>
  `;
}

export function multiplayerStatusDialog(status) {
  const heading = status?.state === "missing-url" ? "Relay not configured" : status?.state === "error" ? "Connection failed" : "Connecting";
  const message = status?.message || "Connecting to multiplayer. This can take up to 60 seconds if the relay is waking up.";
  const canClose = status?.state === "missing-url" || status?.state === "error" || status?.state === "closed";
  return `
    <section class="dialog paint-dialog relay-dialog" role="dialog" aria-modal="true" aria-labelledby="relayTitle">
      <div class="dialog-heading">
        <span>Multiplayer</span>
        <h2 id="relayTitle">${escapeHtml(heading)}</h2>
      </div>
      <p class="empty">${escapeHtml(message)}</p>
      ${canClose ? `<div class="dialog-actions">${button("OK", "closeModal", "button-small")}</div>` : `<div class="dialog-actions"><span class="loading-dot" aria-hidden="true"></span></div>`}
    </section>
  `;
}

export function friendsDialog(state) {
  const tab = state.friendsTab;
  const lists = { friends: state.friends, recents: state.recents, requests: state.requests, search: state.searchResults };
  const rows = lists[tab] || [];
  return `
    <section class="dialog paint-dialog friends-dialog" role="dialog" aria-modal="true" aria-labelledby="friendsTitle">
      <div class="profile-summary">
        <div>
          <span>Name</span>
          <strong id="friendsTitle" ${fittedTextStyle(state.profile?.username || "Profile")}>${state.profile ? escapeHtml(state.profile.username) : "Profile"}</strong>
        </div>
        <div>
          <span>Hash number</span>
          <strong>${state.profile ? `#${state.profile.hash}` : "Local"}</strong>
        </div>
      </div>
      <div class="tabs">
        ${["friends", "recents", "search", "requests"].map((item) => `<button class="${tab === item ? "active" : ""}" data-action="friendsTab:${item}">${item}${item === "requests" && state.requests.length ? ` <b>${state.requests.length}</b>` : ""}</button>`).join("")}
      </div>
      ${tab === "search" ? `<label class="field compact"><span>Search</span><input name="friendSearch" value="${escapeHtml(state.searchQuery)}" placeholder="Name #1234" /></label>` : ""}
      <div class="friend-list">
        ${rows.length ? rows.map((player) => friendRow(player, tab)).join("") : `<p class="empty">${tab === "search" ? "No matching players." : "No players here yet."}</p>`}
      </div>
      ${state.friendsError ? `<p class="error">${escapeHtml(state.friendsError)}</p>` : ""}
      <div class="dialog-actions">${button("Close", "closeModal", "button-small")}</div>
    </section>
  `;
}

export function confirmLeaveDialog() {
  return `
    <section class="dialog paint-dialog leave-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="leaveTitle">
      <div class="dialog-heading">
        <span>Leave game</span>
        <h2 id="leaveTitle">Are you sure you want to leave?</h2>
      </div>
      <div class="dialog-actions">
        ${button("No", "closeModal", "button-small button-secondary")}
        ${button("Yes", "confirmLeaveGame", "button-small")}
      </div>
    </section>
  `;
}

export function noticeDialog(title, action = "closeModal") {
  return `
    <section class="dialog paint-dialog notice-dialog" role="dialog" aria-modal="true">
      <p class="empty">${escapeHtml(title)}</p>
      <div class="dialog-actions">${button("OK", action, "button-small")}</div>
    </section>
  `;
}

export function playAgainWaitingDialog(state) {
  const deadline = Number(state.playAgainDeadline || 0);
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  const count = Number(state.playAgainCount || 1);
  return `
    <section class="dialog paint-dialog play-again-dialog" role="dialog" aria-modal="true" aria-labelledby="playAgainTitle">
      <div class="dialog-heading">
        <span>${seconds}s</span>
        <h2 id="playAgainTitle">Play again lobby</h2>
      </div>
      <p class="empty">${count} player${count === 1 ? "" : "s"} ready for another round.</p>
      <div class="dialog-actions">${button("Main Menu", "playAgainMainMenu", "button-small button-secondary")}</div>
    </section>
  `;
}

function friendRow(player, tab) {
  const label = `${player.username} #${player.hash}`;
  const actions = tab === "requests"
    ? `<button class="mini-action" data-action="acceptFriend:${player.id}">Accept</button><button class="mini-action" data-action="rejectFriend:${player.id}">Reject</button>`
    : tab === "friends"
      ? `<button class="mini-action" data-action="challengeFriend:${player.id}">Challenge</button><button class="mini-action" data-action="removeFriend:${player.id}">Remove</button>`
      : `<button class="mini-action" data-action="addFriend:${player.id}">Add Friend</button>`;
  return `<article class="friend-card"><strong ${fittedTextStyle(label)}>${escapeHtml(label)}</strong><div>${actions}</div></article>`;
}

function publicLobby(lobby) {
  return `<article class="public-card"><strong>${escapeHtml(lobby.host)}</strong><span>${lobby.players}/${lobby.capacity}</span>${button("Join", `joinPublic:${lobby.code}`, "button-small")}</article>`;
}

function playerSlot(player, index, isHost) {
  if (!player) return `<article class="player-slot empty"><span>Slot ${index + 1}</span><strong>Waiting...</strong></article>`;
  return `
    <article class="player-slot" style="--slot:${PLAYER_COLORS[player.color]?.paint || "#999"}">
      ${isHost && !player.local ? `<button class="slot-kick" data-action="kick:${player.socketId || player.id}" aria-label="Remove player">x</button>` : ""}
      <span>${player.local ? "You" : player.ai ? "Computer" : "Player"}</span>
      <strong>${escapeHtml(player.name || "Guest")}</strong>
      <small>${player.ready ? "Ready" : "Not ready"}</small>
    </article>
  `;
}

function cornerButtons(state) {
  return `
    <button class="friends-toggle" data-action="friends" aria-label="Friends">
      <img src="/assets/ui/profile.png" alt="" draggable="false" />
      ${state.requests.length ? `<b>${state.requests.length}</b>` : ""}
    </button>
    <button class="options-toggle" data-action="options" aria-label="Options"><img src="/assets/ui/settings.png" alt="" draggable="false" /></button>
  `;
}

function splobTitle() {
  return `<h1 class="splob-title"><img src="/assets/ui/title.png" alt="Splob!" draggable="false" /></h1>`;
}

function menuSplats() {
  const splats = [
    { asset: "splat-1.png", x: "7%", y: "72%", size: "15rem", rotate: "-12deg" },
    { asset: "splat-2.png", x: "92%", y: "22%", size: "12rem", rotate: "14deg" },
    { asset: "splat-3.png", x: "86%", y: "80%", size: "14rem", rotate: "8deg" },
    { asset: "splat-1.png", x: "16%", y: "20%", size: "8rem", rotate: "22deg" }
  ];
  return `<div class="menu-splats" aria-hidden="true">
    ${splats.map((splat) => `<span class="menu-splat" style="--splat-image:url('/assets/splats/${splat.asset}');--splat-color:${randomSplatColor()};--splat-x:${splat.x};--splat-y:${splat.y};--splat-size:${splat.size};--splat-rotate:${splat.rotate}"></span>`).join("")}
  </div>`;
}

function randomSplatColor() {
  return `hsl(${Math.floor(Math.random() * 360)} 88% 52%)`;
}

function modal(content) {
  return `<div class="dialog-backdrop" data-action="closeModal">${content}</div>`;
}
