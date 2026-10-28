// 利用が途切れた場合もAPIメタデータを残し続けないよう、日次で期限を確認する。
export async function cleanup(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // 日次実行の間隔を考慮し、30日を超える前に削除する。
  const cutoff = now - 29 * 86400;
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
  ]);
}
