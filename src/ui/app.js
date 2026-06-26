import { COLOR_ORDER } from "../config.js";
import { Sound } from "../audio/sound.js";
import { SplobGame } from "../game/splob-game.js";
import { RelayClient } from "../network/relay-client.js";
import { loadSettings, sanitizeUsername, saveSettings } from "../state/settings.js";
import {
  answerFriendRequest,
  addRecentPlayer,
  fetchFriendsAndRecents,
  fetchProfile,
  readCachedProfile,
  removeFriend,
  requestFriend,
  searchPlayers,
  setRemoteUsername,
  wholegrainLinkUrl
} from "../services/profile.js";
import {
  confirmLeaveDialog,
  friendsDialog,
  howToPlayDialog,
  noticeDialog,
  optionsDialog,
  playAgainWaitingDialog,
  renderGame,
  renderJoin,
  renderLobby,
  renderMultiplayer,
  renderTitle,
  usernameDialog
} from "./templates.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

export function createApp(root) {
  const state = {
    screen: "title",
    previous: [],
    settings: loadSettings(),
    profile: readCachedProfile(),
    modal: "",
    relay: null,
    lobbies: [],
    lobby: null,
    game: null,
    pendingGame: null,
    inputSeq: 0,
    serverPlayerId: "",
    friendsTab: "friends",
    friends: [],
    recents: [],
    requests: [],
    searchResults: [],
    searchQuery: "",
    friendsError: "",
    profileError: "",
    pendingProfileAction: "",
    pendingChallenge: null,
    incomingInvite: null,
    inviteNotice: null,
    profileStatuses: {},
    searchSeq: 0,
    searchTimer: 0,
    playAgainDeadline: 0,
    playAgainCount: 0,
    playAgainTimer: 0,
    relayStatus: null
  };

  Sound.configure(state.settings.sfx / 100);
  fetchProfile().then((profile) => {
    if (profile) {
      state.profile = profile;
      state.relay?.send({ type: "identify", profile });
      app.render();
      refreshFriends();
    }
  }).catch((error) => {
    state.profileError = error.message || "Profile service is unavailable.";
  });

  const app = {
    render() {
      if (state.screen === "game" && state.game) {
        updateGameModal();
        return;
      }
      if (state.game) {
        state.game.stop();
        state.game = null;
      }
      const renderer = {
        title: renderTitle,
        multiplayer: renderMultiplayer,
        lobby: renderLobby,
        join: renderJoin,
        game: renderGame
      }[state.screen] || renderTitle;
      root.innerHTML = renderer(state);
      bind();
      if (state.screen === "game") startCanvasGame();
    }
  };

  function updateGameModal() {
    root.querySelector(".dialog-backdrop")?.remove();
    if (!state.modal) return;
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.dataset.action = "closeModal";
    backdrop.innerHTML = state.modal;
    backdrop.addEventListener("click", (event) => {
      event.stopPropagation();
      handleAction("closeModal");
    });
    backdrop.querySelectorAll(".dialog").forEach((element) => {
      element.addEventListener("click", (event) => event.stopPropagation());
    });
    backdrop.querySelectorAll("[data-action]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        handleAction(element.dataset.action);
      });
    });
    root.querySelector(".game-screen")?.appendChild(backdrop);
  }

  function go(screen) {
    if (state.screen !== screen) state.previous.push(state.screen);
    state.screen = screen;
    state.modal = "";
    app.render();
  }

  function back() {
    state.screen = state.previous.pop() || "title";
    state.modal = "";
    app.render();
  }

  function bind() {
    root.querySelectorAll(".dialog").forEach((element) => {
      element.addEventListener("click", (event) => event.stopPropagation());
    });
    root.querySelectorAll("[data-action]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        handleAction(element.dataset.action);
      });
    });
    root.querySelectorAll("input[name=music], input[name=sfx]").forEach((input) => {
      input.addEventListener("input", () => {
        state.settings[input.name] = Number(input.value);
        saveSettings(state.settings);
        Sound.configure(state.settings.sfx / 100);
      });
    });
    root.querySelector("input[name=debugPanel]")?.addEventListener("change", (event) => {
      state.settings.debugPanel = event.target.checked;
      saveSettings(state.settings);
      if (state.modal.includes("options-dialog")) state.modal = optionsDialog(state.settings, state.profile);
      app.render();
    });
    root.querySelectorAll("input[name=username]").forEach((input) => {
      input.addEventListener("change", async () => {
        state.settings.username = sanitizeUsername(input.value);
        saveSettings(state.settings);
        if (state.settings.username.trim()) {
          try {
            state.profile = await setRemoteUsername(state.settings.username.trim());
            state.relay?.send({ type: "identify", profile: state.profile });
            state.profileError = "";
            refreshFriends();
          } catch (error) {
            state.profileError = error.message || "Profile service is unavailable.";
          }
        }
        app.render();
      });
    });
    root.querySelector("input[name=usernamePrompt]")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") saveUsername();
    });
    root.querySelectorAll("input[name=public]").forEach((input) => {
      input.addEventListener("change", () => {
        if (!state.lobby) return;
        state.lobby.public = input.checked;
        state.relay?.send({ type: "lobby:update", lobby: state.lobby });
        app.render();
      });
    });
    const codeInputs = [...root.querySelectorAll("[data-code-index]")];
    codeInputs.forEach((input, index) => {
      input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(0, 1);
        if (input.value && codeInputs[index + 1]) codeInputs[index + 1].focus();
      });
    });
    root.querySelector("input[name=friendSearch]")?.addEventListener("input", (event) => {
      state.searchQuery = event.target.value;
      window.clearTimeout(state.searchTimer);
      const seq = ++state.searchSeq;
      state.searchTimer = window.setTimeout(() => {
        searchPlayers(state.searchQuery).then((results) => {
          if (seq !== state.searchSeq) return;
          state.searchResults = results;
          watchVisibleProfiles();
          state.modal = friendsDialog(state);
          app.render();
          const input = root.querySelector("input[name=friendSearch]");
          input?.focus();
          input?.setSelectionRange?.(input.value.length, input.value.length);
        }).catch(() => {
          if (seq !== state.searchSeq) return;
          state.searchResults = [];
          state.modal = friendsDialog(state);
          app.render();
        });
      }, 180);
    });
  }

  function handleAction(action) {
    Sound.play("tap");
    if (action?.startsWith("color:")) return chooseColor(action.split(":")[1]);
    if (action?.startsWith("joinPublic:")) return joinLobby(action.split(":")[1]);
    if (action?.startsWith("kick:")) return kickPlayer(action.split(":")[1]);
    if (action?.startsWith("friendsTab:")) return openFriends(action.split(":")[1]);
    if (action?.startsWith("addFriend:")) return friendAction(action.split(":")[1], "add");
    if (action?.startsWith("removeFriend:")) return friendAction(action.split(":")[1], "remove");
    if (action?.startsWith("acceptFriend:")) return friendAction(action.split(":")[1], "accept");
    if (action?.startsWith("rejectFriend:")) return friendAction(action.split(":")[1], "reject");
    if (action?.startsWith("challengeFriend:")) return challengeFriend(action.split(":")[1]);
    const actions = {
      singleplayer: () => startGame({ mode: "singleplayer", players: localPlayers() }),
      multiplayer: () => requireProfile("multiplayer") || openMultiplayerMenu(),
      host: () => requireProfile("host") || hostLobby(),
      join: () => requireProfile("join") || openJoin(),
      refreshLobbies: () => state.relay?.send({ type: "lobbies:list" }),
      joinPrivate: () => joinPrivate(),
      ready: () => toggleReady(),
      startMultiplayer: () => startMultiplayer(),
      back,
      leaveGame: () => {
        state.modal = confirmLeaveDialog();
        app.render();
      },
      confirmLeaveGame: () => leaveCurrentGame(),
      playAgainMainMenu: () => choosePlayAgain(false),
      playAgainAloneOk: () => go("title"),
      acceptInvite: () => acceptInvite(),
      declineInvite: () => declineInvite(),
      options: () => {
        state.modal = optionsDialog(state.settings, state.profile);
        app.render();
      },
      friends: () => openFriends("friends"),
      howToPlay: () => {
        state.modal = howToPlayDialog();
        app.render();
      },
      closeModal: () => {
        if (state.modal.includes("play-again-alone")) return go("title");
        if (state.modal.includes("play-again-dialog")) return choosePlayAgain(false);
        if (state.incomingInvite) state.relay?.send({ type: "declineInvite", lobbyId: state.incomingInvite.lobbyId });
        state.incomingInvite = null;
        state.inviteNotice = null;
        state.modal = "";
        app.render();
      },
      saveUsername: () => saveUsername(),
      linkAccount: () => window.open(wholegrainLinkUrl(), "_blank", "noopener")
    };
    actions[action]?.();
  }

  function startCanvasGame() {
    const canvas = root.querySelector("#gameCanvas");
    const overlay = root.querySelector("#gameOverlay");
    const hud = {
      timer: root.querySelector("#timerPill"),
      power: root.querySelector("#powerBox"),
      fart: root.querySelector("#fartMeter"),
      results: root.querySelector("#scorePanel")
    };
    state.game = new SplobGame(canvas, overlay, hud, state.pendingGame, {
      onAgain: () => {
        if (state.pendingGame?.authoritative) return choosePlayAgain(true);
        startGame(state.pendingGame);
      },
      onMenu: () => {
        if (state.pendingGame?.authoritative) state.relay?.send({ type: "playAgain:decide", again: false });
        go("title");
      },
      onDebug: (event) => sendDebugEvent(event),
      onInput: (event) => {
        if (state.pendingGame?.authoritative) {
          state.relay?.send({
            type: "input",
            seq: ++state.inputSeq,
            keys: event.keys,
            clientTime: Date.now()
          });
          if (event.usePower) {
            state.relay?.send({ type: "usePower", seq: state.inputSeq, clientTime: Date.now() });
          }
          if (event.useFart) {
            state.relay?.send({ type: "useFart", seq: state.inputSeq, clientTime: Date.now() });
          }
          return;
        }
        state.relay?.send({ type: "game:event", event: { ...event, playerSocketId: state.relay.id } });
      }
    });
    bindPointerControls(canvas, hud.power, root.querySelector("#fartButton"));
    bindDebugControls();
    state.game.start();
  }

  function bindDebugControls() {
    root.querySelectorAll("[data-debug-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const action = button.dataset.debugAction;
        if (action === "togglePause") {
          const paused = state.game?.debugToggleTimerPause?.();
          button.textContent = paused ? "Resume timer" : "Pause timer";
          return;
        }
        if (action === "endMatch") {
          state.game?.debugEndMatch?.();
          return;
        }
        if (action?.startsWith("power:")) {
          state.game?.debugGrantPower?.(action.split(":")[1]);
        }
      });
    });
  }

  function sendDebugEvent(event) {
    if (!state.settings.debugPanel || !state.pendingGame?.authoritative) return;
    state.relay?.send({
      type: "debug",
      action: event.action,
      powerId: event.powerId,
      clientTime: Date.now()
    });
  }

  function bindPointerControls(canvas, powerBox, fartButton) {
    const moveToPointer = (event) => {
      event.preventDefault();
      state.game?.setPointerTarget(event.clientX, event.clientY);
    };
    const releasePointer = (event) => {
      event.preventDefault();
      canvas.releasePointerCapture?.(event.pointerId);
      state.game?.clearPointerTarget();
    };
    canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
      state.game?.setPointerTarget(event.clientX, event.clientY);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!state.game?.hasPointerTarget?.()) return;
      moveToPointer(event);
    });
    canvas.addEventListener("pointerup", releasePointer);
    canvas.addEventListener("pointercancel", releasePointer);
    canvas.addEventListener("lostpointercapture", () => state.game?.clearPointerTarget());
    powerBox?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.game?.triggerPower();
    });
    fartButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.game?.triggerFart();
    });
  }

  function startGame(config) {
    stopPlayAgainTimer();
    if (state.game) {
      state.game.stop();
      state.game = null;
    }
    state.pendingGame = { ...config, preferredColor: state.settings.preferredColor };
    recordRecentPlayers(state.pendingGame.players || []);
    state.screen = "game";
    state.modal = "";
    app.render();
  }

  function username() {
    return state.profile?.username || state.settings.username.trim() || "You";
  }

  function localPlayers() {
    return [{ id: "local", local: true, name: username(), color: state.settings.preferredColor }];
  }

  function openMultiplayerMenu() {
    go("multiplayer");
    ensureRelay();
  }

  function ensureRelay() {
    if (state.relay) return state.relay;
    state.relay = new RelayClient();
    state.relay.onStatus = (status) => {
      state.relayStatus = status;
      if (status.state === "connected") {
        if (state.profile) state.relay?.send({ type: "identify", profile: state.profile });
        app.render();
        return;
      }
      if (status.state === "missing-url" || status.state === "error") {
        state.modal = noticeDialog(status.message || "Multiplayer is unavailable.");
        app.render();
      }
    };
    state.relay.onLobbies = (lobbies) => {
      state.lobbies = lobbies;
      app.render();
    };
    state.relay.onLobby = (lobby) => {
      state.lobby = lobby;
      state.modal = "";
      if (state.pendingChallenge && lobby?.players?.length === 1) {
        state.relay?.send({ type: "inviteFriend", targetProfileId: state.pendingChallenge.id, lobbyId: lobby.id || lobby.code });
        state.pendingChallenge = null;
      }
      if (state.screen !== "lobby") go("lobby");
      else app.render();
    };
    state.relay.onGameStart = (config) => startGame(config);
    state.relay.onJoined = (message) => {
      state.serverPlayerId = message.playerId;
    };
    state.relay.onSnapshot = (snapshot) => state.game?.applyServerSnapshot?.(snapshot);
    state.relay.onPaintBatch = (batch) => state.game?.applyPaintBatch?.(batch);
    state.relay.onScoreUpdate = (update) => state.game?.applyScoreUpdate?.(update);
    state.relay.onSuddenDeath = (message) => state.game?.applyServerSuddenDeath?.(message);
    state.relay.onGameOver = (result) => state.game?.applyGameOver?.(result);
    state.relay.onPlayAgainUpdate = (message) => {
      state.playAgainDeadline = message.deadline;
      state.playAgainCount = message.count;
      state.modal = playAgainWaitingDialog(state);
      app.render();
      startPlayAgainTimer();
    };
    state.relay.onPlayAgainAlone = () => {
      stopPlayAgainTimer();
      state.modal = `<div class="play-again-alone">${noticeDialog("No other players chose Play Again.", "playAgainAloneOk")}</div>`;
      app.render();
    };
    state.relay.onInviteChallenge = (message) => {
      state.incomingInvite = message;
      state.modal = `<section class="dialog paint-dialog invite-dialog" role="dialog" aria-modal="true"><p class="empty">${escapeHtml(message.from?.username || "A player")} challenged you to a game.</p><div class="dialog-actions"><button class="button button-small button-secondary" data-action="declineInvite"><span>Decline</span></button><button class="button button-small" data-action="acceptInvite"><span>Accept</span></button></div></section>`;
      app.render();
    };
    state.relay.onInviteUnavailable = (reason) => {
      const copy = {
        offline: "That player is offline.",
        "in-game": "This user is already in a game!",
        full: "That lobby is now full."
      }[reason] || "That challenge is unavailable.";
      state.inviteNotice = reason;
      state.modal = noticeDialog(copy);
      app.render();
    };
    state.relay.onInviteSent = () => {
      state.inviteNotice = "sent";
      state.modal = noticeDialog("Invitation sent.");
      app.render();
    };
    state.relay.onInviteDeclined = (message) => {
      state.inviteNotice = "rejected";
      state.modal = noticeDialog(`${message.from?.username || "That player"} rejected your challenge!`);
      app.render();
    };
    state.relay.onProfileStatuses = (statuses) => {
      state.profileStatuses = { ...state.profileStatuses, ...statuses };
      if (state.modal.includes("friends-dialog")) {
        state.modal = friendsDialog(state);
        app.render();
      }
    };
    state.relay.onServerError = (message) => {
      state.modal = `<section class="dialog paint-dialog"><h2>Server error</h2><p>${message.message || "The multiplayer server could not process that request."}</p><div class="dialog-actions"><button class="button button-small" data-action="closeModal"><span>OK</span></button></div></section>`;
      app.render();
    };
    state.relay.onGameEvent = (event) => {
      if (!state.game) return;
      if (event?.type === "input") state.game.receiveRemoteInput?.(event);
    };
    state.relay.onJoinError = () => {
      state.modal = `<section class="dialog paint-dialog"><h2>No lobby found</h2><p>That game does not exist or is full.</p><div class="dialog-actions"><button class="button button-small" data-action="closeModal"><span>OK</span></button></div></section>`;
      app.render();
    };
    state.relay.onGameError = (reason) => {
      const copy = reason === "not-enough-players"
        ? { title: "Need another player", body: "Multiplayer starts with 2 to 4 real players." }
        : { title: "Not ready yet", body: "Every player needs to ready-up before the match can start." };
      state.modal = `<section class="dialog paint-dialog"><h2>${copy.title}</h2><p>${copy.body}</p><div class="dialog-actions"><button class="button button-small" data-action="closeModal"><span>OK</span></button></div></section>`;
      app.render();
    };
    state.relay.onKicked = () => {
      state.lobby = null;
      go("multiplayer");
    };
    state.relay.connect();
    return state.relay;
  }

  function hostLobby() {
    const relay = ensureRelay();
    if (!relay.send({ type: "lobby:create", public: false, player: localLobbyPlayer() })) return;
  }

  function openJoin() {
    const relay = ensureRelay();
    if (!relay.send({ type: "lobbies:list" })) return;
    go("join");
  }

  function joinPrivate() {
    const code = [...root.querySelectorAll("[data-code-index]")].map((input) => input.value).join("");
    if (code.length === 4) joinLobby(code);
  }

  function joinLobby(code) {
    const relay = ensureRelay();
    if (!relay.send({ type: "lobby:join", code, player: localLobbyPlayer() })) return;
  }

  function localLobbyPlayer() {
    return {
      id: state.profile?.id,
      profileId: state.profile?.id,
      hash: state.profile?.hash,
      name: username(),
      color: state.settings.preferredColor
    };
  }

  function leaveCurrentGame() {
    if (state.pendingGame?.authoritative) state.relay?.send({ type: "game:leave" });
    go("title");
  }

  function choosePlayAgain(again) {
    if (!state.pendingGame?.authoritative) return;
    state.relay?.send({ type: "playAgain:decide", again });
    if (!again) return go("title");
    state.playAgainDeadline = Date.now() + 30000;
    state.playAgainCount = 1;
    state.modal = playAgainWaitingDialog(state);
    app.render();
    startPlayAgainTimer();
  }

  function startPlayAgainTimer() {
    stopPlayAgainTimer();
    state.playAgainTimer = window.setInterval(() => {
      if (!state.modal.includes("play-again-dialog")) return stopPlayAgainTimer();
      state.modal = playAgainWaitingDialog(state);
      app.render();
      if (Date.now() >= state.playAgainDeadline) stopPlayAgainTimer();
    }, 500);
  }

  function stopPlayAgainTimer() {
    if (!state.playAgainTimer) return;
    window.clearInterval(state.playAgainTimer);
    state.playAgainTimer = 0;
  }

  function toggleReady() {
    const me = state.lobby?.players.find((player) => player.local);
    if (!me) return;
    me.ready = !me.ready;
    state.relay?.send({ type: "lobby:update", lobby: state.lobby });
    app.render();
  }

  function chooseColor(color) {
    if (!COLOR_ORDER.includes(color)) return;
    state.settings.preferredColor = color;
    saveSettings(state.settings);
    const me = state.lobby?.players.find((player) => player.local);
    if (me && !state.lobby.players.some((player) => !player.local && player.color === color)) me.color = color;
    if (state.modal.includes("options-dialog")) state.modal = optionsDialog(state.settings, state.profile);
    app.render();
  }

  function kickPlayer(playerId) {
    state.relay?.send({ type: "lobby:kick", playerId });
  }

  function startMultiplayer() {
    if (!state.lobby?.players?.[0]?.local) return;
    if ((state.lobby.players || []).length < 2) {
      state.modal = `<section class="dialog paint-dialog"><h2>Need another player</h2><p>Multiplayer starts with 2 to 4 real players.</p><div class="dialog-actions"><button class="button button-small" data-action="closeModal"><span>OK</span></button></div></section>`;
      app.render();
      return;
    }
    if (state.lobby.players.some((player) => !player.ready)) {
      state.modal = `<section class="dialog paint-dialog"><h2>Not ready yet</h2><p>Every player needs to ready-up before the match can start.</p><div class="dialog-actions"><button class="button button-small" data-action="closeModal"><span>OK</span></button></div></section>`;
      app.render();
      return;
    }
    state.relay?.send({ type: "game:start", config: { mode: "multiplayer" } });
  }

  function challengeFriend(id) {
    const player = [...state.friends, ...state.recents, ...state.requests, ...state.searchResults].find((item) => item.id === id);
    if (!player) return;
    if (!hasProfile()) return requireProfile("friends:friends");
    const status = state.profileStatuses[player.id];
    if (status && !status.online) {
      state.modal = noticeDialog("That player is offline.");
      app.render();
      return;
    }
    if (status?.inGame) {
      state.modal = noticeDialog("This user is already in a game!");
      app.render();
      return;
    }
    state.pendingChallenge = player;
    state.modal = "";
    hostLobby();
  }

  function hasProfile() {
    return Boolean(state.profile?.id && state.profile?.hash);
  }

  function requireProfile(nextAction) {
    if (hasProfile()) return false;
    state.pendingProfileAction = nextAction;
    state.modal = usernameDialog(state);
    app.render();
    return true;
  }

  async function saveUsername() {
    const input = root.querySelector("input[name=usernamePrompt]");
    const usernameValue = sanitizeUsername(input?.value || "");
    if (!usernameValue) {
      state.profileError = "Choose a username first.";
      state.modal = usernameDialog(state);
      app.render();
      return;
    }
    state.settings.username = usernameValue;
    saveSettings(state.settings);
    try {
      state.profile = await setRemoteUsername(usernameValue);
      state.relay?.send({ type: "identify", profile: state.profile });
      state.profileError = "";
      const next = state.pendingProfileAction;
      state.pendingProfileAction = "";
      state.modal = "";
      await refreshFriends();
      runProfileAction(next);
    } catch (error) {
      state.profileError = error.message || "Profile service is unavailable.";
      state.modal = usernameDialog(state);
      app.render();
    }
  }

  function runProfileAction(action) {
    if (action === "multiplayer") return openMultiplayerMenu();
    if (action === "host") return hostLobby();
    if (action === "join") return openJoin();
    if (action?.startsWith("friends:")) return openFriends(action.split(":")[1]);
    app.render();
  }

  function refreshFriends() {
    return fetchFriendsAndRecents().then((data) => {
      state.friends = data.friends || [];
      state.recents = data.recents || [];
      state.requests = data.requests || [];
      state.friendsError = "";
      watchVisibleProfiles();
      app.render();
    }).catch(() => {
      state.friendsError = "Friends are unavailable while the profile service is offline.";
    });
  }

  function openFriends(tab) {
    state.friendsTab = tab;
    if (!hasProfile()) {
      requireProfile(`friends:${tab}`);
    } else {
      refreshFriends();
      state.modal = friendsDialog(state);
      watchVisibleProfiles();
      app.render();
    }
  }

  function watchVisibleProfiles() {
    if (!state.relay) return;
    if (!state.profile?.id) return;
    const ids = [...new Set([...state.friends, ...state.recents, ...state.requests, ...state.searchResults].map((player) => player.id).filter(Boolean))];
    if (!ids.length) return;
    state.relay.send({ type: "watchProfiles", profileIds: ids });
  }

  function acceptInvite() {
    if (!state.incomingInvite || !hasProfile()) return;
    const invite = state.incomingInvite;
    state.incomingInvite = null;
    ensureRelay().send({ type: "acceptInvite", lobbyId: invite.lobbyId, player: localLobbyPlayer() });
    app.render();
  }

  function declineInvite() {
    if (state.incomingInvite) state.relay?.send({ type: "declineInvite", lobbyId: state.incomingInvite.lobbyId });
    state.incomingInvite = null;
    state.modal = "";
    app.render();
  }

  async function friendAction(id, kind) {
    const player = [...state.friends, ...state.recents, ...state.requests, ...state.searchResults].find((item) => item.id === id);
    if (!player) return;
    try {
      if (kind === "add") await requestFriend(id);
      if (kind === "remove") await removeFriend(id);
      if (kind === "accept") await answerFriendRequest(id, true);
      if (kind === "reject") await answerFriendRequest(id, false);
      await refreshFriends();
      state.modal = friendsDialog(state);
      watchVisibleProfiles();
      app.render();
    } catch (error) {
      state.friendsError = error.message || "Friend action failed.";
      state.modal = friendsDialog(state);
      app.render();
    }
  }

  function recordRecentPlayers(players) {
    if (!state.profile?.id || state.pendingGame?.mode !== "multiplayer") return;
    players
      .filter((player) => player.profileId && player.profileId !== state.profile.id)
      .forEach((player) => addRecentPlayer(player.profileId).catch(() => undefined));
  }

  app.render();
  return app;
}
