CREATE TABLE IF NOT EXISTS splob_profiles (
  id TEXT PRIMARY KEY,
  identity_id TEXT UNIQUE,
  username TEXT NOT NULL,
  username_search TEXT NOT NULL,
  friend_hash CHAR(4) NOT NULL,
  gold INTEGER NOT NULL DEFAULT 100 CHECK (gold >= 0),
  customization JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (username_search, friend_hash)
);

CREATE INDEX IF NOT EXISTS splob_profiles_username_search_idx
  ON splob_profiles (username_search);

CREATE TABLE IF NOT EXISTS splob_friendships (
  user_id TEXT NOT NULL REFERENCES splob_profiles(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES splob_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

CREATE TABLE IF NOT EXISTS splob_recent_players (
  user_id TEXT NOT NULL REFERENCES splob_profiles(id) ON DELETE CASCADE,
  other_id TEXT NOT NULL REFERENCES splob_profiles(id) ON DELETE CASCADE,
  last_played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, other_id),
  CHECK (user_id <> other_id)
);
