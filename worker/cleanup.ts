import { interactionRetention, refreshStoredComments } from "./interactions";

// 利用が途切れた場合もAPIメタデータを残し続けないよう、日次で期限を確認する。
export async function cleanup(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // 日次実行の間隔を考慮し、30日を超える前に削除する。
  const cutoff = now - interactionRetention;
  try {
    await refreshStoredComments(env);
  } catch {
    // YouTubeに接続できない日も、保存期限の処理は続ける。
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM videos WHERE last_fetched_at < ? AND sub NOT IN (SELECT sub FROM sync_jobs WHERE expires_at > ? AND json_extract(state_json, '$.phase') <> 'done')",
    ).bind(cutoff, now),
    env.DB.prepare(
      "DELETE FROM channels WHERE last_synced_at < ? AND sub NOT IN (SELECT sub FROM sync_jobs WHERE expires_at > ? AND json_extract(state_json, '$.phase') <> 'done')",
    ).bind(cutoff, now),
    env.DB.prepare("DELETE FROM oauth_attempts WHERE expires_at <= ?").bind(
      now,
    ),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM sync_jobs WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM video_ratings WHERE updated_at <= ?")
      .bind(cutoff),
    env.DB.prepare("UPDATE video_ratings SET rating = NULL, checked_at = NULL WHERE checked_at <= ?")
      .bind(cutoff),
    env.DB.prepare(`UPDATE video_comments SET state = 'unknown', author_channel_id = NULL, video_id = NULL,
      comment_id = NULL, checked_at = NULL, operation_id = lower(hex(randomblob(16))), updated_at = ?
      WHERE checked_at <= ? AND (state = 'posted' OR updated_at <= ?)`)
      .bind(now, cutoff, now - 300),
    env.DB.prepare("DELETE FROM video_comments WHERE state = 'empty' AND updated_at <= ?").bind(cutoff),
    env.DB.prepare("DELETE FROM comment_operations WHERE created_at <= ?").bind(now - 2 * 86400),
    env.DB.prepare(`UPDATE accounts SET youtube_channel_id = NULL, youtube_channel_title = NULL,
      youtube_checked_at = NULL WHERE youtube_checked_at <= ?`).bind(cutoff),
  ]);
}
