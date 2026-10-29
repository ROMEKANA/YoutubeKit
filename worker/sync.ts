import { accessToken, now, requireSession, type WorkerContext } from "./auth";
import { boundedInteger } from "./config";
import { AppError, requireCondition } from "./errors";
import { decryptSecret, encryptSecret, randomToken } from "./security";
import { parseSyncIssues, type SyncIssue } from "../shared/sync";
import { videoStatement, rangeAssignments } from "./videoStore";
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
  full: boolean;
}

interface JobRow {
  job_id: string;
  state_json: string;
  access_token_cipher: string | null;
  expires_at: number;
}
const maxAge = 30 * 86400;
const routineUploadBatchSize = 5;
const recoverableChannelErrors = new Set([
  "YOUTUBE_ITEM_FAILED",
  "YOUTUBE_UNAVAILABLE",
  "YOUTUBE_RESPONSE",
  "YOUTUBE_PAGING",
  "YOUTUBE_PAGE_EXPIRED",
]);

// 対象固有の失敗だけを記録し、認証や利用上限の失敗は全体を中断する。
function isRecoverableChannelError(error: unknown): error is AppError {
  return error instanceof AppError && recoverableChannelErrors.has(error.code);
}

// videos.listの1リクエスト上限に合わせてIDを分割する。
function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}

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
    full: value.full === true,
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
export async function requestBody(
  c: WorkerContext,
): Promise<Record<string, unknown>> {
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
    parseState(current.state_json).phase !== "done" &&
    parseState(current.state_json).full === (body.full === true)
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
    full: body.full === true,
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
    WHERE sync_jobs.expires_at <= ? OR json_extract(sync_jobs.state_json, '$.phase') = 'done'
    OR (COALESCE(json_extract(sync_jobs.state_json, '$.full'), 0) <> ? AND sync_jobs.lease_until <= ?)`,
  )
    .bind(
      session.sub,
      jobId,
      JSON.stringify(state),
      cipher,
      startedAt,
      startedAt + 3600,
      startedAt,
      Number(body.full === true),
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
    AND NOT EXISTS (SELECT 1 FROM channels WHERE sub = ? AND history_lease_until > ?)
    RETURNING job_id, state_json, access_token_cipher, expires_at`,
  )
    .bind(
      lease,
      now() + 90,
      session.sub,
      body.jobId,
      now(),
      now(),
      session.sub,
      now(),
    )
    .first<JobRow>();
  if (!acquired) {
    const current = await c.env.DB.prepare(
      "SELECT job_id, lease_until FROM sync_jobs WHERE sub = ? AND expires_at > ?",
    )
      .bind(session.sub, now())
      .first<{ job_id: string; lease_until: number }>();
    throw new AppError(
      current?.job_id === body.jobId ? "SYNC_BUSY" : "SYNC_EXPIRED",
      current?.job_id === body.jobId
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
          videoStatement(c.env.DB, session.sub, video, now(), guard, [
            session.sub,
            acquired.job_id,
            lease,
            now(),
          ]),
        );
      }
      state.videosUpdated += videos.length;
    };

    // 通常更新では新着確認を5チャンネルずつ並行し、端末とWorker間の往復回数を減らす。
    const processRoutineUploadBatch = async (): Promise<boolean> => {
      if (state.full || state.pageToken) return false;
      const candidateIds = state.channelIds.slice(
        state.channelIndex,
        state.channelIndex + routineUploadBatchSize,
      );
      if (candidateIds.length < 2) return false;
      const placeholders = candidateIds.map(() => "?").join(",");
      const rows = await c.env.DB.prepare(
        `SELECT channel_id, title, uploads_playlist_id, video_watermark FROM channels
        WHERE sub = ? AND channel_id IN (${placeholders})`,
      )
        .bind(session.sub, ...candidateIds)
        .all<{
          channel_id: string;
          title: string;
          uploads_playlist_id: string;
          video_watermark: number | null;
        }>();
      const byId = new Map(rows.results.map((row) => [row.channel_id, row]));
      const targets: {
        id: string;
        title: string;
        playlistId: string;
        watermark: number;
      }[] = [];
      for (const id of candidateIds) {
        const channel = byId.get(id);
        if (
          !channel?.uploads_playlist_id ||
          channel.video_watermark === null ||
          state.freshIds.includes(id)
        )
          break;
        targets.push({
          id,
          title: channel.title,
          playlistId: channel.uploads_playlist_id,
          watermark: channel.video_watermark,
        });
      }
      if (targets.length < 2) return false;

      type BatchResult =
        | {
            target: (typeof targets)[number];
            page: Awaited<ReturnType<YouTubeClient["uploads"]>>;
            recent: ReturnType<typeof selectRecentUploads>;
            error?: never;
          }
        | {
            target: (typeof targets)[number];
            error: AppError;
            page?: never;
            recent?: never;
          };
      const results: BatchResult[] = await Promise.all(
        targets.map(async (target): Promise<BatchResult> => {
          try {
            const page = await api.uploads(target.playlistId);
            const cutoff = Math.max(
              0,
              target.watermark -
                boundedInteger(c.env.SYNC_OVERLAP_SECONDS, 600, 86400),
            );
            return {
              target,
              page,
              recent: selectRecentUploads(page.items, cutoff),
            };
          } catch (error) {
            if (!isRecoverableChannelError(error)) throw error;
            return { target, error };
          }
        }),
      );
      const accepted: BatchResult[] = [];
      for (const result of results) {
        accepted.push(result);
        if (
          !result.error &&
          result.page.nextPageToken &&
          !result.recent.reachedCutoff
        )
          break;
      }
      const detailIds = [
        ...new Set(
          accepted.flatMap((result) => (result.error ? [] : result.recent.ids)),
        ),
      ];
      const details = (
        await Promise.all(chunks(detailIds, 50).map((ids) => api.videos(ids)))
      ).flat();

      for (const result of accepted) {
        if (result.error) {
          state.issues.push({
            channelId: result.target.id,
            title: result.target.title || result.target.id,
            code: result.error.code,
            message: result.error.message,
          });
          state.channelIndex += 1;
          continue;
        }
        const recentIds = new Set(result.recent.ids);
        saveVideos(
          details.filter(
            (video) =>
              video.channelId === result.target.id && recentIds.has(video.id),
          ),
        );
        state.uploadPage = 1;
        if (result.page.nextPageToken && !result.recent.reachedCutoff) {
          state.pageToken = result.page.nextPageToken;
          break;
        }
        writes.push(
          guarded(
            `UPDATE channels SET video_watermark = ?, ${rangeAssignments} WHERE sub = ? AND channel_id = ? AND $guard`,
            [state.startedAt, session.sub, result.target.id],
          ),
        );
        state.channelIndex += 1;
        state.uploadPage = 0;
      }
      if (state.channelIndex >= state.channelIds.length)
        state.phase = "refresh";
      return true;
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
      if (!(await processRoutineUploadBatch())) {
        const id = state.channelIds[state.channelIndex];
        const channel = id
          ? await c.env.DB.prepare(
              "SELECT title, uploads_playlist_id, video_watermark FROM channels WHERE sub = ? AND channel_id = ?",
            )
              .bind(session.sub, id)
              .first<{
                title: string;
                uploads_playlist_id: string;
                video_watermark: number | null;
              }>()
          : null;
        let finishedChannel = true;
        try {
          if (channel?.uploads_playlist_id) {
            const page = await api.uploads(
              channel.uploads_playlist_id,
              state.pageToken,
            );
            const cutoff =
              state.full || state.freshIds.includes(id)
                ? 0
                : channel.video_watermark
                  ? Math.max(
                      0,
                      channel.video_watermark -
                        boundedInteger(c.env.SYNC_OVERLAP_SECONDS, 600, 86400),
                    )
                  : state.cutoff;
            const recent = selectRecentUploads(page.items, cutoff);
            saveVideos(
              (await api.videos(recent.ids)).filter(
                (video) => video.channelId === id,
              ),
            );
            state.uploadPage += 1;
            if (cutoff === 0) {
              writes.push(
                guarded(
                  `UPDATE channels SET history_page_token = ?, history_complete = ?, history_started_at = ?, ${rangeAssignments}
              WHERE sub = ? AND channel_id = ? AND $guard`,
                  [
                    page.nextPageToken,
                    Number(!page.nextPageToken),
                    state.startedAt,
                    session.sub,
                    id,
                  ],
                ),
              );
            }
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
          if (!isRecoverableChannelError(error)) throw error;
          state.issues.push({
            channelId: id,
            title: channel?.title || id,
            code: error.code,
            message: error.message,
          });
          if (state.full && state.issues.length === 1)
            writes.push(
              guarded(
                "UPDATE accounts SET warning_revision = ? WHERE sub = ? AND $guard",
                [acquired.job_id, session.sub],
              ),
            );
        }
        if (finishedChannel) {
          if (id && !state.issues.some((issue) => issue.channelId === id))
            writes.push(
              guarded(
                `UPDATE channels SET video_watermark = ?, ${rangeAssignments} WHERE sub = ? AND channel_id = ? AND $guard`,
                [state.startedAt, session.sub, id],
              ),
            );
          state.channelIndex += 1;
          state.pageToken = "";
          state.uploadPage = 0;
        }
        if (state.channelIndex >= state.channelIds.length)
          state.phase = "refresh";
      }
    } else if (state.phase === "refresh") {
      // 過去分再取得では古い情報も再確認する。通常更新は新着だけにし、期限切れ分は日次削除する。
      const stale = state.full
        ? await c.env.DB.prepare(
            "SELECT video_id FROM videos WHERE sub = ? AND last_fetched_at < ? ORDER BY video_id LIMIT 50",
          )
            .bind(session.sub, state.startedAt - 27 * 86400)
            .all<{ video_id: string }>()
        : { results: [] };
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
  const channelId = c.req.query("channelId") ?? "all";
  requireCondition(
    channelId === "all" || /^UC[\w-]{22}$/.test(channelId),
    "INVALID_CHANNEL",
    "チャンネルの指定が正しくありません。",
  );
  const limit = boundedInteger(c.req.query("limit") ?? "30", 30, 5000);
  const seconds = Number(c.req.query("minDuration") ?? "-1");
  requireCondition(
    Number.isInteger(seconds) && seconds >= -1 && seconds <= 3600,
    "INVALID_DURATION",
    "除外時間の指定が正しくありません。",
  );
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
  const videos = await c.env.DB.prepare(
    `SELECT v.video_id AS id, v.channel_id AS channelId, v.title, v.thumbnail_url AS thumbnailUrl,
    v.published_at AS publishedAt, v.duration_seconds AS durationSeconds, v.embeddable, v.availability, c.title AS channel, c.thumbnail_url AS channelThumbnailUrl
    FROM videos v JOIN channels c ON c.sub = v.sub AND c.channel_id = v.channel_id
    WHERE v.sub = ? AND c.subscribed = 1 AND v.last_fetched_at >= ? AND c.last_synced_at >= ? AND v.availability = 'public' AND v.embeddable = 1
    AND (? = 'all' OR v.channel_id = ?) AND v.duration_seconds > ?
    ORDER BY v.published_at DESC, v.video_id LIMIT ?`,
  )
    .bind(session.sub, cutoff, cutoff, channelId, channelId, seconds, limit + 1)
    .all();
  const account = await c.env.DB.prepare(
    "SELECT last_synced_at, video_watermark, warning_revision FROM accounts WHERE sub = ?",
  )
    .bind(session.sub)
    .first<{
      last_synced_at: number | null;
      video_watermark: number | null;
      warning_revision: string;
    }>();
  const range =
    channelId === "all"
      ? null
      : await c.env.DB.prepare(
          "SELECT newest_published_at AS newest, oldest_published_at AS oldest, history_complete AS complete, history_started_at AS startedAt FROM channels WHERE sub = ? AND channel_id = ? AND subscribed = 1",
        )
          .bind(session.sub, channelId)
          .first<{
            newest: string | null;
            oldest: string | null;
            complete: number;
            startedAt: number;
          }>();
  const cacheHasMore = videos.results.length > limit;
  const job = await c.env.DB.prepare(
    "SELECT state_json FROM sync_jobs WHERE sub = ? AND expires_at > ?",
  )
    .bind(session.sub, now())
    .first<{ state_json: string }>();
  return c.json({
    channels: channels.results,
    videos: videos.results.slice(0, limit),
    lastSyncedAt: account?.last_synced_at ?? null,
    watermark: account?.video_watermark ?? null,
    limit,
    issues: job ? parseState(job.state_json).issues : [],
    warningRevision: account?.warning_revision ?? "",
    cacheHasMore,
    hasMore:
      cacheHasMore ||
      !!(range && (!range.complete || range.startedAt < now() - 27 * 86400)),
    range,
  });
}

// 一覧の30件に含まれない保存キューの情報も、アカウントの取得済みデータから復元する。
export async function getSavedVideos(c: WorkerContext): Promise<Response> {
  const session = await requireSession(c);
  const ids = (c.req.query("ids") ?? "").split(",");
  requireCondition(
    ids.length <= 100 && ids.every((id) => /^[\w-]{11}$/.test(id)),
    "INVALID_IDS",
    "動画IDの指定が正しくありません。",
  );
  const result = await c.env.DB.prepare(
    `SELECT v.video_id AS id, v.channel_id AS channelId, v.title, v.thumbnail_url AS thumbnailUrl,
    v.published_at AS publishedAt, v.duration_seconds AS durationSeconds, c.title AS channel, c.thumbnail_url AS channelThumbnailUrl
    FROM videos v JOIN channels c ON c.sub = v.sub AND c.channel_id = v.channel_id
    WHERE v.sub = ? AND v.video_id IN (SELECT value FROM json_each(?)) AND v.last_fetched_at >= ? AND v.availability = 'public' AND v.embeddable = 1`,
  )
    .bind(session.sub, JSON.stringify(ids), now() - maxAge)
    .all();
  return c.json(result.results);
}
