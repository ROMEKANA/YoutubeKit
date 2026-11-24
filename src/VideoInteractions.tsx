import { useEffect, useRef, useState } from "react";
import {
  commentMaxLength,
  type CommentDetails,
  type VideoInteraction,
  type YouTubeIdentity,
} from "../shared/interactions";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import type { Video } from "./model";
import { ApiError, request, type ServerStatus } from "./useCatalog";

type InteractionResult = VideoInteraction & { ratingError?: string };
type CommentTarget = {
  video: Video;
  channel: YouTubeIdentity;
  account: string;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : "通信に失敗しました。";
const endpoint = (id: string, path: string) => `/api/videos/${id}/${path}`;
const targetKey = (account: string, channel: string, video: string) =>
  `${account}:${channel}:${video}`;

function write(path: string, csrf: string, body?: object) {
  return request(path, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
}

export function YouTubePrivacyConsent({
  csrf,
  onAccept,
}: {
  csrf: string;
  onAccept: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="youtube-privacy-consent">
      <p className="panel-note">
        概要欄・高評価・コメントを使うには、更新したプライバシーポリシーを確認してください。
      </p>
      <a href="/privacy.html" target="_blank" rel="noreferrer">
        プライバシーポリシーを開く
      </a>
      <button
        className="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          void write("/api/youtube/privacy", csrf)
            .then(onAccept)
            .catch((reason: unknown) => {
              setError(message(reason));
              setBusy(false);
            });
        }}
      >
        同意して使う
      </button>
      {error && (
        <p className="panel-note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function YouTubeConsent({ csrf }: { csrf: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        className="secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          void write("/api/youtube/consent", csrf)
            .then((data) => {
              const url = new URL((data as { url: string }).url);
              if (url.origin !== "https://accounts.google.com")
                throw new Error("Googleの同意画面を開けませんでした。");
              window.location.assign(url);
            })
            .catch((reason: unknown) => {
              setError(message(reason));
              setBusy(false);
            });
        }}
      >
        {busy ? "Googleへ接続中…" : "高評価・コメントを許可"}
      </button>
      {error && (
        <p className="panel-note" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function VideoInteractions({
  video,
  playbackLoad,
  refresh,
  auth,
}: {
  video: Video | null;
  playbackLoad: number;
  refresh: number;
  auth: ServerStatus;
}) {
  const videoId = video?.id;
  const sub = auth.account?.sub;
  const displayedTarget = useRef({ sub, videoId });
  displayedTarget.current = { sub, videoId };
  const csrf = auth.csrfToken ?? "";
  const cached = useRef(new Map<string, InteractionResult>());
  const drafts = useRef(new Map<string, string>());
  const requestRevision = useRef(0);
  const ratingOperation = useRef("");
  const [lastChannel, setLastChannel] = useState(auth.youtube?.channel?.id);
  const [result, setResult] = useState<{
    key: string;
    value: InteractionResult;
  }>();
  const [statusError, setStatusError] = useState<{
    key: string;
    message: string;
  }>();
  const [retry, setRetry] = useState(0);
  const [ratingBusy, setRatingBusy] = useState("");
  const [ratingNotice, setRatingNotice] = useState<{
    key: string;
    message: string;
  }>();
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const loadKey = `${sub}:${videoId}:${playbackLoad}:${refresh}:${retry}`;
  const current = result?.key === loadKey ? result.value : undefined;
  const cacheChannel = auth.youtube?.channel?.id ?? lastChannel;
  const cachedValue =
    sub && videoId && cacheChannel
      ? cached.current.get(targetKey(sub, cacheChannel, videoId))
      : undefined;
  const shown =
    current ?? (statusError?.key === loadKey ? undefined : cachedValue);
  const visibleError =
    statusError?.key === loadKey ? statusError.message : current?.ratingError;
  const commentLabel =
    shown?.comment === "posted"
      ? "コメント編集"
      : shown?.comment === "unknown" || shown?.comment === "verify"
        ? "コメント確認・復旧"
        : shown?.comment === "busy"
          ? "コメント処理中"
          : "コメント";

  useEffect(() => {
    if (!sub || !videoId) return;
    const controller = new AbortController();
    const revision = ++requestRevision.current;
    void request(endpoint(videoId, "interactions"), {}, controller.signal)
      .then((response) => {
        if (controller.signal.aborted || revision !== requestRevision.current)
          return;
        const value = response as InteractionResult;
        const key = targetKey(sub, value.channel.id, videoId);
        if (cached.current.size >= 100) {
          const oldest = cached.current.keys().next().value;
          if (oldest) cached.current.delete(oldest);
        }
        cached.current.set(key, value);
        setLastChannel(value.channel.id);
        setResult({ key: loadKey, value });
        setStatusError(undefined);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && revision === requestRevision.current)
          setStatusError({ key: loadKey, message: message(error) });
      });
    return () => controller.abort();
  }, [loadKey, sub, videoId]);

  async function rate() {
    if (
      !current?.ratingFresh ||
      !current.rating ||
      !current.channel.canWrite ||
      !videoId ||
      !sub ||
      ratingOperation.current
    )
      return;
    const key = targetKey(sub, current.channel.id, videoId);
    const operation = crypto.randomUUID();
    ratingOperation.current = operation;
    setRatingBusy(key);
    setRatingNotice(undefined);
    const version = ++requestRevision.current;
    try {
      const data = (await write(endpoint(videoId, "rating"), csrf, {
        channelId: current.channel.id,
        rating: current.rating === "like" ? "none" : "like",
      })) as Pick<InteractionResult, "rating" | "ratingFresh">;
      const ratingUpdate = {
        rating: data.rating,
        ratingFresh: data.ratingFresh,
        ratingError: undefined,
      };
      cached.current.set(key, {
        ...(cached.current.get(key) ?? current),
        ...ratingUpdate,
      });
      if (version !== requestRevision.current) {
        if (
          displayedTarget.current.sub === sub &&
          displayedTarget.current.videoId === videoId
        )
          setRetry((value) => value + 1);
        return;
      }
      // 評価の応答で、並行して変更したコメント表示を巻き戻さない。
      setResult((previous) =>
        previous?.key === loadKey
          ? { key: loadKey, value: { ...previous.value, ...ratingUpdate } }
          : previous,
      );
    } catch (error) {
      setRatingNotice({
        key: `${sub}:${videoId}:${playbackLoad}`,
        message: message(error),
      });
      if (
        displayedTarget.current.sub === sub &&
        displayedTarget.current.videoId === videoId
      )
        setRetry((value) => value + 1);
    } finally {
      ratingOperation.current = "";
      setRatingBusy("");
    }
  }

  return (
    <>
      {video && (
        <div className="video-interactions">
          {shown && (
            <p className="panel-note">
              YouTubeの操作チャンネル {shown.channel.title}
            </p>
          )}
          <div className="video-interaction-buttons">
            <button
              className={
                shown?.rating === "like"
                  ? "secondary selected-rating"
                  : "secondary"
              }
              aria-pressed={
                shown?.rating === null || !shown
                  ? undefined
                  : shown.rating === "like"
              }
              disabled={
                !current?.ratingFresh ||
                !current.channel.canWrite ||
                !!ratingBusy
              }
              onClick={() => void rate()}
            >
              <Icon name="like" />
              {ratingBusy &&
              ratingBusy ===
                targetKey(sub ?? "", shown?.channel.id ?? "", video.id)
                ? "処理中…"
                : shown?.rating === "like"
                  ? "高評価済み"
                  : shown?.rating
                    ? "高評価"
                    : "高評価（未確認）"}
            </button>
            <button
              className="secondary"
              disabled={
                !current ||
                !sub ||
                (current.comment === "empty" && !current.channel.canWrite)
              }
              onClick={() => {
                if (current && sub)
                  setTarget({ video, account: sub, channel: current.channel });
              }}
            >
              <Icon name="comment" />
              {commentLabel}
            </button>
          </div>
          {((current && !current.channel.canWrite) ||
            (!current && auth.youtube?.canWrite === false && !visibleError)) &&
            csrf && <YouTubeConsent csrf={csrf} />}
          {!current && !visibleError && (
            <p className="panel-note" role="status">
              YouTubeの操作状態を確認中…
            </p>
          )}
          {visibleError && (
            <div className="panel-note" role="status">
              <p>{visibleError}</p>
              <button
                className="text-button"
                onClick={() => setRetry((value) => value + 1)}
              >
                操作状態を再確認
              </button>
            </div>
          )}
          {ratingNotice?.key === `${sub}:${video.id}:${playbackLoad}` && (
            <p className="panel-note" role="alert">
              {ratingNotice.message}
            </p>
          )}
        </div>
      )}
      {target && (
        <CommentDialog
          target={target}
          csrf={csrf}
          drafts={drafts.current}
          onClose={() => setTarget(null)}
          onChange={(state) => {
            const key = targetKey(
              target.account,
              target.channel.id,
              target.video.id,
            );
            const value = cached.current.get(key);
            if (value) cached.current.set(key, { ...value, comment: state });
            setResult((previous) =>
              previous?.key === loadKey &&
              previous.value.channel.id === target.channel.id &&
              videoId === target.video.id
                ? { ...previous, value: { ...previous.value, comment: state } }
                : previous,
            );
          }}
        />
      )}
    </>
  );
}

function CommentDialog({
  target,
  csrf,
  drafts,
  onChange,
  onClose,
}: {
  target: CommentTarget;
  csrf: string;
  drafts: Map<string, string>;
  onChange: (state: CommentDetails["state"]) => void;
  onClose: () => void;
}) {
  const { video, channel, account } = target;
  const key = targetKey(account, channel.id, video.id);
  const path = endpoint(video.id, "comment");
  const [details, setDetails] = useState<CommentDetails>();
  const [body, setBody] = useState(drafts.get(key) ?? "");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [confirmation, setConfirmation] = useState<"delete" | "reset">();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const count = [...body].length;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void request(
      `${path}?channel=${encodeURIComponent(channel.id)}`,
      {},
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        const value = data as CommentDetails;
        setDetails(value);
        setBody(drafts.get(key) ?? value.body ?? "");
        onChangeRef.current(value.state);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setDetails(undefined);
        setError(message(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, channel.id, drafts, key, retry]);

  async function submit(action: "create" | "edit" | "delete" | "reset") {
    if (!details || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setConfirmation(undefined);
    setError("");
    try {
      const data = (await write(path, csrf, {
        action,
        channelId: channel.id,
        revision: details.revision,
        operation: `${Math.floor(Date.now() / 1000)}.${crypto.randomUUID()}`,
        ...(action === "create" || action === "edit" ? { body } : {}),
        ...(action === "reset" ? { confirmed: true } : {}),
      })) as CommentDetails;
      if (action !== "reset") drafts.delete(key);
      onChange(data.state);
      if (action === "reset") setRetry((value) => value + 1);
      else onClose();
    } catch (reason) {
      setError(message(reason));
      setDetails(undefined);
      if (reason instanceof ApiError && reason.code === "COMMENT_UNKNOWN")
        onChange("unknown");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const allowInput = details?.state === "posted" || details?.state === "empty";
  return (
    <Modal
      title={details?.state === "posted" ? "コメント編集" : "コメント"}
      onClose={() => {
        if (!pendingRef.current) onClose();
      }}
    >
      <div className="comment-editor" aria-busy={loading || pending}>
        <p className="comment-video">{video.title}</p>
        <p className="panel-note">
          投稿者 {channel.title} ／
          投稿・編集したコメントはYouTubeに公開されます。
        </p>
        {loading && <p role="status">コメントを確認中…</p>}
        {pending && <p role="status">YouTubeで処理中…</p>}
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        {((!details && !loading && !pending) || details?.state === "busy") && (
          <button
            className="text-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            コメントの状態を再確認
          </button>
        )}
        {details?.state === "busy" && (
          <p className="panel-note">
            別の操作が進行中か、結果を確認しています。
          </p>
        )}
        {details?.state === "unknown" && !confirmation && (
          <>
            <p className="panel-note">
              投稿結果または保存済みコメントを確認できません。YouTubeのコメント履歴で確認し、投稿が残っていれば必要に応じて削除してください。
            </p>
            <a
              href="https://www.youtube.com/feed/history/comment_history"
              target="_blank"
              rel="noreferrer"
            >
              YouTubeのコメント履歴
            </a>
            <button
              className="secondary"
              disabled={pending || !channel.canWrite}
              onClick={() => setConfirmation("reset")}
            >
              管理状態をリセット
            </button>
          </>
        )}
        {allowInput && !confirmation && !loading && (
          <>
            <label className="comment-input">
              コメント本文
              <textarea
                rows={5}
                maxLength={2 * commentMaxLength}
                value={body}
                disabled={pending || !channel.canWrite}
                onChange={(event) => {
                  setBody(event.target.value);
                  drafts.set(key, event.target.value);
                }}
              />
            </label>
            <p className="panel-note">
              {count} / {commentMaxLength}文字
            </p>
            <div className="modal-footer">
              <button
                className="primary"
                disabled={
                  !channel.canWrite ||
                  pending ||
                  !body.trim() ||
                  count > commentMaxLength
                }
                onClick={() =>
                  void submit(details.state === "posted" ? "edit" : "create")
                }
              >
                {details.state === "posted" ? "変更を保存" : "YouTubeに投稿"}
              </button>
              {details.state === "posted" && (
                <button
                  className="secondary"
                  disabled={!channel.canWrite || pending}
                  onClick={() => setConfirmation("delete")}
                >
                  コメントを削除
                </button>
              )}
            </div>
          </>
        )}
        {confirmation && (
          <div className="notice" role="alert">
            <p>
              {confirmation === "delete"
                ? "このコメントをYouTubeから削除しますか？"
                : "YouTubeのコメント履歴で確認しましたか？リセットすると、この動画へ新しく投稿できるようになります。"}
            </p>
            <div className="modal-footer">
              <button
                className="secondary"
                onClick={() => void submit(confirmation)}
              >
                {confirmation === "delete"
                  ? "削除する"
                  : "確認済み・リセットする"}
              </button>
              <button
                className="text-button"
                onClick={() => setConfirmation(undefined)}
              >
                戻る
              </button>
            </div>
          </div>
        )}
        {!channel.canWrite && <YouTubeConsent csrf={csrf} />}
        <button className="text-button" disabled={pending} onClick={onClose}>
          キャンセル
        </button>
      </div>
    </Modal>
  );
}
