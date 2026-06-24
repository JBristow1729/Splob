import { COLOR_ORDER } from "../config.js";
import { Sound } from "../audio/sound.js";
import { SplobGame } from "../game/splob-game.js";
import { RelayClient } from "../network/relay-client.js";
import { loadSettings, sanitizeUsername, saveSettings } from "../state/settings.js";
import {
  answerFriendRequest,
  fetchFriendsAndRecents,
  fetchProfile,
  readCachedProfile,
  removeFriend,
  requestFriend,
  searchPlayers,
  setRemoteUsername,
  wholegrainLinkUrl
} from "../services/profile.js";
import { friendsDialog, optionsDialog, renderGame, renderJoin, renderLobby, renderMultiplayer, renderTitle } from "./templates.js";

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
    friendsTab: "friends",
    friends: [],
    recents: [],
    requests: [],
    searchResults: [],
    searchQuery: "",
    friendsError: ""
  };

  Sound.configure(state.settings.sfx / 100);
  fetchProfile().then((profile) => {
    if (profile) {
      state.profile = profile;
      app.render();
      refreshFriends();
    }
  }).catch(() => undefined);

  const app = {
    render() {
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
    root.querySelectorAll("input[name=username]").forEach((input) => {
      input.addEventListener("change", async () => {
        state.settings.username = sanitizeUsername(input.value);
        saveSettings(state.settings);
        if (state.settings.username.trim()) {
          try {
            state.profile = await setRemoteUsername(state.settings.username.trim());
            refreshFriends();
          } catch {
            state.profile ||= { username: state.settings.username.trim(), hash: "local" };
          }
        }
        app.render();
      });
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
      searchPlayers(state.searchQuery).then((results) => {
        state.searchResults = results;
        app.render();
      }).catch(() => {
        state.searchResults = [];
        app.render();
      });
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
    const actions = {
      singleplayer: () => startGame({ mode: "singleplayer", players: localPlayers() }),
      multiplayer: () => go("multiplayer"),
      host: () => hostLobby(),
      join: () => openJoin(),
      refreshLobbies: () => state.relay?.send({ type: "lobbies:list" }),
      joinPrivate: () => joinPrivate(),
      ready: () => toggleReady(),
      startMultiplayer: () => startMultiplayer(),
      back,
      leaveGame: () => go("title"),
      options: () => {
        state.modal = optionsDialog(state.settings, state.profile);
        app.render();
      },
      friends: () => openFriends("friends"),
      closeModal: () => {
        state.modal = "";
        app.render();
      },
      linkAccount: () => window.open(wholegrainLinkUrl(), "_blank", "noopener")
    };
    actions[action]?.();
  }

  function startCanvasGame() {
    const canvas = root.querySelector("#gameCanvas");
    const overlay = root.querySelector("#gameOverlay");
    const hud = { timer: root.querySelector("#timerPill"), power: root.querySelector("#powerBox"), results: root.querySelector("#scorePanel") };
    state.game = new SplobGame(canvas, overlay, hud, state.pendingGame, {
      onAgain: () => startGame(state.pendingGame),
      onMenu: () => go("title")
    });
    state.game.start();
  }

  function startGame(config) {
    state.pendingGame = { ...config, preferredColor: state.settings.preferredColor };
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

  function ensureRelay() {
    if (state.relay) return state.relay;
    state.relay = new RelayClient();
    state.relay.onLobbies = (lobbies) => {
      state.lobbies = lobbies;
      app.render();
    };
    state.relay.onLobby = (lobby) => {
      state.lobby = lobby;
      if (state.screen !== "lobby") go("lobby");
      else app.render();
    };
    state.relay.onGameStart = (config) => startGame(config);
    state.relay.onJoinError = () => {
      state.modal = `<section class="dialog paint-dialog"><h2>No lobby found</h2><p>That game does not exist or is full.</p><div class="dialog-actions"><button class="button button-small" data-action="closeModal"><span>OK</span></button></div></section>`;
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
    state.lobby = {
      code: String(Math.floor(1000 + Math.random() * 9000)),
      public: false,
      players: [{ id: "local", name: username(), color: state.settings.preferredColor, ready: false, local: true }]
    };
    relay.send({ type: "lobby:create", public: false, player: state.lobby.players[0] });
    go("lobby");
  }

  function openJoin() {
    ensureRelay().send({ type: "lobbies:list" });
    go("join");
  }

  function joinPrivate() {
    const code = [...root.querySelectorAll("[data-code-index]")].map((input) => input.value).join("");
    if (code.length === 4) joinLobby(code);
  }

  function joinLobby(code) {
    ensureRelay().send({ type: "lobby:join", code, player: { name: username(), color: state.settings.preferredColor } });
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
    const players = state.lobby.players.map((player) => ({ ...player }));
    state.relay?.send({ type: "game:start", config: { mode: "multiplayer", players } });
    startGame({ mode: "multiplayer", players });
  }

  function refreshFriends() {
    return fetchFriendsAndRecents().then((data) => {
      state.friends = data.friends || [];
      state.recents = data.recents || [];
      state.requests = data.requests || [];
      state.friendsError = "";
      app.render();
    }).catch(() => {
      state.friendsError = "Friends are unavailable while the profile service is offline.";
    });
  }

  function openFriends(tab) {
    state.friendsTab = tab;
    if (!state.profile) {
      state.modal = optionsDialog(state.settings, state.profile);
    } else {
      refreshFriends();
      state.modal = friendsDialog(state);
    }
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
      app.render();
    } catch (error) {
      state.friendsError = error.message || "Friend action failed.";
      state.modal = friendsDialog(state);
      app.render();
    }
  }

  app.render();
  return app;
}
