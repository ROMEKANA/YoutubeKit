import { accessToken, now, requireSession, type WorkerContext } from "./auth";
import { boundedInteger } from "./config";
import { AppError, requireCondition } from "./errors";
import { decryptSecret, encryptSecret, randomToken } from "./security";
import { parseSyncIssues, type SyncIssue } from "../shared/sync";
import {
  record,
  selectRecentUploads,
  YouTubeClient,
  type VideoData,
} from "./youtube";

interface JobState {
  phase: "subscriptions" | "channels" | "uploads" | "refresh" | "done";
  startedAt: number;
  cutoff: number;
  pageToken: string;
  channelIds: string[];
  freshIds: string[];
  channelIndex: number;
  uploadPage: number;
  videosUpdated: number;
  issues: SyncIssue[];
}

interface JobRow {
  job_id: string;
  state_json: string;
  access_token_cipher: string | null;
  expires_at: number;
}
const maxAge = 30 * 86400;

function parseState(raw: string): JobState {
  const value = record(JSON.parse(raw));
  requireCondition(
    ["subscriptions", "channels", "uploads", "refresh", "done"].includes(
      String(value.phase),
    ) &&
      [
        "startedAt",
        "cutoff",
        "channelIndex",
        "uploadPage",
        "videosUpdated",
      ].every((key) => typeof value[key] === "number") &&
      typeof value.pageToken === "string" &&
      Array.isArray(value.channelIds) &&
      Array.isArray(value.freshIds),
    "SYNC_STATE",
    "同期状態を読み込めません。同期を開始し直してください。",
    409,
  );
  const phase = value.phase;
  requireCondition(
    phase === "subscriptions" ||
      phase === "channels" ||
      phase === "uploads" ||
      phase === "refresh" ||
      phase === "done",
    "SYNC_STATE",
    "同期状態が正しくありません。",
    409,
  );
  const strings = (input: unknown): input is string[] =>
    Array.isArray(input) && input.every((item) => typeof item === "string");
  requireCondition(
    strings(value.channelIds) && strings(value.freshIds),
    "SYNC_STATE",
    "同期状態が正しくありません。",
    409,
  );
  return {
    phase,
    startedAt: Number(value.startedAt),
    cutoff: Number(value.cutoff),
    pageToken: value.pageToken,
    channelIds: value.channelIds,
    freshIds: value.freshIds,
    channelIndex: Number(value.channelIndex),
    uploadPage: Number(value.uploadPage),
    videosUpdated: Number(value.videosUpdated),
    issues: parseSyncIssues(value.issues),
  };
}

function summary(row: JobRow, state = parseState(row.state_json)) {
  return {
    jobId: row.job_id,
    phase: state.phase,
    channels: state.channelIds.length,
    processedChannels: state.channelIndex,
    videosUpdated: state.videosUpdated,
    done: state.phase === "done",
    issues: state.issues,
  };
}

// 小さいJSONだけを受け取り、変更操作を認証・CSRF検証した後で同期を始める。
async function requestBody(c: WorkerContext): Promise<Record<string, unknown>> {
  requireCondition(
    c.req.header("Content-Type")?.startsWith("application/json"),
    "JSON_REQUIRED",
    "JSON形式で送信してください。",
  );
  const bytes = await c.req.arrayBuffer();
  requireCondition(
    bytes.byteLength <= 1024,
    "REQUEST_TOO_LARGE",
    "リクエストが大きすぎます。",
    413,
  );
  try {
    return record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new AppError("INVALID_JSON", "リクエストの形式が正しくありません。");
  }
}

export async function startSync(c: WorkerContext): Promise<Response> {
  const session = await requireSession(c, true);
  const body = await requestBody(c);
  requireCondition(
    body.full === undefined || typeof body.full === "boolean",
    "INVALID_SYNC_MODE",
    "再取得の指定が正しくありません。",
  );
  const current = await c.env.DB.prepare(
    "SELECT job_id, state_json, access_token_cipher, expires_at FROM sync_jobs WHERE sub = ?",
  )
    .bind(session.sub)
    .first<JobRow>();
  if (
    current &&
    current.expires_at > now() &&
    parseState(current.state_json).phase !== "done"
  )
    return c.json(summary(current));
  const startedAt = now();
  const watermark = await c.env.DB.prepare(
    "SELECT video_watermark FROM accounts WHERE sub = ?",
  )
    .bind(session.sub)
    .first<{ video_watermark: number | null }>();
  const overlap = boundedInteger(c.env.SYNC_OVERLAP_SECONDS, 600, 86400);
  const previous = current ? parseState(current.state_json) : null;
  const state: JobState = {
    phase: "subscriptions",
    startedAt,
    cutoff: body.full
      ? 0
      : Math.max(0, (watermark?.video_watermark ?? 0) - overlap),
    pageToken: "",
    channelIds: [],
    // 一部失敗した再取得は、次の通常更新でも過去分の取得をやり直す。
    freshIds: previous
      ? previous.issues
          .filter(
            (issue) =>
              previous.cutoff === 0 ||
              previous.freshIds.includes(issue.channelId),
          )
          .map((issue) => issue.channelId)
      : [],
    channelIndex: 0,
    uploadPage: 0,
    videosUpdated: 0,
    issues: [],
  };
  const jobId = randomToken();
  const token = await accessToken(c.env, session);
  const cipher = await encryptSecret(
    token,
    c.env.TOKEN_ENCRYPTION_KEY,
    `sync:${session.sub}:${jobId}`,
  );
  // 同時開始した別端末が先にジョブを作った場合は、そのジョブを返す。
  await c.env.DB.prepare(
    `INSERT INTO sync_jobs(sub, job_id, state_json, access_token_cipher, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(sub) DO UPDATE SET job_id = excluded.job_id, state_json = excluded.state_json, access_token_cipher = excluded.access_token_cipher,
    lease_token = NULL, lease_until = 0, updated_at = excluded.updated_at, expires_at = excluded.expires_at
    WHERE sync_jobs.expires_at <= ? OR json_extract(sync_jobs.state_json, '$.phase') = 'done'`,
  )
    .bind(
      session.sub,
      jobId,
      JSON.stringify(state),
      cipher,
      startedAt,
      startedAt + 3600,
      startedAt,
    )
    .run();
  const created = await c.env.DB.prepare(
    "SELECT job_id, state_json, access_token_cipher, expires_at FROM sync_jobs WHERE sub = ?",
  )
    .bind(session.sub)
    .first<JobRow>();
  requireCondition(
    created,
    "SYNC_CREATE_FAILED",
    "同期を開始できませんでした。",
    500,
  );
  return c.json(summary(created));
}

// 1回につき登録1ページ、チャンネル情報50件、または動画一覧1ページだけ進める。
export async function stepSync(c: WorkerContext): Promise<Response> {
  const session = await requireSession(c, true);
  const body = await requestBody(c);
  requireCondition(
    typeof body.jobId === "string" && /^[\w-]{43}$/.test(body.jobId),
    "INVALID_JOB",
    "同期IDが正しくありません。",
  );
  const lease = randomToken();
  const acquired = await c.env.DB.prepare(
    `UPDATE sync_jobs SET lease_token = ?, lease_until = ?
    WHERE sub = ? AND job_id = ? AND expires_at > ? AND lease_until <= ?
    RETURNING job_id, state_json, access_token_cipher, expires_at`,
  )
    .bind(lease, now() + 90, session.sub, body.jobId, now(), now())
    .first<JobRow>();
  if (!acquired) {
    const current = await c.env.DB.prepare(
      "SELECT job_id, lease_until FROM sync_jobs WHERE sub = ? AND expires_at > ?",
    )
      .bind(session.sub, now())
      .first<{ job_id: string; lease_until: number }>();
    throw new AppError(
      current?.job_id === body.jobId && current.lease_until > now()
        ? "SYNC_BUSY"
        : "SYNC_EXPIRED",
      current?.lease_until && current.lease_until > now()
        ? "別の更新処理が実行中です。少し待って再試行してください。"
        : "同期の有効期限が切れました。更新を開始し直してください。",
      409,
    );
  }
  try {
    const state = parseState(acquired.state_json);
    if (state.phase === "done") return c.json(summary(acquired, state));
    requireCondition(
      acquired.access_token_cipher,
      "SYNC_EXPIRED",
      "更新を開始し直してください。",
      409,
    );
    const api = new YouTubeClient(
      await decryptSecret(
        acquired.access_token_cipher,
        c.env.TOKEN_ENCRYPTION_KEY,
        `sync:${session.sub}:${acquired.job_id}`,
      ),
    );
    const writes: D1PreparedStatement[] = [];
    // リースを失った古い処理は、動画データも同期位置も書き換えられない。
    const guard =
      "EXISTS (SELECT 1 FROM sync_jobs WHERE sub = ? AND job_id = ? AND lease_token = ? AND lease_until > ?)";
    const guarded = (sql: string, values: (string | number | null)[]) =>
      c.env.DB.prepare(sql.replace("$guard", guard)).bind(
        ...values,
        session.sub,
        acquired.job_id,
        lease,
        now(),
      );
    const saveVideos = (videos: VideoData[]) => {
      for (const video of videos) {
        writes.push(
          guarded(
            `INSERT INTO videos(sub, video_id, channel_id, title, thumbnail_url, published_at, duration_seconds, embeddable, availability, last_fetched_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE $guard
          ON CONFLICT(sub, video_id) DO UPDATE SET channel_id = excluded.channel_id, title = excluded.title, thumbnail_url = excluded.thumbnail_url,
          published_at = excluded.published_at, duration_seconds = excluded.duration_seconds, embeddable = excluded.embeddable,
          availability = excluded.availability, last_fetched_at = excluded.last_fetched_at`,
            [
              session.sub,
              video.id,
              video.channelId,
              video.title,
              video.thumbnailUrl,
              video.publishedAt,
              video.durationSeconds,
              Number(video.embeddable),
              video.availability,
              now(),
            ],
          ),
        );
      }
      state.videosUpdated += videos.length;
    };

    if (state.phase === "subscriptions") {
      const page = await api.subscriptions(state.pageToken);
      const existing = await c.env.DB.prepare(
        "SELECT channel_id FROM channels WHERE sub = ? AND subscribed = 1",
      )
        .bind(session.sub)
        .all<{ channel_id: string }>();
      const known = new Set(
        existing.results.map((channel) => channel.channel_id),
      );
      for (const channel of page.channels) {
        if (!state.channelIds.includes(channel.id))
          state.channelIds.push(channel.id);
        if (!known.has(channel.id) && !state.freshIds.includes(channel.id))
          state.freshIds.push(channel.id);
        writes.push(
          guarded(
            `INSERT INTO channels(sub, channel_id, title, thumbnail_url, last_synced_at, sync_generation)
          SELECT ?, ?, ?, ?, ?, ? WHERE $guard ON CONFLICT(sub, channel_id) DO UPDATE SET
          title = excluded.title, thumbnail_url = excluded.thumbnail_url, subscribed = 1,
          last_synced_at = excluded.last_synced_at, sync_generation = excluded.sync_generation`,
            [
              session.sub,
              channel.id,
              channel.title,
              channel.thumbnailUrl,
              now(),
              acquired.job_id,
            ],
          ),
        );
      }
      requireCondition(
        state.channelIds.length <= 20000,
        "TOO_MANY_CHANNELS",
        "登録チャンネルが多すぎます。同期範囲の設計を見直す必要があります。",
      );
      state.pageToken = page.nextPageToken;
      if (!page.nextPageToken) {
        writes.push(
          guarded(
            "UPDATE channels SET subscribed = 0 WHERE sub = ? AND sync_generation <> ? AND $guard",
            [session.sub, acquired.job_id],
          ),
        );
        state.phase = "channels";
      }
    } else if (state.phase === "channels") {
      const ids = state.channelIds.slice(
        state.channelIndex,
        state.channelIndex + 50,
      );
      for (const channel of await api.channels(ids))
        writes.push(
          guarded(
            `UPDATE channels SET title = ?, thumbnail_url = ?, uploads_playlist_id = ?, last_synced_at = ?
        WHERE sub = ? AND channel_id = ? AND $guard`,
            [
              channel.title,
              channel.thumbnailUrl,
              channel.uploadsPlaylistId,
              now(),
              session.sub,
              channel.id,
            ],
          ),
        );
      state.channelIndex += ids.length;
      if (state.channelIndex >= state.channelIds.length) {
        state.phase = "uploads";
        state.channelIndex = 0;
      }
    } else if (state.phase === "uploads") {
      const id = state.channelIds[state.channelIndex];
      const channel = id
        ? await c.env.DB.prepare(
            "SELECT title, uploads_playlist_id FROM channels WHERE sub = ? AND channel_id = ?",
          )
            .bind(session.sub, id)
            .first<{ title: string; uploads_playlist_id: string }>()
        : null;
      let finishedChannel = true;
      try {
        if (channel?.uploads_playlist_id) {
          const page = await api.uploads(
            channel.uploads_playlist_id,
            state.pageToken,
          );
          const cutoff = state.freshIds.includes(id) ? 0 : state.cutoff;
          const recent = selectRecentUploads(page.items, cutoff);
          saveVideos(
            (await api.videos(recent.ids)).filter(
              (video) => video.channelId === id,
            ),
          );
          state.uploadPage += 1;
          if (
            page.nextPageToken &&
            !recent.reachedCutoff &&
            (cutoff > 0 ||
              state.uploadPage <
                boundedInteger(c.env.UPLOAD_PAGES_PER_CHANNEL, 2, 20))
          ) {
            state.pageToken = page.nextPageToken;
            finishedChannel = false;
          }
        } else if (id) {
          throw new AppError(
            "YOUTUBE_ITEM_FAILED",
            "チャンネルの投稿一覧を取得できませんでした。",
            502,
          );
        }
      } catch (error) {
        // 認証・利用上限・設定・DB障害は継続せず、対象固有の失敗だけ記録して次へ進む。
        if (
          !(error instanceof AppError) ||
          ![
            "YOUTUBE_ITEM_FAILED",
            "YOUTUBE_UNAVAILABLE",
            "YOUTUBE_RESPONSE",
            "YOUTUBE_PAGING",
          ].includes(error.code)
        )
          throw error;
        state.issues.push({
          channelId: id,
          title: channel?.title || id,
          code: error.code,
          message: error.message,
        });
      }
      if (finishedChannel) {
        state.channelIndex += 1;
        state.pageToken = "";
        state.uploadPage = 0;
      }
      if (state.channelIndex >= state.channelIds.length)
        state.phase = "refresh";
    } else if (state.phase === "refresh") {
      // 差分取得で触れなかった既存動画も、30日を超える前に情報を再確認する。
      const stale = await c.env.DB.prepare(
        "SELECT video_id FROM videos WHERE sub = ? AND last_fetched_at < ? ORDER BY video_id LIMIT 50",
      )
        .bind(session.sub, state.startedAt - 27 * 86400)
        .all<{ video_id: string }>();
      const ids = stale.results.map((video) => video.video_id);
      const refreshed = await api.videos(ids);
      saveVideos(refreshed);
      for (const id of ids.filter(
        (id) => !refreshed.some((video) => video.id === id),
      ))
        writes.push(
          guarded(
            `UPDATE videos SET title = '利用できない動画', thumbnail_url = '', availability = 'unavailable', embeddable = 0, last_fetched_at = ? WHERE sub = ? AND video_id = ? AND $guard`,
            [now(), session.sub, id],
          ),
        );
      if (!ids.length) {
        state.phase = "done";
        // 一部失敗時も正常な動画は利用できるが、未取得範囲を飛ばす基準更新は行わない。
        if (!state.issues.length)
          writes.push(
            guarded(
              "UPDATE accounts SET last_synced_at = ?, video_watermark = ? WHERE sub = ? AND $guard",
              [now(), state.startedAt, session.sub],
            ),
          );
      }
    }

    writes.push(
      c.env.DB.prepare(
        "UPDATE sync_jobs SET state_json = ?, access_token_cipher = ?, updated_at = ?, lease_token = NULL, lease_until = 0 WHERE sub = ? AND job_id = ? AND lease_token = ? AND lease_until > ?",
      ).bind(
        JSON.stringify(state),
        state.phase === "done" ? null : acquired.access_token_cipher,
        now(),
        session.sub,
        acquired.job_id,
        lease,
        now(),
      ),
    );
    const results = await c.env.DB.batch(writes);
    requireCondition(
      results[results.length - 1].meta.changes === 1,
      "SYNC_LEASE_LOST",
      "同期を別の処理が引き継ぎました。更新を再試行してください。",
      409,
    );
    return c.json(summary(acquired, state));
  } finally {
    await c.env.DB.prepare(
      "UPDATE sync_jobs SET lease_token = NULL, lease_until = 0 WHERE sub = ? AND job_id = ? AND lease_token = ?",
    )
      .bind(session.sub, acquired.job_id, lease)
      .run();
  }
}

// Google側の一時障害時でも、認証済みの所有者にはD1の取得済み情報を返す。
export async function getCatalog(c: WorkerContext): Promise<Response> {
  const session = await requireSession(c);
  const cutoff = now() - maxAge;
  await c.env.DB.prepare(
    "DELETE FROM videos WHERE sub = ? AND last_fetched_at < ?",
  )
    .bind(session.sub, cutoff)
    .run();
  const channels = await c.env.DB.prepare(
    "SELECT channel_id AS id, title, thumbnail_url AS thumbnailUrl FROM channels WHERE sub = ? AND subscribed = 1 AND last_synced_at >= ? ORDER BY title",
  )
    .bind(session.sub, cutoff)
    .all();
  const limit = boundedInteger(c.env.CATALOG_LIMIT, 1000, 5000);
  const videos = await c.env.DB.prepare(
    `SELECT v.video_id AS id, v.channel_id AS channelId, v.title, v.thumbnail_url AS thumbnailUrl,
    v.published_at AS publishedAt, v.duration_seconds AS durationSeconds, v.embeddable, v.availability, c.title AS channel, c.thumbnail_url AS channelThumbnailUrl
    FROM videos v JOIN channels c ON c.sub = v.sub AND c.channel_id = v.channel_id
    WHERE v.sub = ? AND c.subscribed = 1 AND v.last_fetched_at >= ? AND c.last_synced_at >= ? AND v.availability = 'public' AND v.embeddable = 1
    ORDER BY v.published_at DESC, v.video_id LIMIT ?`,
  )
    .bind(session.sub, cutoff, cutoff, limit)
    .all();
  const account = await c.env.DB.prepare(
    "SELECT last_synced_at, video_watermark FROM accounts WHERE sub = ?",
  )
    .bind(session.sub)
    .first<{ last_synced_at: number | null; video_watermark: number | null }>();
  const job = await c.env.DB.prepare(
    "SELECT state_json FROM sync_jobs WHERE sub = ? AND expires_at > ?",
  )
    .bind(session.sub, now())
    .first<{ state_json: string }>();
  return c.json({
    channels: channels.results,
    videos: videos.results,
    lastSyncedAt: account?.last_synced_at ?? null,
    watermark: account?.video_watermark ?? null,
    limit,
    issues: job ? parseState(job.state_json).issues : [],
  });
}
