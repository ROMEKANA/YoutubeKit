import type { VideoData } from "./youtube";

// 動画と進行位置は呼び出し元の同じD1バッチで保存する。リース条件も共有する。
export function videoStatement(
  db: D1Database,
  sub: string,
  video: VideoData,
  fetchedAt: number,
  guard: string,
  guardValues: (string | number)[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO videos(sub, video_id, channel_id, title, thumbnail_url, published_at, duration_seconds, embeddable, availability, last_fetched_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
    ON CONFLICT(sub, video_id) DO UPDATE SET channel_id = excluded.channel_id, title = excluded.title, thumbnail_url = excluded.thumbnail_url,
    published_at = excluded.published_at, duration_seconds = excluded.duration_seconds, embeddable = excluded.embeddable,
    availability = excluded.availability, last_fetched_at = excluded.last_fetched_at`,
    )
    .bind(
      sub,
      video.id,
      video.channelId,
      video.title,
      video.thumbnailUrl,
      video.publishedAt,
      video.durationSeconds,
      Number(video.embeddable),
      video.availability,
      fetchedAt,
      ...guardValues,
    );
}

export const rangeAssignments = `newest_published_at = (SELECT MAX(published_at) FROM videos WHERE videos.sub = channels.sub AND videos.channel_id = channels.channel_id),
  oldest_published_at = (SELECT MIN(published_at) FROM videos WHERE videos.sub = channels.sub AND videos.channel_id = channels.channel_id)`;
