import { accessToken, now, requireSession, type WorkerContext } from "./auth";
import { AppError, requireCondition } from "./errors";
import { requestBody } from "./sync";
import { randomToken } from "./security";
import { rangeAssignments, videoStatement } from "./videoStore";
import { YouTubeClient } from "./youtube";

// 個別チャンネルを開いたときだけ、保存済みの続きから最大1ページを取得する。
export async function loadHistory(c: WorkerContext): Promise<Response> {
  const session = await requireSession(c, true);
  const body = await requestBody(c);
  requireCondition(
    typeof body.channelId === "string" && /^UC[\w-]{22}$/.test(body.channelId),
    "INVALID_CHANNEL",
    "チャンネルの指定が正しくありません。",
  );
  const channelId = body.channelId;
  const lease = randomToken();
  const channel = await c.env.DB.prepare(
    `UPDATE channels SET history_lease_token = ?, history_lease_until = ?
    WHERE sub = ? AND channel_id = ? AND subscribed = 1 AND history_lease_until <= ?
    AND NOT EXISTS (SELECT 1 FROM sync_jobs WHERE sub = ? AND lease_until > ?)
    RETURNING title, uploads_playlist_id, history_page_token, history_complete, history_started_at`,
  )
    .bind(lease, now() + 90, session.sub, channelId, now(), session.sub, now())
    .first<{
      title: string;
      uploads_playlist_id: string;
      history_page_token: string;
      history_complete: number;
      history_started_at: number;
    }>();
  requireCondition(
    channel,
    "HISTORY_BUSY",
    "別の更新処理中か、チャンネル情報が未取得です。少し待って再試行してください。",
    409,
  );
  const guard =
    "EXISTS (SELECT 1 FROM channels WHERE sub = ? AND channel_id = ? AND history_lease_token = ? AND history_lease_until > ?)";
  const guardValues = () => [session.sub, channelId, lease, now()];
  try {
    const reset =
      !channel.history_started_at ||
      channel.history_started_at < now() - 27 * 86400;
    if (!reset && channel.history_complete) return c.json({ done: true });
    const api = new YouTubeClient(await accessToken(c.env, session));
    let playlist = channel.uploads_playlist_id;
    if (!playlist) {
      const details = (await api.channels([channelId]))[0];
      requireCondition(
        details?.uploadsPlaylistId,
        "YOUTUBE_ITEM_FAILED",
        "このチャンネルの投稿一覧を取得できません。",
        502,
      );
      playlist = details.uploadsPlaylistId;
    }
    const page = await api.uploads(
      playlist,
      reset ? "" : channel.history_page_token,
    );
    const videos = (await api.videos(page.items.map((item) => item.id))).filter(
      (video) => video.channelId === channelId,
    );
    const writes = videos.map((video) =>
      videoStatement(c.env.DB, session.sub, video, now(), guard, guardValues()),
    );
    writes.push(
      c.env.DB.prepare(
        `UPDATE channels SET uploads_playlist_id = ?, history_page_token = ?, history_complete = ?, history_started_at = ?, ${rangeAssignments}
      WHERE sub = ? AND channel_id = ? AND history_lease_token = ? AND history_lease_until > ?`,
      ).bind(
        playlist,
        page.nextPageToken,
        Number(!page.nextPageToken),
        reset ? now() : channel.history_started_at,
        session.sub,
        body.channelId,
        lease,
        now(),
      ),
    );
    const results = await c.env.DB.batch(writes);
    requireCondition(
      results[results.length - 1].meta.changes === 1,
      "HISTORY_BUSY",
      "別の更新処理が進みました。再試行してください。",
      409,
    );
    return c.json({ done: !page.nextPageToken });
  } catch (error) {
    if (error instanceof AppError && error.code === "YOUTUBE_PAGE_EXPIRED") {
      await c.env.DB.prepare(
        "UPDATE channels SET history_started_at = 0, history_complete = 0, history_page_token = '' WHERE sub = ? AND channel_id = ? AND history_lease_token = ?",
      )
        .bind(session.sub, body.channelId, lease)
        .run();
      return c.json({ done: false, reset: true });
    }
    throw error;
  } finally {
    await c.env.DB.prepare(
      "UPDATE channels SET history_lease_token = NULL, history_lease_until = 0 WHERE sub = ? AND channel_id = ? AND history_lease_token = ?",
    )
      .bind(session.sub, body.channelId, lease)
      .run();
  }
}
