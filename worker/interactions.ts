import {
  commentMaxLength,
  type CommentDetails,
  type CommentState,
  type Rating,
} from "../shared/interactions";
import {
  accessToken,
  now,
  requireInteractionSession,
  youtubeAccess,
  type WorkerContext,
  type YouTubeGrant,
} from "./auth";
import { AppError, requireCondition } from "./errors";
import { sha256 } from "./security";
import {
  record,
  YouTubeClient,
  YouTubeRejected,
  type YouTubeComment,
} from "./youtube";
import { videoStatement } from "./videoStore";

const day = 86400;
export const interactionRetention = 29 * day;
const ratingLease = 90;
const commentRecoveryDelay = 5 * 60;
const operationLifetime = day;
const unavailableChannel =
  "現在のYouTubeチャンネルを確認できません。YouTubeのチャンネルとGoogle接続を確認してください。";
const changedChannel =
  "操作するYouTubeチャンネルが変わりました。画面を更新して確認してください。";

function videoId(c: WorkerContext) {
  const id = c.req.param("id");
  requireCondition(
    id && /^[\w-]{11}$/.test(id),
    "INVALID_VIDEO",
    "動画IDが正しくありません。",
  );
  return id;
}

async function jsonBody(c: WorkerContext) {
  requireCondition(
    c.req.header("Content-Type")?.split(";")[0] === "application/json",
    "INVALID_BODY",
    "操作内容の形式が正しくありません。",
  );
  return record(await c.req.json().catch(() => null));
}

export async function getDescription(c: WorkerContext) {
  const session = await requireInteractionSession(c);
  const id = videoId(c);
  const startedAt = now();
  const cached = await c.env.DB.prepare(
    "SELECT description FROM videos WHERE sub = ? AND video_id = ? AND last_fetched_at > ?",
  )
    .bind(session.sub, id, startedAt - interactionRetention)
    .first<{ description: string | null }>();
  if (cached?.description != null)
    return c.json({ description: cached.description });

  const [video] = await new YouTubeClient(
    await accessToken(c.env, session),
  ).videos([id]);
  requireCondition(
    video,
    "VIDEO_GONE",
    "動画の概要欄をYouTubeから取得できません。",
    404,
  );
  // キューから直接開ける動画も保存する。並行した同期で更新された行は上書きしない。
  await videoStatement(
    c.env.DB,
    session.sub,
    video,
    startedAt,
    "EXISTS (SELECT 1 FROM accounts WHERE sub = ? AND grant_id = ?) AND NOT EXISTS (SELECT 1 FROM videos WHERE sub = ? AND video_id = ? AND last_fetched_at > ?)",
    [session.sub, session.grant_id, session.sub, id, startedAt],
  ).run();
  return c.json({ description: video.description });
}

// トークンの操作主体を公式APIで確認する。権限追加・アカウント変更と競合した結果は使わない。
async function identity(env: Env, grant: YouTubeGrant) {
  const { token, canWrite } = await youtubeAccess(env, grant);
  const api = new YouTubeClient(token);
  const own = await api.ownChannel();
  const result = await env.DB.prepare(
    `UPDATE accounts SET youtube_channel_id = ?, youtube_channel_title = ?, youtube_checked_at = ?
     WHERE sub = ? AND grant_id = ? AND refresh_token_cipher IS NOT NULL RETURNING youtube_write`,
  )
    .bind(own?.id ?? null, own?.title ?? null, now(), grant.sub, grant.grant_id)
    .first<{ youtube_write: number }>();
  requireCondition(result, "CHANNEL_CHANGED", changedChannel, 409);
  requireCondition(own, "CHANNEL_REQUIRED", unavailableChannel, 409);
  return {
    api,
    channel: { ...own, canWrite: canWrite && !!result.youtube_write },
  };
}

type Target = { sub: string; channelId: string; videoId: string; key: string };

async function requestTarget(
  c: WorkerContext,
  mutation = false,
  expectedChannel?: unknown,
) {
  const session = await requireInteractionSession(c, mutation);
  const id = videoId(c);
  const { api, channel } = await identity(c.env, session);
  if (mutation || expectedChannel !== undefined)
    requireCondition(
      expectedChannel === channel.id,
      "CHANNEL_CHANGED",
      changedChannel,
      409,
    );
  if (mutation)
    requireCondition(
      channel.canWrite,
      "WRITE_CONSENT_REQUIRED",
      "YouTubeの高評価・コメント権限を追加してください。",
      403,
    );
  const target: Target = {
    sub: session.sub,
    channelId: channel.id,
    videoId: id,
    key: await sha256(`${session.sub}:${channel.id}:${id}`),
  };
  return { db: c.env.DB, api, channel, target };
}

interface RatingRow {
  rating: Rating | null;
  checked_at: number | null;
  updated_at: number;
  operation_id: string | null;
  revision: string;
}

const ratingWhere = "sub = ? AND youtube_channel_id = ? AND video_id = ?";
const ratingKeys = (target: Target) => [
  target.sub,
  target.channelId,
  target.videoId,
];

async function readRating(db: D1Database, target: Target) {
  return db
    .prepare(`SELECT * FROM video_ratings WHERE ${ratingWhere}`)
    .bind(...ratingKeys(target))
    .first<RatingRow>();
}

async function ensureRating(db: D1Database, target: Target) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO video_ratings(sub, youtube_channel_id, video_id, updated_at, revision) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(...ratingKeys(target), now(), crypto.randomUUID())
    .run();
  const row = await readRating(db, target);
  requireCondition(
    row,
    "RATING_UNAVAILABLE",
    "高評価を確認できませんでした。",
    503,
  );
  return row;
}

function visibleRating(row: RatingRow | null) {
  return row?.checked_at && row.checked_at > now() - interactionRetention
    ? row.rating
    : null;
}

async function refreshRating(
  db: D1Database,
  api: YouTubeClient,
  target: Target,
) {
  const row = await ensureRating(db, target);
  let rating: Rating;
  try {
    rating = await api.rating(target.videoId);
  } catch (error) {
    const current = await readRating(db, target);
    return {
      rating: visibleRating(current),
      ratingFresh: false,
      ratingError:
        error instanceof AppError
          ? error.message
          : "高評価を確認できませんでした。",
    };
  }
  // 操作開始後に、操作より前の取得結果が保存されることを防ぐ。
  const result = await db
    .prepare(
      `UPDATE video_ratings SET rating = ?, checked_at = ?, updated_at = ?, revision = ?, operation_id = NULL
     WHERE ${ratingWhere} AND revision = ? AND (operation_id IS NULL OR updated_at <= ?)`,
    )
    .bind(
      rating,
      now(),
      now(),
      crypto.randomUUID(),
      ...ratingKeys(target),
      row.revision,
      now() - ratingLease,
    )
    .run();
  if (result.meta.changes) return { rating, ratingFresh: true };
  const current = await readRating(db, target);
  const cached = visibleRating(current);
  const ratingFresh = cached !== null && !current?.operation_id;
  return {
    rating: cached,
    ratingFresh,
    ...(ratingFresh
      ? {}
      : {
          ratingError:
            "高評価の処理が進行中です。少し待ってから状態を再確認してください。",
        }),
  };
}

export async function getInteractions(c: WorkerContext) {
  const { api, db, channel, target } = await requestTarget(c);
  const [rating, comment] = await Promise.all([
    refreshRating(db, api, target),
    readComment(db, target),
  ]);
  return c.json({ channel, ...rating, comment: commentState(comment) });
}

export async function setRating(c: WorkerContext) {
  await requireInteractionSession(c, true);
  const body = await jsonBody(c);
  const wanted = body.rating;
  requireCondition(
    wanted === "like" || wanted === "none",
    "INVALID_RATING",
    "高評価の操作が正しくありません。",
  );
  const { api, db, channel, target } = await requestTarget(
    c,
    true,
    body.channelId,
  );
  const row = await ensureRating(db, target);
  const operation = crypto.randomUUID();
  const reserved = await db
    .prepare(
      `UPDATE video_ratings SET updated_at = ?, revision = ?, operation_id = ?
     WHERE ${ratingWhere} AND revision = ? AND (operation_id IS NULL OR updated_at <= ?)`,
    )
    .bind(
      now(),
      operation,
      operation,
      ...ratingKeys(target),
      row.revision,
      now() - ratingLease,
    )
    .run();
  requireCondition(
    reserved.meta.changes,
    "RATING_BUSY",
    "別の画面で高評価を処理中です。再確認してください。",
    409,
  );

  async function finish(rating?: Rating) {
    await db
      .prepare(
        `UPDATE video_ratings SET rating = COALESCE(?, rating), checked_at = COALESCE(?, checked_at),
       updated_at = ?, revision = ?, operation_id = NULL WHERE ${ratingWhere} AND operation_id = ?`,
      )
      .bind(
        rating ?? null,
        rating ? now() : null,
        now(),
        crypto.randomUUID(),
        ...ratingKeys(target),
        operation,
      )
      .run();
  }
  let rating: Rating;
  try {
    rating = await api.rating(target.videoId);
    if (
      (wanted === "none" && rating === "like") ||
      (wanted === "like" && rating !== "like")
    ) {
      try {
        await api.rate(target.videoId, wanted);
        rating = wanted;
      } catch (error) {
        if (error instanceof YouTubeRejected) throw error;
        try {
          rating = await api.rating(target.videoId);
          if (rating !== wanted) throw error;
        } catch {
          throw new AppError(
            "RATING_UNKNOWN",
            "操作結果を確認できませんでした。高評価状態を再確認してください。",
            502,
          );
        }
      }
    }
  } catch (error) {
    await finish();
    throw error;
  }
  await finish(rating);
  return c.json({ channel, rating, ratingFresh: true });
}

interface CommentRow {
  comment_id: string | null;
  state: "empty" | "posted" | "creating" | "editing" | "deleting" | "unknown";
  operation_id: string;
  checked_at: number | null;
  updated_at: number;
}

function commentState(row: CommentRow | null): CommentState {
  if (!row || row.state === "empty") return "empty";
  if (row.state === "unknown") return "unknown";
  if (row.state === "posted")
    return row.checked_at && row.checked_at > now() - interactionRetention
      ? "posted"
      : "unknown";
  if (row.updated_at > now() - commentRecoveryDelay) return "busy";
  return row.comment_id &&
    row.checked_at &&
    row.checked_at > now() - interactionRetention
    ? "verify"
    : "unknown";
}

function readComment(db: D1Database, target: Target) {
  return db
    .prepare("SELECT * FROM video_comments WHERE sub = ? AND target_key = ?")
    .bind(target.sub, target.key)
    .first<CommentRow>();
}

function finishComment(
  db: D1Database,
  target: Target,
  operation: string,
  state: CommentRow["state"],
  id: string | null,
  checkedAt: number | null,
  revision = crypto.randomUUID(),
) {
  return db
    .prepare(
      `UPDATE video_comments SET author_channel_id = ?, video_id = ?, comment_id = ?, state = ?,
     checked_at = ?, last_recheck_at = NULL, updated_at = ?, operation_id = ? WHERE sub = ? AND target_key = ? AND operation_id = ?`,
    )
    .bind(
      id ? target.channelId : null,
      id ? target.videoId : null,
      id,
      state,
      checkedAt,
      now(),
      revision,
      target.sub,
      target.key,
      operation,
    )
    .run();
}

const validCommentId = (id: string) => /^[\w-]{1,256}$/.test(id);

// 動画は投稿時に確定したIDの紐付けで照合する。取得応答にも動画IDがあれば一致を確認する。
function matchesComment(
  item: YouTubeComment,
  target: Pick<Target, "videoId" | "channelId">,
) {
  return (
    !item.parentId &&
    (!item.videoId || item.videoId === target.videoId) &&
    // authorChannelId が省略された場合、原文は認証した投稿者にだけ返る。
    (item.authorId
      ? item.authorId === target.channelId
      : item.original !== undefined)
  );
}

function recentCommentMissing(error: unknown, row: CommentRow | null) {
  if (
    error instanceof AppError &&
    error.code === "COMMENT_GONE" &&
    row &&
    row.updated_at > now() - commentRecoveryDelay
  )
    return new AppError(
      "COMMENT_NOT_VISIBLE_YET",
      "保存済みのコメントをYouTubeでまだ確認できません。少し待ってから再確認してください。",
      409,
    );
  return null;
}

async function readOwnedComment(
  api: YouTubeClient,
  target: Target,
  id: string,
) {
  requireCondition(
    validCommentId(id),
    "COMMENT_UNVERIFIED",
    "保存済みコメントを確認できません。",
    409,
  );
  const [comment] = await api.comments([id]);
  requireCondition(
    comment && matchesComment(comment, target),
    "COMMENT_UNVERIFIED",
    "保存済みコメントを確認できません。YouTube上で公開状態を確認してください。",
    409,
  );
  return comment;
}

export async function getComment(c: WorkerContext) {
  const { db, api, target } = await requestTarget(
    c,
    false,
    c.req.query("channel") ?? "",
  );
  const row = await readComment(db, target);
  const state = commentState(row);
  const details: CommentDetails = { state, revision: row?.operation_id };
  if ((state !== "posted" && state !== "verify") || !row?.comment_id)
    return c.json(details);

  try {
    const comment = await readOwnedComment(api, target, row.comment_id);
    if (state === "verify") {
      const revision = crypto.randomUUID();
      const result = await finishComment(
        db,
        target,
        row.operation_id,
        "posted",
        comment.id,
        now(),
        revision,
      );
      requireCondition(
        result.meta.changes,
        "COMMENT_CHANGED",
        "コメントの状態が変わりました。開き直してください。",
        409,
      );
      details.revision = revision;
      details.state = "posted";
    } else {
      const result = await db
        .prepare(
          "UPDATE video_comments SET checked_at = ? WHERE sub = ? AND target_key = ? AND operation_id = ?",
        )
        .bind(now(), target.sub, target.key, row.operation_id)
        .run();
      requireCondition(
        result.meta.changes,
        "COMMENT_CHANGED",
        "コメントの状態が変わりました。開き直してください。",
        409,
      );
    }
    const body = comment.original ?? comment.display;
    requireCondition(
      body !== undefined,
      "COMMENT_UNVERIFIED",
      "YouTubeからコメント本文を取得できません。再確認してください。",
      502,
    );
    details.body = body;
    return c.json(details);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "COMMENT_GONE")
      throw error;
    const pendingVisibility = recentCommentMissing(error, row);
    if (pendingVisibility) throw pendingVisibility;
    const revision = crypto.randomUUID();
    const result = await finishComment(
      db,
      target,
      row.operation_id,
      "empty",
      null,
      null,
      revision,
    );
    requireCondition(
      result.meta.changes,
      "COMMENT_CHANGED",
      "コメントの状態が変わりました。開き直してください。",
      409,
    );
    return c.json({ state: "empty", revision } satisfies CommentDetails);
  }
}

export async function changeComment(c: WorkerContext) {
  await requireInteractionSession(c, true);
  const body = await jsonBody(c);
  const action = body.action;
  requireCondition(
    action === "create" ||
      action === "edit" ||
      action === "delete" ||
      action === "reset",
    "INVALID_OPERATION",
    "コメントの操作が正しくありません。",
  );
  const operation = body.operation;
  const timestamp =
    typeof operation === "string" ? Number(operation.split(".")[0]) : NaN;
  requireCondition(
    typeof operation === "string" &&
      /^\d{10}\.[\da-f-]{36}$/.test(operation) &&
      timestamp >= now() - operationLifetime &&
      timestamp <= now() + 300,
    "INVALID_OPERATION",
    "操作の有効期限が切れました。画面を開き直してください。",
  );
  const commentBody = typeof body.body === "string" ? body.body : "";
  if (action === "create" || action === "edit")
    requireCondition(
      commentBody.trim() &&
        !commentBody.includes("\0") &&
        [...commentBody].length <= commentMaxLength,
      "INVALID_COMMENT",
      `コメントは1〜${commentMaxLength}文字で入力してください。`,
    );
  const { db, api, target } = await requestTarget(c, true, body.channelId);
  const previous = await readComment(db, target);
  const state = commentState(previous);
  const eligible =
    action === "create"
      ? state === "empty"
      : action === "reset"
        ? state === "unknown" && body.confirmed === true
        : state === "posted";
  requireCondition(
    eligible && (body.revision ?? null) === (previous?.operation_id ?? null),
    "COMMENT_CHANGED",
    "別の画面でコメントの状態が変わりました。開き直してください。",
    409,
  );
  const videoChannelId =
    action === "create" ? await api.videoChannel(target.videoId) : "";
  const pending =
    action === "create"
      ? "creating"
      : action === "edit"
        ? "editing"
        : action === "delete"
          ? "deleting"
          : "unknown";

  // 同じリビジョンからの変更は1件だけ確保し、操作IDの登録も同じD1バッチで行う。
  const keys = [target.sub, target.key];
  const unused =
    "NOT EXISTS (SELECT 1 FROM comment_operations WHERE sub = ? AND operation_id = ?)";
  const reserve = previous
    ? db
        .prepare(
          `UPDATE video_comments SET state = ?, operation_id = ?, updated_at = ?
       WHERE sub = ? AND target_key = ? AND operation_id = ? AND ${unused}`,
        )
        .bind(
          pending,
          operation,
          now(),
          ...keys,
          previous.operation_id,
          target.sub,
          operation,
        )
    : db
        .prepare(
          `INSERT OR IGNORE INTO video_comments(sub, target_key, state, operation_id, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE ${unused}`,
        )
        .bind(...keys, pending, operation, now(), target.sub, operation);
  const [reservation] = await db.batch([
    reserve,
    db
      .prepare(
        `INSERT OR IGNORE INTO comment_operations(sub, operation_id, created_at)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM video_comments WHERE sub = ? AND target_key = ? AND operation_id = ?)`,
      )
      .bind(target.sub, operation, now(), ...keys, operation),
  ]);
  requireCondition(
    reservation.meta.changes,
    "COMMENT_CHANGED",
    "この操作は処理済みか、別の画面で処理中です。開き直して確認してください。",
    409,
  );

  let id = previous?.comment_id ?? null;
  let checked = previous?.checked_at ?? null;
  let writeStarted = false;
  try {
    if (action === "create") {
      writeStarted = true;
      const inserted = await api.insertComment(
        target.videoId,
        videoChannelId,
        commentBody,
      );
      requireCondition(
        validCommentId(inserted.id) &&
          !inserted.parentId &&
          (!inserted.videoId || inserted.videoId === target.videoId) &&
          (!inserted.authorId || inserted.authorId === target.channelId),
        "COMMENT_UNKNOWN",
        "投稿したコメントを確認できませんでした。",
        502,
      );
      id = inserted.id;
      checked = now();
    } else if (action === "reset") {
      id = null;
      checked = null;
    } else {
      requireCondition(
        id,
        "COMMENT_UNVERIFIED",
        "保存済みコメントを確認できません。",
        409,
      );
      await readOwnedComment(api, target, id);
      writeStarted = true;
      if (action === "edit") await api.updateComment(id, commentBody);
      else {
        await api.deleteComment(id);
        id = null;
      }
      checked = id ? now() : null;
    }
  } catch (error) {
    const pendingVisibility = !writeStarted
      ? recentCommentMissing(error, previous)
      : null;
    const gone = error instanceof AppError && error.code === "COMMENT_GONE";
    if (!writeStarted || error instanceof YouTubeRejected) {
      await finishComment(
        db,
        target,
        operation,
        id && (!gone || pendingVisibility) ? "posted" : "empty",
        gone && !pendingVisibility ? null : id,
        gone && !pendingVisibility ? null : checked,
      );
      throw pendingVisibility ?? error;
    }
    // IDがある編集・削除は、後で同じIDを照会できるよう処理状態を保つ。
    if (action === "create")
      await finishComment(db, target, operation, "unknown", null, null);
    throw new AppError(
      "COMMENT_UNKNOWN",
      "YouTubeでの操作結果が不明です。再送せず、後で状態を確認してください。",
      502,
    );
  }

  const finalState = id ? "posted" : "empty";
  try {
    const result = await finishComment(
      db,
      target,
      operation,
      finalState,
      id,
      checked,
    );
    requireCondition(
      result.meta.changes,
      "COMMENT_CHANGED",
      "コメントの管理状態が変わりました。",
      409,
    );
  } catch {
    // YouTubeへの書き込みは再送せず、確保済みの操作状態から復旧できるようにする。
    throw new AppError(
      "COMMENT_UNKNOWN",
      "操作結果を保存できませんでした。YouTubeでの状態を確認してください。",
      502,
    );
  }
  return c.json({ state: finalState } satisfies CommentDetails);
}

// 保持期限の前に、操作主体と管理対象のコメントIDだけを再確認する。
export async function refreshStoredComments(env: Env) {
  const cutoff = now() - 21 * day;
  const grants = await env.DB.prepare(
    `SELECT sub, grant_id, youtube_write, refresh_token_cipher FROM accounts a WHERE refresh_token_cipher IS NOT NULL
      AND (youtube_checked_at < ? OR EXISTS (SELECT 1 FROM video_comments v WHERE v.sub = a.sub AND v.checked_at < ? AND v.state = 'posted'))
      ORDER BY youtube_checked_at LIMIT 1`,
  )
    .bind(cutoff, cutoff)
    .all<YouTubeGrant>();
  for (const grant of grants.results) {
    const { api, channel } = await identity(env, grant);
    const { results } = await env.DB.prepare(
      `SELECT target_key, video_id, comment_id, operation_id FROM video_comments
      WHERE sub = ? AND author_channel_id = ? AND checked_at < ? AND state = 'posted'
      ORDER BY COALESCE(last_recheck_at, 0), checked_at LIMIT 30`,
    )
      .bind(grant.sub, channel.id, cutoff)
      .all<{
        target_key: string;
        video_id: string;
        comment_id: string;
        operation_id: string;
      }>();
    for (let offset = 0; offset < results.length; offset += 10) {
      const rows = results
        .slice(offset, offset + 10)
        .filter((row) => validCommentId(row.comment_id));
      if (!rows.length) continue;
      const attemptedAt = now();
      await env.DB.batch(
        rows.map((row) =>
          env.DB.prepare(
            "UPDATE video_comments SET last_recheck_at = ? WHERE sub = ? AND target_key = ? AND operation_id = ?",
          ).bind(attemptedAt, grant.sub, row.target_key, row.operation_id),
        ),
      );

      try {
        const returned = await api.comments(rows.map((row) => row.comment_id));
        const confirmed = rows.filter((row) =>
          returned.some(
            (item) =>
              item.id === row.comment_id &&
              matchesComment(item, {
                channelId: channel.id,
                videoId: row.video_id,
              }),
          ),
        );
        if (confirmed.length)
          await env.DB.batch(
            confirmed.map((row) =>
              env.DB.prepare(
                "UPDATE video_comments SET checked_at = ? WHERE sub = ? AND target_key = ? AND operation_id = ?",
              ).bind(now(), grant.sub, row.target_key, row.operation_id),
            ),
          );
      } catch (error) {
        // 一括応答の404では対象を特定できないため、保存済みIDを個別に照会する。
        if (
          !(error instanceof AppError) ||
          !["COMMENT_GONE", "YOUTUBE_FORBIDDEN"].includes(error.code)
        )
          throw error;
        for (const row of rows) {
          const target = {
            sub: grant.sub,
            channelId: channel.id,
            videoId: row.video_id,
            key: row.target_key,
          };
          try {
            await readOwnedComment(api, target, row.comment_id);
            await env.DB.prepare(
              "UPDATE video_comments SET checked_at = ? WHERE sub = ? AND target_key = ? AND operation_id = ?",
            )
              .bind(now(), grant.sub, row.target_key, row.operation_id)
              .run();
          } catch (itemError) {
            if (
              itemError instanceof AppError &&
              itemError.code === "COMMENT_GONE"
            )
              await finishComment(
                env.DB,
                target,
                row.operation_id,
                "empty",
                null,
                null,
              );
            else if (
              !(itemError instanceof AppError) ||
              !["COMMENT_UNVERIFIED", "YOUTUBE_FORBIDDEN"].includes(
                itemError.code,
              )
            )
              throw itemError;
          }
        }
      }
    }
  }
}
