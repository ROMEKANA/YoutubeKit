import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  addToQueue,
  formatDuration,
  moveItem,
  parseVideos,
  restoreState,
  storageKey,
  type Settings,
  type Video,
} from "./model";
import { Icon } from "./Icon";
import { Player } from "./Player";

type Panel = "channels" | "queue" | "settings" | null;
const thumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const dateLabel = (date: string) => new Date(date).toLocaleDateString("ja-JP");

// native dialogでフォーカス移動とEscapeによる閉じる操作を提供する。
function Modal({
  title,
  onClose,
  children,
  drawer = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={drawer ? "modal drawer" : "modal"}
      aria-label={title}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-inner">
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="閉じる" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

// プレーヤーを生成せず、画像のタップをキュー追加の操作として扱う。
function Thumbnail({
  video,
  added,
  onAdd,
}: {
  video: Video;
  added: boolean;
  onAdd: () => void;
}) {
  return (
    <button
      className="thumbnail"
      aria-label={`${video.title}をキューに追加`}
      aria-disabled={added}
      onClick={onAdd}
    >
      <img
        src={thumbnail(video.id)}
        alt=""
        loading="lazy"
        onError={(event) => {
          event.currentTarget.style.visibility = "hidden";
        }}
      />
      <span className="duration">{formatDuration(video.durationSeconds)}</span>
      {added && (
        <span className="added-mark">
          <Icon name="check" size={14} /> 追加済み
        </span>
      )}
    </button>
  );
}

// 試作ではブラウザ内に保存する。本番のD1同期とは保存処理を分離している。
function readInitialState() {
  try {
    return { state: restoreState(localStorage.getItem(storageKey)), error: "" };
  } catch {
    return {
      state: restoreState(null),
      error:
        "ブラウザの保存領域を利用できません。この画面を閉じると変更が失われます。",
    };
  }
}

// 一覧の選択状態と保存済みキューを管理し、開始操作で再生セッションを作る。
export function App() {
  const [initial] = useState(readInitialState);
  const [saved, setSaved] = useState(initial.state);
  const [storageError, setStorageError] = useState(initial.error);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [menuVideo, setMenuVideo] = useState<Video | null>(null);
  const [channelId, setChannelId] = useState("all");
  const [showHidden, setShowHidden] = useState(false);
  const [limit, setLimit] = useState(saved.settings.initialCount);
  const [toast, setToast] = useState("");
  const [session, setSession] = useState<Video[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const requestInFlight = useRef(false);
  const dragOrigin = useRef<number | null>(null);
  const dragTarget = useRef<number | null>(null);
  const settings = saved.settings;
  const queueVideos = saved.queue.map((id) =>
    videos.find((video) => video.id === id),
  );
  const queueSeconds = queueVideos.reduce(
    (sum, video) => sum + (video?.durationSeconds ?? 0),
    0,
  );
  const canPlay =
    saved.queue.length > 0 && queueVideos.every((video) => video !== undefined);
  const channels = [
    ...new Map(
      videos.map((video) => [
        video.channelId,
        { id: video.channelId, title: video.channel },
      ]),
    ).values(),
  ].sort((a, b) => a.title.localeCompare(b.title, "ja"));
  const visible = videos.filter(
    (video) =>
      (channelId === "all" || video.channelId === channelId) &&
      (showHidden || !saved.hidden.includes(video.id)) &&
      (!settings.excludeShort ||
        video.durationSeconds > settings.shortThreshold),
  );
  const currentChannel =
    channels.find((channel) => channel.id === channelId)?.title ??
    "すべてのチャンネル";

  // 更新失敗時も、直前に読み込めた動画一覧と保存キューを残す。
  async function refresh() {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    setLoadError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("/demo-videos.json", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("サンプル一覧を取得できませんでした。");
      setVideos(parseVideos(await response.json()));
      setUpdatedAt(
        new Date().toLocaleTimeString("ja-JP", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    } catch (error) {
      setLoadError(
        error instanceof Error && error.name !== "AbortError"
          ? error.message
          : "通信に失敗しました。更新ボタンから再試行してください。",
      );
    } finally {
      window.clearTimeout(timeout);
      requestInFlight.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(saved));
      setStorageError("");
    } catch {
      setStorageError(
        "変更を保存できませんでした。この画面を閉じる前に保存領域を確認してください。",
      );
    }
  }, [saved]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    setLimit(settings.initialCount);
  }, [channelId, showHidden, settings]);

  function add(video: Video) {
    setSaved((state) => ({
      ...state,
      queue: addToQueue(state.queue, video.id),
    }));
    setToast(
      saved.queue.includes(video.id)
        ? "この動画は追加済みです"
        : "キューに追加しました",
    );
  }

  function toggleHidden(video: Video) {
    const wasHidden = saved.hidden.includes(video.id);
    setSaved((state) => ({
      ...state,
      hidden: wasHidden
        ? state.hidden.filter((id) => id !== video.id)
        : [...state.hidden, video.id],
    }));
    setMenuVideo(null);
    setToast(wasHidden ? "動画を再表示しました" : "動画を非表示にしました");
  }

  function updateSettings(value: Partial<Settings>) {
    setSaved((state) => ({
      ...state,
      settings: { ...state.settings, ...value },
    }));
  }

  function reorder(from: number, to: number) {
    setSaved((state) => ({ ...state, queue: moveItem(state.queue, from, to) }));
  }

  function startPlayback() {
    if (!canPlay) return;
    setPanel(null);
    setSession(queueVideos.filter((video): video is Video => !!video));
    window.scrollTo({ top: 0 });
  }

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <button
            className="icon-button"
            aria-label="チャンネル一覧"
            onClick={() => setPanel("channels")}
            disabled={!!session}
          >
            <Icon name="menu" />
          </button>
          <a
            className="brand"
            href="/"
            onClick={(event) => event.preventDefault()}
          >
            <img src="/icon.svg" alt="" />
            <span>
              Youtube<span className="brand-light">Kit</span>
            </span>
          </a>
          <span className="prototype-badge">PROTOTYPE</span>
          <div className="header-actions">
            <button
              className={`icon-button ${loading ? "spinning" : ""}`}
              aria-label="サンプル一覧を更新"
              title="サンプル一覧を再読み込み"
              disabled={loading || !!session}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" />
            </button>
            <button
              className={`icon-button ${showHidden ? "active" : ""}`}
              aria-label="非表示動画も表示"
              aria-pressed={showHidden}
              disabled={!!session}
              onClick={() => setShowHidden(!showHidden)}
            >
              <Icon name="eye" />
            </button>
            <button
              className="icon-button"
              aria-label="設定"
              disabled={!!session}
              onClick={() => setPanel("settings")}
            >
              <Icon name="settings" />
            </button>
          </div>
        </div>
      </header>

      <main className={`main ${session ? "playing-main" : ""}`}>
        {storageError && (
          <p className="notice error" role="alert">
            {storageError}
          </p>
        )}
        {session ? (
          <Player videos={session} onClose={() => setSession(null)} />
        ) : (
          <>
            <section className="intro">
              <div>
                <p className="eyebrow">YOUR TIME, YOUR CHOICE</p>
                <h1>
                  観たいものだけ。
                  <br className="mobile-break" /> 観たい分だけ。
                </h1>
                <p className="intro-description">
                  サムネイルをタップして、キューに追加。
                </p>
              </div>
              <div className="intro-mark" aria-hidden="true">
                <span />
                <span />
                <span />
                <Icon name="play" size={29} />
              </div>
            </section>
            <div className="demo-banner">
              <span className="status-dot" />
              <p>
                サンプルモード{" "}
                <span>— 登録チャンネル連携前の、操作確認用の動画です。</span>
              </p>
              <button
                className="text-button"
                onClick={() => setPanel("settings")}
              >
                詳細 <Icon name="arrow" size={14} />
              </button>
            </div>
            <div className="home-columns">
              <section className="video-section" aria-label="動画一覧">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">VIDEO LIBRARY</p>
                    <h2>{currentChannel}</h2>
                  </div>
                  <span className="count-label">{visible.length} 本</span>
                </div>
                <div className="list-meta">
                  <span>
                    {showHidden ? "非表示の動画も表示中" : "公開日の新しい順"}
                  </span>
                  <span>
                    {loading
                      ? "読み込み中…"
                      : updatedAt
                        ? `再読込 ${updatedAt}`
                        : ""}
                  </span>
                </div>
                {loadError && (
                  <p className="notice error" role="alert">
                    {loadError}{" "}
                    <button
                      className="text-button"
                      onClick={() => void refresh()}
                    >
                      再試行
                    </button>
                  </p>
                )}
                <div className={`video-list density-${settings.density}`}>
                  {visible.slice(0, limit).map((video) => {
                    const added = saved.queue.includes(video.id);
                    const hidden = saved.hidden.includes(video.id);
                    return (
                      <article
                        className={`video-row ${hidden ? "is-hidden" : ""}`}
                        key={video.id}
                      >
                        <Thumbnail
                          video={video}
                          added={added}
                          onAdd={() => add(video)}
                        />
                        <button
                          className="video-details"
                          aria-label={`${video.title}の操作メニュー`}
                          onClick={() => setMenuVideo(video)}
                        >
                          <h3>{video.title}</h3>
                          <span className="channel-name">
                            <span
                              className={`avatar avatar-${video.channelId}`}
                              aria-hidden="true"
                            >
                              {video.channel[0]}
                            </span>
                            {video.channel}
                          </span>
                          <span className="video-date">
                            {dateLabel(video.publishedAt)}
                            {hidden && (
                              <span className="hidden-label">非表示</span>
                            )}
                          </span>
                        </button>
                        <button
                          className={`add-button ${added ? "is-added" : ""}`}
                          aria-label={`${video.title}を追加`}
                          aria-disabled={added}
                          onClick={() => add(video)}
                        >
                          <Icon name={added ? "check" : "plus"} />
                        </button>
                      </article>
                    );
                  })}
                </div>
                {!loading && !visible.length && (
                  <div className="empty-state">
                    <Icon name="list" size={32} />
                    <h3>表示する動画がありません</h3>
                    <p>
                      チャンネルや非表示・短い動画の設定を変更してみてください。
                    </p>
                  </div>
                )}
                {visible.length > limit ? (
                  <button
                    className="load-more secondary"
                    onClick={() =>
                      setLimit((value) => value + settings.additionalCount)
                    }
                  >
                    さらに表示（残り {visible.length - limit} 本）
                  </button>
                ) : (
                  !loading &&
                  visible.length > 0 && (
                    <p className="list-end">
                      <span />
                      ここまで。あとは、選んだ動画を楽しもう。
                      <span />
                    </p>
                  )
                )}
              </section>
              <aside className="queue-aside">
                <div className="aside-heading">
                  <Icon name="list" />
                  <h2>あなたのキュー</h2>
                  <span>{saved.queue.length}</span>
                </div>
                {saved.queue.length ? (
                  <>
                    <ol className="queue-preview">
                      {queueVideos.slice(0, 3).map((video, index) => (
                        <li key={saved.queue[index]}>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <div>
                            {video?.title ?? "取得できない動画"}
                            <small>
                              {video
                                ? formatDuration(video.durationSeconds)
                                : "一覧を更新してください"}
                            </small>
                          </div>
                        </li>
                      ))}
                    </ol>
                    {saved.queue.length > 3 && (
                      <p className="muted">ほか {saved.queue.length - 3} 本</p>
                    )}
                    <button
                      className="secondary full-width"
                      onClick={() => setPanel("queue")}
                    >
                      キューを確認する
                    </button>
                  </>
                ) : (
                  <div className="aside-empty">
                    <div className="empty-plus">
                      <Icon name="plus" size={26} />
                    </div>
                    <p>今日は、何を観よう。</p>
                    <small>
                      サムネイルをタップすると
                      <br />
                      ここに動画が並びます。
                    </small>
                  </div>
                )}
                <div className="aside-note">
                  <span className="status-dot" />
                  <p>
                    選んだ動画が終わったら、
                    <br />
                    再生も、そこでおしまい。
                  </p>
                </div>
              </aside>
            </div>
            <p className="sample-note">
              動画情報は試作用のサンプルです。日時・再生時間は概算を含み、最新情報とは異なる場合があります。
            </p>
          </>
        )}
      </main>

      {!session && (
        <footer className="queue-bar">
          <div className="queue-bar-inner">
            <button className="queue-summary" onClick={() => setPanel("queue")}>
              <span className="queue-icon">
                <Icon name="list" />
                <b>{saved.queue.length}</b>
              </span>
              <span>
                <strong>
                  再生キュー <span>{saved.queue.length} 本</span>
                </strong>
                <small>
                  合計 {formatDuration(queueSeconds, true)}
                  {saved.queue.length
                    ? " · 自動保存"
                    : " · 動画を選んでください"}
                </small>
              </span>
              <Icon name="arrow" size={16} />
            </button>
            <button
              className="primary play-button"
              disabled={!canPlay}
              onClick={startPlayback}
            >
              <Icon name="play" size={17} /> 再生開始
            </button>
          </div>
        </footer>
      )}
      <div
        className={`toast ${toast ? "visible" : ""}`}
        role="status"
        aria-live="polite"
      >
        {toast && (
          <>
            <Icon name="check" size={16} />
            {toast}
          </>
        )}
      </div>

      {panel === "channels" && (
        <Modal title="チャンネル" drawer onClose={() => setPanel(null)}>
          <p className="panel-note">サンプルチャンネル</p>
          <nav className="channel-nav">
            <button
              className={channelId === "all" ? "selected" : ""}
              onClick={() => {
                setChannelId("all");
                setPanel(null);
              }}
            >
              <span className="avatar all">
                <Icon name="list" size={17} />
              </span>
              すべてのチャンネル
            </button>
            {channels.map((channel) => (
              <button
                key={channel.id}
                className={channelId === channel.id ? "selected" : ""}
                onClick={() => {
                  setChannelId(channel.id);
                  setPanel(null);
                }}
              >
                <span className={`avatar avatar-${channel.id}`}>
                  {channel.title[0]}
                </span>
                {channel.title}
              </button>
            ))}
          </nav>
          <p className="panel-note">
            Googleアカウント連携は次の段階で追加します。
          </p>
        </Modal>
      )}

      {panel === "queue" && (
        <Modal title="再生キュー" onClose={() => setPanel(null)}>
          <div className="queue-heading">
            <p>
              {saved.queue.length} 本 <span>·</span> 合計{" "}
              {formatDuration(queueSeconds, true)}
            </p>
            <button
              className="text-button danger"
              disabled={!saved.queue.length}
              onClick={() => {
                if (window.confirm("再生キューをすべて削除しますか？"))
                  setSaved((state) => ({ ...state, queue: [] }));
              }}
            >
              全削除
            </button>
          </div>
          <p className="panel-note">
            左のハンドルをドラッグ、または上下ボタンで並べ替え。
          </p>
          {!saved.queue.length && (
            <div className="empty-state">
              <Icon name="list" size={32} />
              <h3>キューはまだ空です</h3>
              <p>動画一覧のサムネイルから追加できます。</p>
            </div>
          )}
          <ol className="queue-items">
            {saved.queue.map((id, index) => {
              const video = queueVideos[index];
              return (
                <li
                  key={id}
                  data-queue-index={index}
                  className={dragging === id ? "dragging" : ""}
                >
                  <button
                    className="drag-handle icon-button"
                    aria-label={`${video?.title ?? id}をドラッグして移動`}
                    onPointerDown={(event) => {
                      dragOrigin.current = index;
                      dragTarget.current = index;
                      setDragging(id);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (dragOrigin.current === null) return;
                      const row = document
                        .elementFromPoint(event.clientX, event.clientY)
                        ?.closest<HTMLElement>("[data-queue-index]");
                      if (row)
                        dragTarget.current = Number(row.dataset.queueIndex);
                    }}
                    onPointerUp={() => {
                      if (
                        dragOrigin.current !== null &&
                        dragTarget.current !== null
                      )
                        reorder(dragOrigin.current, dragTarget.current);
                      dragOrigin.current = null;
                      dragTarget.current = null;
                      setDragging(null);
                    }}
                    onPointerCancel={() => {
                      dragOrigin.current = null;
                      dragTarget.current = null;
                      setDragging(null);
                    }}
                  >
                    <Icon name="grip" size={18} />
                  </button>
                  <img className="queue-thumb" src={thumbnail(id)} alt="" />
                  <div className="queue-item-info">
                    <strong>
                      {index + 1}. {video?.title ?? `取得できない動画 (${id})`}
                    </strong>
                    <small>
                      {video
                        ? `${video.channel} · ${formatDuration(video.durationSeconds)}`
                        : "保存状態を残しています。必要に応じて削除してください。"}
                    </small>
                  </div>
                  <div className="reorder-buttons">
                    <button
                      aria-label={`${video?.title ?? id}を上へ`}
                      disabled={index === 0}
                      onClick={() => reorder(index, index - 1)}
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`${video?.title ?? id}を下へ`}
                      disabled={index === saved.queue.length - 1}
                      onClick={() => reorder(index, index + 1)}
                    >
                      ↓
                    </button>
                  </div>
                  <button
                    className="icon-button remove-button"
                    aria-label={`${video?.title ?? id}をキューから削除`}
                    onClick={() =>
                      setSaved((state) => ({
                        ...state,
                        queue: state.queue.filter((item) => item !== id),
                      }))
                    }
                  >
                    <Icon name="close" size={17} />
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="modal-footer">
            <p className="panel-note">このブラウザに自動保存されます。</p>
            <button
              className="primary full-width"
              disabled={!canPlay}
              onClick={startPlayback}
            >
              <Icon name="play" size={16} />
              このキューを再生
            </button>
          </div>
        </Modal>
      )}

      {panel === "settings" && (
        <Modal title="設定" onClose={() => setPanel(null)}>
          <div className="connection-card">
            <span className="tag">サンプルモード</span>
            <h3>Googleアカウント未接続</h3>
            <p>
              現在はサンプル動画で操作を試せます。キュー・非表示・設定はこのブラウザ内だけに保存されます。
            </p>
          </div>
          <div className="settings-section">
            <h3>動画一覧</h3>
            <label className="setting-row">
              <span>表示密度</span>
              <select
                value={settings.density}
                onChange={(event) =>
                  updateSettings({
                    density: event.target.value as Settings["density"],
                  })
                }
              >
                <option value="compact">コンパクト</option>
                <option value="standard">標準</option>
                <option value="large">大きめ</option>
              </select>
            </label>
            <label className="setting-row">
              <span>初回表示件数</span>
              <input
                type="number"
                min="1"
                max="100"
                value={settings.initialCount}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 1 && value <= 100)
                    updateSettings({ initialCount: value });
                }}
              />
            </label>
            <label className="setting-row">
              <span>追加表示件数</span>
              <input
                type="number"
                min="1"
                max="100"
                value={settings.additionalCount}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 1 && value <= 100)
                    updateSettings({ additionalCount: value });
                }}
              />
            </label>
          </div>
          <div className="settings-section">
            <h3>短い動画の除外</h3>
            <label className="setting-row">
              <span>時間で除外する</span>
              <input
                type="checkbox"
                checked={settings.excludeShort}
                onChange={(event) =>
                  updateSettings({ excludeShort: event.target.checked })
                }
              />
            </label>
            <label className="setting-row">
              <span>除外する秒数（以下）</span>
              <input
                type="number"
                min="1"
                max="3600"
                disabled={!settings.excludeShort}
                value={settings.shortThreshold}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 1 && value <= 3600)
                    updateSettings({ shortThreshold: value });
                }}
              />
            </label>
            <p className="panel-note">
              Shortsの暫定フィルターです。通常の短い動画も除外されます。
            </p>
          </div>
          <div className="settings-section">
            <h3>この試作について</h3>
            <p className="panel-note">
              v0.1.0 ·
              Google認証・登録チャンネル同期・端末間同期・PWAのインストールとオフライン更新は未実装です。
            </p>
            <p className="panel-note">
              プレーヤーにはYouTubeの利用規約とプライバシーポリシーが適用されます。
            </p>
            <div className="legal-links">
              <a
                href="https://www.youtube.com/t/terms"
                target="_blank"
                rel="noreferrer"
              >
                YouTube利用規約 ↗
              </a>
              <a
                href="https://policies.google.com/privacy"
                target="_blank"
                rel="noreferrer"
              >
                Googleプライバシーポリシー ↗
              </a>
            </div>
          </div>
        </Modal>
      )}

      {menuVideo && (
        <Modal title="動画の操作" onClose={() => setMenuVideo(null)}>
          <p className="menu-video-title">{menuVideo.title}</p>
          <div className="action-menu">
            <button
              onClick={() => {
                add(menuVideo);
                setMenuVideo(null);
              }}
            >
              <Icon name="plus" />
              {saved.queue.includes(menuVideo.id)
                ? "キューに追加済み"
                : "キューに追加"}
            </button>
            <button onClick={() => toggleHidden(menuVideo)}>
              <Icon name="eye" />
              {saved.hidden.includes(menuVideo.id)
                ? "この動画を再表示"
                : "この動画を非表示"}
            </button>
            <button className="muted" onClick={() => setMenuVideo(null)}>
              キャンセル
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
