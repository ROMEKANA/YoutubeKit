-- アカウント・認証試行・セッション。トークンは暗号化し、Cookieの実値は保存しない。
CREATE TABLE owner_binding (id INTEGER PRIMARY KEY CHECK(id = 1), sub TEXT NOT NULL);
CREATE TABLE accounts (
  sub TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  refresh_token_cipher TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  last_synced_at INTEGER,
  video_watermark INTEGER
);
CREATE TABLE oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  verifier_cipher TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

-- 登録解除はsubscribedで保持し、取得失敗でキャッシュを空にしない。
CREATE TABLE channels (
  sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL DEFAULT '',
  uploads_playlist_id TEXT NOT NULL DEFAULT '',
  subscribed INTEGER NOT NULL DEFAULT 1,
  last_synced_at INTEGER NOT NULL,
  sync_generation TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(sub, channel_id)
);
CREATE TABLE videos (
  sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  embeddable INTEGER NOT NULL,
  availability TEXT NOT NULL,
  last_fetched_at INTEGER NOT NULL,
  PRIMARY KEY(sub, video_id)
);
CREATE INDEX videos_feed ON videos(sub, published_at DESC, video_id);
CREATE INDEX videos_expiry ON videos(last_fetched_at);

-- 1アカウントにつき1つの同期を進める。リースと世代IDで重複処理を防ぐ。
CREATE TABLE sync_jobs (
  sub TEXT PRIMARY KEY REFERENCES accounts(sub) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE,
  state_json TEXT NOT NULL,
  access_token_cipher TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
