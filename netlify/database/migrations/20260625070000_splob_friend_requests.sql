CREATE TABLE IF NOT EXISTS splob_friend_requests (
  requester_id TEXT NOT NULL REFERENCES splob_profiles(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES splob_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (requester_id, recipient_id),
  CHECK (requester_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS splob_friend_requests_recipient_idx
  ON splob_friend_requests (recipient_id, created_at DESC);
