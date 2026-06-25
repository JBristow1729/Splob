import type { Handler, HandlerEvent } from "@netlify/functions";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";

type DiceCustomizationInventory = {
  equipped: unknown;
  owned: unknown;
};

type LinkChoice = "useLinked" | "useLocal";

type Profile = {
  id: string;
  identityId: string | null;
  username: string;
  hash: string;
  gold: number;
  customization: DiceCustomizationInventory | null;
};

let pool: Pool | null = null;

const usernameMaxLength = 16;
const restoreTokenMaxAgeSeconds = 60 * 5;
const linkConflictTokenMaxAgeSeconds = 60 * 5;

const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json({});
  try {
    const clientId = event.headers["x-splob-client-id"] ?? event.headers["X-Splob-Client-Id"];
    const profileId = event.headers["x-splob-profile-id"] ?? event.headers["X-Splob-Profile-Id"];
    const actorIds = actorCandidates(profileId, clientId);
    const actorId = actorIds[0];
    const action = event.queryStringParameters?.action ?? "profile";

    if (event.httpMethod === "POST" && action === "link-wholegrain-account") {
      requireWholegrainLinkSecret(event);
      const body = parseBody<{ identityId?: string; gameAccountId?: string; linkChoice?: LinkChoice; conflictToken?: string }>(event);
      if (!body.identityId || !body.gameAccountId) return json({ error: "Wholegrain identity id and Splob account id are required." }, 400);
      const profile = await linkWholegrainAccount(body.identityId, body.gameAccountId, body.linkChoice, body.conflictToken);
      return json({ profile, restoreToken: createRestoreToken(profile.id) });
    }

    if (event.httpMethod === "POST" && action === "restore-wholegrain-profile") {
      const body = parseBody<{ restoreToken?: string }>(event);
      if (!body.restoreToken) return json({ error: "Restore token is required." }, 400);
      const profileId = verifyRestoreToken(body.restoreToken);
      const profile = await getProfileByActor([profileId], null);
      if (!profile?.identityId) return json({ error: "That restore token does not match a linked profile." }, 401);
      return json({ profile });
    }

    if (!actorId) return json({ error: "A local client id is required." }, 401);

    if (event.httpMethod === "GET" && action === "profile") {
      const profile = await getProfileByActor(actorIds, null);
      return json({ profile });
    }

    if (event.httpMethod === "POST" && action === "username") {
      const body = parseBody<{ username?: string; gold?: number; customization?: DiceCustomizationInventory }>(event);
      const username = cleanUsername(body.username ?? "");
      if (!username) return json({ error: "Username is required." }, 400);
      const profile = await assignUsername(actorId, null, username, body.gold, body.customization ?? null);
      return json({ profile });
    }

    if (event.httpMethod === "PATCH" && action === "profile") {
      const body = parseBody<{ gold?: number; customization?: DiceCustomizationInventory }>(event);
      const profile = await updateProfile(actorIds, null, body.gold, body.customization);
      return json({ profile });
    }

    if (event.httpMethod === "GET" && action === "friends") {
      const profile = await requireProfile(actorIds, null);
      const friends = await listFriends(profile.id);
      const recents = await listRecents(profile.id);
      const requests = await listFriendRequests(profile);
      return json({ friends, recents, requests });
    }

    if (event.httpMethod === "GET" && action === "search") {
      const profile = await requireProfile(actorIds, null);
      const query = event.queryStringParameters?.q ?? "";
      const results = await searchProfiles(profile.id, query);
      return json({ results });
    }

    if (event.httpMethod === "POST" && action === "friend") {
      const profile = await requireProfile(actorIds, null);
      const body = parseBody<{ friendId?: string }>(event);
      if (!body.friendId) return json({ error: "Friend id is required." }, 400);
      await addFriend(profile.id, body.friendId);
      return json({ ok: true });
    }

    if (event.httpMethod === "POST" && action === "friend-request") {
      const profile = await requireProfile(actorIds, null);
      const body = parseBody<{ friendId?: string }>(event);
      if (!body.friendId) return json({ error: "Friend id is required." }, 400);
      await requestFriend(profile.id, body.friendId);
      return json({ ok: true });
    }

    if (event.httpMethod === "PATCH" && action === "friend-request") {
      const profile = await requireProfile(actorIds, null);
      const body = parseBody<{ friendId?: string; accepted?: boolean }>(event);
      if (!body.friendId) return json({ error: "Friend id is required." }, 400);
      await answerFriendRequest(profile, body.friendId, Boolean(body.accepted));
      return json({ ok: true });
    }

    if (event.httpMethod === "DELETE" && action === "friend") {
      const profile = await requireProfile(actorIds, null);
      const body = parseBody<{ friendId?: string }>(event);
      if (!body.friendId) return json({ error: "Friend id is required." }, 400);
      await removeFriend(profile.id, body.friendId);
      return json({ ok: true });
    }

    if (event.httpMethod === "POST" && action === "recent") {
      const profile = await requireProfile(actorIds, null);
      const body = parseBody<{ otherId?: string }>(event);
      if (!body.otherId) return json({ error: "Recent player id is required." }, 400);
      await addRecent(profile.id, body.otherId);
      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  } catch (error) {
    const handled = error as Error & { statusCode?: number; responseBody?: unknown };
    if (handled.statusCode && handled.responseBody) return json(handled.responseBody, handled.statusCode);
    const message = error instanceof Error ? error.message : "Unexpected profile service error.";
    return json({ error: message }, 500);
  }
};

export { handler };

function getPool() {
  if (!pool) {
    const connectionString = process.env.NETLIFY_DB_URL ?? process.env.DATABASE_URL;
    if (!connectionString) throw new Error("NETLIFY_DB_URL is not configured.");
    pool = new Pool({ connectionString });
  }
  return pool;
}

async function getProfileByActor(actorIds: string[], identityId: string | null): Promise<Profile | null> {
  const db = getPool();
  const ids = padActorIds(actorIds);
  const { rows } = await db.query(
    "SELECT * FROM splob_profiles WHERE id = $1 OR id = $2 OR id = $3 OR identity_id = $4 LIMIT 1",
    [ids[0], ids[1], ids[2], identityId]
  );
  return rows[0] ? toProfile(rows[0]) : null;
}

async function requireProfile(actorIds: string[], identityId: string | null): Promise<Profile> {
  const profile = await getProfileByActor(actorIds, identityId);
  if (!profile) throw new Error("Set a username first.");
  return profile;
}

async function assignUsername(actorId: string, identityId: string | null, username: string, gold?: number, customization?: DiceCustomizationInventory | null): Promise<Profile> {
  const db = getPool();
  const search = normalizeUsername(username);
  const hash = await firstAvailableHash(search, actorId);
  if (!hash) throw new Error("That username is fully taken. Please choose another.");
  const existing = await getProfileByActor([actorId], identityId);
  const profileId = existing?.id ?? actorId;
  const { rows } = await db.query(
    `INSERT INTO splob_profiles (id, identity_id, username, username_search, friend_hash, gold, customization)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE
       SET identity_id = COALESCE(EXCLUDED.identity_id, splob_profiles.identity_id),
           username = EXCLUDED.username,
           username_search = EXCLUDED.username_search,
           friend_hash = EXCLUDED.friend_hash,
           gold = GREATEST(splob_profiles.gold, EXCLUDED.gold),
           customization = COALESCE(EXCLUDED.customization, splob_profiles.customization),
           updated_at = NOW()
     RETURNING *`,
    [profileId, identityId, username, search, hash, clampGold(gold), customization ? JSON.stringify(customization) : null]
  );
  return toProfile(rows[0]);
}

async function firstAvailableHash(usernameSearch: string, actorId: string) {
  const db = getPool();
  const { rows } = await db.query("SELECT friend_hash FROM splob_profiles WHERE username_search = $1 AND id <> $2", [usernameSearch, actorId]);
  const used = new Set(rows.map((row) => row.friend_hash as string));
  const start = Math.floor(Math.random() * 10000);
  for (let offset = 0; offset < 10000; offset += 1) {
    const candidate = String((start + offset) % 10000).padStart(4, "0");
    if (!used.has(candidate)) return candidate;
  }
  return "";
}

async function updateProfile(actorIds: string[], identityId: string | null, gold?: number, customization?: DiceCustomizationInventory): Promise<Profile> {
  const profile = await requireProfile(actorIds, identityId);
  const db = getPool();
  const { rows } = await db.query(
    `UPDATE splob_profiles
     SET gold = COALESCE($2, gold),
         customization = COALESCE($3, customization),
         identity_id = COALESCE($4, identity_id),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [profile.id, typeof gold === "number" ? clampGold(gold) : null, customization ? JSON.stringify(customization) : null, identityId]
  );
  return toProfile(rows[0]);
}

async function linkWholegrainAccount(identityId: string, gameAccountId: string, linkChoice?: LinkChoice, conflictToken?: string): Promise<Profile> {
  if (linkChoice && !isLinkChoice(linkChoice)) throw new Error("Invalid Wholegrain account link choice.");

  const db = getPool();
  const existingAccount = await getProfileByActor([], identityId);
  if (existingAccount) {
    if (existingAccount.id === gameAccountId) return existingAccount;

    const localProfile = await getProfileByActor([gameAccountId], null);
    if (!localProfile) return existingAccount;
    if (localProfile.identityId && localProfile.identityId !== identityId) throw new Error("That Splob profile is already linked to another Wholegrain account.");

    if (!linkChoice) throw createLinkChoiceRequired(existingAccount, localProfile);
    verifyLinkConflictToken(conflictToken ?? "", identityId, existingAccount.id, localProfile.id);

    if (linkChoice === "useLinked") {
      await deleteProfile(localProfile.id);
      return existingAccount;
    }

    await replaceLinkedProfile(identityId, existingAccount.id, localProfile.id);
    const linkedLocal = await getProfileByActor([localProfile.id], identityId);
    if (!linkedLocal) throw new Error("Unable to link the selected Splob profile.");
    return linkedLocal;
  }

  const { rows } = await db.query(
    "UPDATE splob_profiles SET identity_id = $1, updated_at = NOW() WHERE id = $2 AND (identity_id IS NULL OR identity_id = $1) RETURNING *",
    [identityId, gameAccountId]
  );
  if (rows[0]) return toProfile(rows[0]);
  throw new Error("No unlinked Splob profile exists for that account id.");
}

async function replaceLinkedProfile(identityId: string, existingProfileId: string, localProfileId: string) {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE splob_profiles SET identity_id = NULL, updated_at = NOW() WHERE id = $1 AND identity_id = $2", [existingProfileId, identityId]);
    await client.query("UPDATE splob_profiles SET identity_id = $1, updated_at = NOW() WHERE id = $2 AND identity_id IS NULL", [identityId, localProfileId]);
    await client.query("DELETE FROM splob_profiles WHERE id = $1 AND identity_id IS NULL", [existingProfileId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteProfile(profileId: string) {
  const db = getPool();
  await db.query("DELETE FROM splob_profiles WHERE id = $1", [profileId]);
}

async function listFriends(profileId: string) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT p.id, p.username, p.friend_hash AS hash
     FROM splob_friendships f
     JOIN splob_profiles p ON p.id = f.friend_id
     WHERE f.user_id = $1
     ORDER BY LOWER(p.username)`,
    [profileId]
  );
  return rows;
}

async function listRecents(profileId: string) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT p.id, p.username, p.friend_hash AS hash
     FROM splob_recent_players r
     JOIN splob_profiles p ON p.id = r.other_id
     WHERE r.user_id = $1
     ORDER BY r.last_played_at DESC
     LIMIT 25`,
    [profileId]
  );
  return rows;
}

async function listFriendRequests(profile: Profile) {
  const db = getPool();
  const ids = profileIds(profile);
  const { rows } = await db.query(
    `SELECT p.id, p.username, p.friend_hash AS hash
     FROM splob_friend_requests r
     JOIN splob_profiles p ON p.id = r.requester_id
     WHERE r.recipient_id = $1 OR r.recipient_id = $2
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [ids[0], ids[1]]
  );
  return rows;
}

async function searchProfiles(profileId: string, query: string) {
  const db = getPool();
  const parsed = parseSearch(query);
  if (!parsed.name) return [];
  const { rows } = await db.query(
    `SELECT p.id, p.username, p.friend_hash AS hash, f.friend_id IS NOT NULL AS friend,
            CASE
              WHEN p.username_search = $2 THEN 0
              WHEN p.username_search LIKE $2 || '%' THEN 1
              ELSE 2
            END AS rank
     FROM splob_profiles p
     LEFT JOIN splob_friendships f ON f.user_id = $1 AND f.friend_id = p.id
     WHERE p.id <> $1
       AND p.username_search LIKE '%' || $2 || '%'
       AND ($3 = '' OR p.friend_hash LIKE $3 || '%')
     ORDER BY friend DESC, rank ASC, p.username_search ASC
     LIMIT 20`,
    [profileId, normalizeUsername(parsed.name), parsed.hash]
  );
  return rows;
}

async function addFriend(profileId: string, friendId: string) {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO splob_friendships (user_id, friend_id)
       VALUES ($1, $2), ($2, $1)
       ON CONFLICT DO NOTHING`,
      [profileId, friendId]
    );
    await client.query("DELETE FROM splob_friend_requests WHERE (requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1)", [profileId, friendId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function removeFriend(profileId: string, friendId: string) {
  const db = getPool();
  await db.query("DELETE FROM splob_friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)", [profileId, friendId]);
}

async function requestFriend(profileId: string, friendId: string) {
  const db = getPool();
  const { rows } = await db.query("SELECT 1 FROM splob_friendships WHERE user_id = $1 AND friend_id = $2", [profileId, friendId]);
  if (rows[0]) return;
  const reverse = await db.query("SELECT 1 FROM splob_friend_requests WHERE requester_id = $1 AND recipient_id = $2", [friendId, profileId]);
  if (reverse.rows[0]) {
    await addFriend(profileId, friendId);
    return;
  }
  await db.query(
    "INSERT INTO splob_friend_requests (requester_id, recipient_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [profileId, friendId]
  );
}

async function answerFriendRequest(profile: Profile, friendId: string, accepted: boolean) {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (accepted) {
      await client.query(
        `INSERT INTO splob_friendships (user_id, friend_id)
         VALUES ($1, $2), ($2, $1)
         ON CONFLICT DO NOTHING`,
        [profile.id, friendId]
      );
    }
    const ids = profileIds(profile);
    await client.query("DELETE FROM splob_friend_requests WHERE requester_id = $1 AND (recipient_id = $2 OR recipient_id = $3)", [friendId, ids[0], ids[1]]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function profileIds(profile: Profile) {
  const ids = [...new Set([profile.id, profile.identityId].filter(Boolean))] as string[];
  return ids.length === 1 ? [ids[0], ids[0]] : ids;
}

function actorCandidates(...ids: Array<string | string[] | null | undefined>) {
  return [...new Set(ids.flat().filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function padActorIds(ids: string[]) {
  if (ids.length === 0) return ["", "", ""];
  return [ids[0], ids[1] ?? ids[0], ids[2] ?? ids[0]];
}

async function addRecent(profileId: string, otherId: string) {
  const db = getPool();
  await db.query(
    `INSERT INTO splob_recent_players (user_id, other_id, last_played_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, other_id) DO UPDATE SET last_played_at = NOW()`,
    [profileId, otherId]
  );
}

function cleanUsername(username: string) {
  const value = username.trim().replace(/\s+/g, " ");
  if (value.length > usernameMaxLength) throw new Error(`Username must be ${usernameMaxLength} characters or fewer.`);
  if (!/^[A-Za-z ]+$/.test(value)) throw new Error("Use letters and spaces only.");
  return value;
}

function normalizeUsername(username: string) {
  return username.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseSearch(query: string) {
  const [namePart, hashPart = ""] = query.split("#");
  return {
    name: namePart.trim(),
    hash: hashPart.replace(/\D/g, "").slice(0, 4)
  };
}

function clampGold(gold: unknown) {
  return typeof gold === "number" && Number.isFinite(gold) ? Math.max(0, Math.floor(gold)) : 100;
}

function parseBody<T>(event: HandlerEvent): T {
  if (!event.body) return {} as T;
  return JSON.parse(event.body) as T;
}

function requireWholegrainLinkSecret(event: HandlerEvent) {
  const expected = process.env.WHOLEGRAIN_LINK_SECRET;
  if (!expected) throw new Error("WHOLEGRAIN_LINK_SECRET is not configured.");
  const provided = event.headers["x-wholegrain-link-secret"] ?? event.headers["X-Wholegrain-Link-Secret"];
  if (provided !== expected) throw new Error("Not authorized to link this Splob profile.");
}

function createLinkChoiceRequired(existingProfile: Profile, localProfile: Profile) {
  const error = new Error("Choose which Splob profile to keep.") as Error & { statusCode?: number; responseBody?: unknown };
  error.statusCode = 409;
  error.responseBody = {
    code: "LINK_CHOICE_REQUIRED",
    requiresChoice: true,
    existingUsername: existingProfile.username,
    localUsername: localProfile.username,
    conflictToken: createLinkConflictToken(existingProfile.identityId ?? "", existingProfile.id, localProfile.id)
  };
  return error;
}

function isLinkChoice(value: unknown): value is LinkChoice {
  return value === "useLinked" || value === "useLocal";
}

function createLinkConflictToken(identityId: string, existingProfileId: string, localProfileId: string) {
  const exp = Math.floor(Date.now() / 1000) + linkConflictTokenMaxAgeSeconds;
  const payload = encodeBase64Url(JSON.stringify({ identityId, existingProfileId, localProfileId, exp }));
  const signature = signRestorePayload(payload);
  return `${payload}.${signature}`;
}

function verifyLinkConflictToken(token: string, identityId: string, existingProfileId: string, localProfileId: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("Invalid account link choice token.");
  const expected = signRestorePayload(payload);
  if (!safeEqual(signature, expected)) throw new Error("Invalid account link choice token.");
  const parsed = JSON.parse(decodeBase64Url(payload)) as { identityId?: unknown; existingProfileId?: unknown; localProfileId?: unknown; exp?: unknown };
  if (parsed.identityId !== identityId || parsed.existingProfileId !== existingProfileId || parsed.localProfileId !== localProfileId || typeof parsed.exp !== "number") {
    throw new Error("Invalid account link choice token.");
  }
  if (parsed.exp < Math.floor(Date.now() / 1000)) throw new Error("Account link choice token expired.");
}
function createRestoreToken(profileId: string) {
  const exp = Math.floor(Date.now() / 1000) + restoreTokenMaxAgeSeconds;
  const payload = encodeBase64Url(JSON.stringify({ profileId, exp }));
  const signature = signRestorePayload(payload);
  return `${payload}.${signature}`;
}

function verifyRestoreToken(token: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("Invalid restore token.");
  const expected = signRestorePayload(payload);
  if (!safeEqual(signature, expected)) throw new Error("Invalid restore token.");
  const parsed = JSON.parse(decodeBase64Url(payload)) as { profileId?: unknown; exp?: unknown };
  if (typeof parsed.profileId !== "string" || typeof parsed.exp !== "number") throw new Error("Invalid restore token.");
  if (parsed.exp < Math.floor(Date.now() / 1000)) throw new Error("Restore token expired.");
  return parsed.profileId;
}

function signRestorePayload(payload: string) {
  const secret = process.env.WHOLEGRAIN_LINK_SECRET;
  if (!secret) throw new Error("WHOLEGRAIN_LINK_SECRET is not configured.");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function encodeBase64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function toProfile(row: Record<string, unknown>): Profile {
  return {
    id: String(row.id),
    identityId: row.identity_id ? String(row.identity_id) : null,
    username: String(row.username),
    hash: String(row.friend_hash),
    gold: Number(row.gold),
    customization: (row.customization as DiceCustomizationInventory | null) ?? null
  };
}

function json(body: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
