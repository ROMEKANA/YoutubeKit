-- 一人分の状態を項目単位で保存し、削除済みキューも同じ行に残す。
CREATE TABLE cloud_entries (
  sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(sub, key)
);
CREATE TABLE cloud_backups (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
  device TEXT NOT NULL,
  day TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(sub, device, day)
);
CREATE INDEX cloud_backups_owner ON cloud_backups(sub, created_at DESC);
