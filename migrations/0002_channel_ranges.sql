-- 投稿時刻とAPI情報の取得時刻を分離し、チャンネルごとに新着と過去分の続きを記録する。
ALTER TABLE channels ADD COLUMN video_watermark INTEGER;
ALTER TABLE channels ADD COLUMN newest_published_at TEXT;
ALTER TABLE channels ADD COLUMN oldest_published_at TEXT;
ALTER TABLE channels ADD COLUMN history_page_token TEXT NOT NULL DEFAULT '';
ALTER TABLE channels ADD COLUMN history_complete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN history_started_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN history_lease_token TEXT;
ALTER TABLE channels ADD COLUMN history_lease_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN warning_revision TEXT NOT NULL DEFAULT '';
CREATE INDEX videos_channel_feed ON videos(sub, channel_id, published_at DESC, video_id);
UPDATE channels SET
  newest_published_at = (SELECT MAX(published_at) FROM videos WHERE videos.sub = channels.sub AND videos.channel_id = channels.channel_id),
  oldest_published_at = (SELECT MIN(published_at) FROM videos WHERE videos.sub = channels.sub AND videos.channel_id = channels.channel_id);
