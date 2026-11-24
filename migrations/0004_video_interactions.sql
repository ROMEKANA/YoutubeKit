-- 旧データの概要欄は未取得として扱い、従来の接続は読み取り権限から開始する。
ALTER TABLE videos ADD COLUMN description TEXT;
ALTER TABLE accounts ADD COLUMN interaction_policy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN youtube_write INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN youtube_channel_id TEXT;
ALTER TABLE accounts ADD COLUMN youtube_channel_title TEXT;
ALTER TABLE accounts ADD COLUMN youtube_checked_at INTEGER;
ALTER TABLE accounts ADD COLUMN grant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE oauth_attempts ADD COLUMN upgrade_session TEXT;
ALTER TABLE oauth_attempts ADD COLUMN upgrade_grant TEXT;

CREATE TABLE video_ratings (
  sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
  youtube_channel_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  rating TEXT CHECK(rating IN ('like', 'dislike', 'none')),
  checked_at INTEGER,
  updated_at INTEGER NOT NULL,
  revision TEXT NOT NULL,
  operation_id TEXT,
  PRIMARY KEY(sub, youtube_channel_id, video_id)
);
CREATE INDEX video_ratings_expiry ON video_ratings(updated_at);

-- 動画キャッシュの期限切れから独立させる。照合用キーは本文やコメントIDを含まない。
CREATE TABLE video_comments (
  sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
  target_key TEXT NOT NULL,
  author_channel_id TEXT,
  video_id TEXT,
  comment_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('empty', 'posted', 'creating', 'editing', 'deleting', 'unknown')),
  operation_id TEXT NOT NULL,
  checked_at INTEGER,
  last_recheck_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(sub, target_key),
  UNIQUE(sub, author_channel_id, video_id)
);
CREATE INDEX video_comments_expiry ON video_comments(checked_at);

CREATE TABLE comment_operations (
  sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(sub, operation_id)
);
CREATE INDEX comment_operations_expiry ON comment_operations(created_at);
