import { CLIENT_ID_KEY, PROFILE_KEY, WHOLEGRAIN_ACCOUNTS_URL } from "../config.js";

const cookieName = "splob_client_id";

export function getLocalClientId() {
  const cached = readCachedProfile();
  if (cached?.id) {
    setLocalClientId(cached.id);
    return cached.id;
  }
  const stored = localStorage.getItem(CLIENT_ID_KEY);
  if (stored) return stored;
  const next = `local-${crypto.randomUUID()}`;
  setLocalClientId(next);
  return next;
}

export function setLocalClientId(id) {
  localStorage.setItem(CLIENT_ID_KEY, id);
  document.cookie = `${cookieName}=${encodeURIComponent(id)}; Max-Age=63072000; Path=/; SameSite=Lax`;
}

export function readCachedProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
  } catch {
    return null;
  }
}

export function writeCachedProfile(profile) {
  if (!profile) localStorage.removeItem(PROFILE_KEY);
  else {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    setLocalClientId(profile.id);
  }
}

export async function fetchProfile() {
  const restored = await consumeRestoreToken();
  if (restored) return restored;
  const body = await requestProfile("/.netlify/functions/splob-profile?action=profile");
  if (body.profile) writeCachedProfile(body.profile);
  return body.profile || readCachedProfile();
}

export async function setRemoteUsername(username) {
  const body = await requestProfile("/.netlify/functions/splob-profile?action=username", {
    method: "POST",
    body: JSON.stringify({ username, gold: 0, customization: null })
  });
  writeCachedProfile(body.profile);
  return body.profile;
}

export async function fetchFriendsAndRecents() {
  return requestProfile("/.netlify/functions/splob-profile?action=friends");
}

export async function searchPlayers(query) {
  const body = await requestProfile(`/.netlify/functions/splob-profile?action=search&q=${encodeURIComponent(query)}`);
  return body.results || [];
}

export async function requestFriend(friendId) {
  await requestProfile("/.netlify/functions/splob-profile?action=friend-request", {
    method: "POST",
    body: JSON.stringify({ friendId })
  });
}

export async function answerFriendRequest(friendId, accepted) {
  await requestProfile("/.netlify/functions/splob-profile?action=friend-request", {
    method: "PATCH",
    body: JSON.stringify({ friendId, accepted })
  });
}

export async function removeFriend(friendId) {
  await requestProfile("/.netlify/functions/splob-profile?action=friend", {
    method: "DELETE",
    body: JSON.stringify({ friendId })
  });
}

export async function addRecentPlayer(otherId) {
  await requestProfile("/.netlify/functions/splob-profile?action=recent", {
    method: "POST",
    body: JSON.stringify({ otherId })
  });
}

export function wholegrainLinkUrl() {
  const url = new URL(WHOLEGRAIN_ACCOUNTS_URL);
  url.searchParams.set("game", "splob");
  url.searchParams.set("gameAccountId", getLocalClientId());
  url.searchParams.set("returnTo", window.location.href);
  return url.toString();
}

async function consumeRestoreToken() {
  const url = new URL(window.location.href);
  const restoreToken = url.searchParams.get("splobRestoreToken");
  if (!restoreToken) return null;
  url.searchParams.delete("splobRestoreToken");
  window.history.replaceState({}, "", url.toString());
  const body = await requestProfile("/.netlify/functions/splob-profile?action=restore-wholegrain-profile", {
    method: "POST",
    body: JSON.stringify({ restoreToken })
  });
  writeCachedProfile(body.profile);
  return body.profile;
}

async function requestProfile(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("x-splob-client-id", getLocalClientId());
  const profile = readCachedProfile();
  if (profile?.id) headers.set("x-splob-profile-id", profile.id);
  const response = await fetch(url, { ...init, headers, cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || "Profile service is unavailable.");
  }
  return response.json();
}
