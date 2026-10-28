import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { version as appVersion } from "../package.json";
import {
  toggleQueueItem,
  isExcludedByDuration,
  formatDuration,
  moveItem,
  restoreState,
  storageKey,
  type Settings,
  type Video,
} from "./model";
import { Icon } from "./Icon";
import { Player } from "./Player";
import { useCatalog, type CatalogController } from "./useCatalog";

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

// 画像をタップして選択を切り替え、選択中は現在の再生順を表示する。
function Thumbnail({
  video,
  queuePosition,
  onToggle,
}: {
  video: Video;
  queuePosition: number;
  onToggle: () => void;
}) {
  return (
    <button
      className="thumbnail"
      aria-label={`${video.title}をキュー${queuePosition ? "から削除" : "に追加"}（サムネイル）`}
      aria-pressed={queuePosition > 0}
      onClick={onToggle}
    >
      <img
        src={video.thumbnailUrl || thumbnail(video.id)}
        alt=""
        loading="lazy"
        onError={(event) => {
          event.currentTarget.style.visibility = "hidden";
        }}
      />
      <span className="duration">{formatDuration(video.durationSeconds)}</span>
      {queuePosition > 0 && (
        <span className="added-mark">{queuePosition}番目</span>
      )}
    </button>
  );
}

// 試作ではブラウザ内に保存する。本番のD1同期とは保存処理を分離している。
function readInitialState(key: string) {
  try {
    return { state: restoreState(localStorage.getItem(key)), error: "" };
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
  const catalog = useCatalog();
  return <CatalogApp key={catalog.sourceKey} catalog={catalog} />;
}

// 取得できた一覧を使いながら、飛ばした対象と次の操作を確認できるようにする。
function SyncWarnings({ catalog }: { catalog: CatalogController }) {
  return (
    <div className="notice sync-warning" role="status">
      <p>
        取得できないチャンネルが{catalog.issues.length}
        件あります。残りの取得は続行し、取得できた動画を表示します。更新の基準日時は進めません。
      </p>
      <details>
        <summary>チャンネル名と取得できなかった理由</summary>
        <ul>
          {catalog.issues.map((issue) => (
            <li key={issue.channelId}>
              <strong>{issue.title}</strong>
              <br />
              {issue.message}
            </li>
          ))}
        </ul>
      </details>
      <button
        className="text-button"
        disabled={catalog.loading || catalog.checking}
        onClick={() => void catalog.refresh()}
      >
        更新を再試行
      </button>
    </div>
  );
}

// サンプルと実アカウントで保存先を分け、キューや非表示状態を混在させない。
function CatalogApp({ catalog }: { catalog: CatalogController }) {
  const stateKey =
    catalog.sourceKey === "prototype"
      ? storageKey
      : `youtubekit.${catalog.sourceKey}.v1`;
  const [initial] = useState(() => readInitialState(stateKey));
  const [saved, setSaved] = useState(initial.state);
  const [storageError, setStorageError] = useState(initial.error);
  const videos = catalog.videos;
  const loading = catalog.loading || catalog.checking;
  const loadError = catalog.error;
  const updatedAt = catalog.lastSyncedAt
    ? new Date(catalog.lastSyncedAt * 1000).toLocaleString("ja-JP")
    : "";
  const [panel, setPanel] = useState<Panel>(null);
  const [menuVideo, setMenuVideo] = useState<Video | null>(null);
  const [channelId, setChannelId] = useState("all");
  const [showHidden, setShowHidden] = useState(false);
  const [limit, setLimit] = useState(saved.settings.initialCount);
  const [toast, setToast] = useState("");
  const [session, setSession] = useState<Video[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragOrigin = useRef<number | null>(null);
  const dragTarget = useRef<number | null>(null);
  const settings = saved.settings;
  const knownVideos = useRef(new Map<string, Video>());
  for (const video of videos) knownVideos.current.set(video.id, video);
  const queueVideos = saved.queue.map((id) => knownVideos.current.get(id));
  const queueSeconds = queueVideos.reduce(
    (sum, video) => sum + (video?.durationSeconds ?? 0),
    0,
  );
  const canPlay =
    saved.queue.length > 0 && queueVideos.every((video) => video !== undefined);
  const channels = catalog.channels;
  const visible = videos.filter(
    (video) =>
      (channelId === "all" || video.channelId === channelId) &&
      (showHidden || !saved.hidden.includes(video.id)) &&
      !isExcludedByDuration(video.durationSeconds, settings),
  );
  const currentChannel =
    channels.find((channel) => channel.id === channelId)?.title ??
    "すべてのチャンネル";

  const refresh = () => catalog.refresh();
  useEffect(() => {
    if (catalog.sourceKey === "locked") return;
    try {
      localStorage.setItem(stateKey, JSON.stringify(saved));
      setStorageError("");
    } catch {
      setStorageError(
        "変更を保存できませんでした。この画面を閉じる前に保存領域を確認してください。",
      );
    }
  }, [saved, stateKey, catalog.sourceKey]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    setLimit(settings.initialCount);
  }, [channelId, showHidden, settings]);

  function toggleQueue(video: Video) {
    setSaved((state) => ({
      ...state,
      queue: toggleQueueItem(state.queue, video.id),
    }));
    setToast(
      saved.queue.includes(video.id)
        ? "キューから削除しました"
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
              aria-label="動画一覧を更新"
              title={
                catalog.isDemo
                  ? "サンプル一覧を再読み込み"
                  : "登録チャンネルと新着動画を更新"
              }
              disabled={
                loading ||
                !!session ||
                (!catalog.isDemo && !catalog.auth?.authenticated)
              }
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
            <div className="demo-banner">
              <span className="status-dot" />
              <p>
                {catalog.checking
                  ? "接続状態を確認中"
                  : catalog.isDemo
                    ? "サンプルモード"
                    : catalog.auth?.authenticated
                      ? "登録チャンネル"
                      : "Googleアカウント未接続"}{" "}
                <span>
                  —{" "}
                  {catalog.isDemo
                    ? "Google接続の設定後に、実際の登録チャンネルを取得できます。"
                    : catalog.auth?.authenticated
                      ? "更新ボタンで前回の成功日時以降の動画を確認します。"
                      : "設定からGoogleアカウントへ接続してください。"}
                </span>
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
                    <h1>{currentChannel}</h1>
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
                        ? `最終同期 ${updatedAt}`
                        : ""}
                  </span>
                </div>
                {loadError && (
                  <p className="notice error" role="alert">
                    {loadError}{" "}
                    <button
                      className="text-button"
                      onClick={() =>
                        void (catalog.auth
                          ? refresh()
                          : catalog.checkConnection())
                      }
                    >
                      再試行
                    </button>
                  </p>
                )}
                {catalog.progress && (
                  <p className="sync-progress" role="status">
                    {catalog.progress}
                  </p>
                )}
                {catalog.issues.length > 0 && (
                  <SyncWarnings catalog={catalog} />
                )}
                {!catalog.isDemo &&
                  !catalog.auth?.authenticated &&
                  !catalog.checking && (
                    <div className="connection-prompt">
                      <p>
                        登録チャンネルの動画を見るにはGoogleアカウントへ接続してください。
                      </p>
                      {catalog.auth?.configured ? (
                        <a className="primary" href="/auth/login">
                          Googleアカウントに接続
                        </a>
                      ) : (
                        <button
                          className="secondary"
                          onClick={() => setPanel("settings")}
                        >
                          接続設定を確認
                        </button>
                      )}
                    </div>
                  )}
                <div
                  className="video-list"
                  style={
                    {
                      "--list-scale": settings.densityPercent / 100,
                    } as CSSProperties
                  }
                >
                  {visible.slice(0, limit).map((video) => {
                    const queuePosition = saved.queue.indexOf(video.id) + 1;
                    const added = queuePosition > 0;
                    const hidden = saved.hidden.includes(video.id);
                    return (
                      <article
                        className={`video-row ${hidden ? "is-hidden" : ""}`}
                        key={video.id}
                      >
                        <Thumbnail
                          video={video}
                          queuePosition={queuePosition}
                          onToggle={() => toggleQueue(video)}
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
                              {video.channelThumbnailUrl ? (
                                <img
                                  src={video.channelThumbnailUrl}
                                  alt=""
                                  loading="lazy"
                                />
                              ) : (
                                video.channel[0]
                              )}
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
                          aria-label={
                            added
                              ? `${video.title}をキューから削除（再生順${queuePosition}）`
                              : `${video.title}を追加`
                          }
                          aria-pressed={added}
                          onClick={() => toggleQueue(video)}
                        >
                          {added ? (
                            <span className="queue-position">
                              {queuePosition}
                            </span>
                          ) : (
                            <Icon name="plus" />
                          )}
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
            {catalog.isDemo && (
              <p className="sample-note">
                動画情報は試作用のサンプルです。日時・再生時間は概算を含み、最新情報とは異なる場合があります。
              </p>
            )}
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
          <p className="panel-note">
            {catalog.isDemo ? "サンプルチャンネル" : "登録チャンネル"}
          </p>
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
                  {channel.thumbnailUrl ? (
                    <img src={channel.thumbnailUrl} alt="" loading="lazy" />
                  ) : (
                    channel.title[0]
                  )}
                </span>
                {channel.title}
              </button>
            ))}
          </nav>
          <p className="panel-note">
            {catalog.isDemo
              ? "設定からGoogle接続を準備すると、登録チャンネルを自動取得できます。"
              : "更新ボタンで登録・解除の状態を再同期できます。"}
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
                  <img
                    className="queue-thumb"
                    src={video?.thumbnailUrl || thumbnail(id)}
                    alt=""
                  />
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
            <span className="tag">
              {catalog.auth?.authenticated
                ? "接続済み"
                : catalog.isDemo
                  ? "サンプルモード"
                  : "未接続"}
            </span>
            <h3>{catalog.auth?.account?.email ?? "Googleアカウント未接続"}</h3>
            <p>
              {catalog.auth?.authenticated
                ? "登録チャンネルと動画情報はサーバーに保存されます。キュー・非表示・設定は、この段階ではブラウザごとの保存です。"
                : catalog.backendOffline
                  ? "バックエンドが起動していません。READMEの手順でバックエンドを起動してください。"
                  : catalog.auth?.configured
                    ? "許可されたGoogleアカウントだけが利用できます。"
                    : "Google接続の設定が必要です。開発フォルダ内の docs/セットアップ.md を参照してください。"}
            </p>
            {!!catalog.auth?.missing.length && (
              <p className="panel-note">
                未設定: {catalog.auth.missing.join("、")}
              </p>
            )}
            <div className="connection-actions">
              {catalog.auth?.configured && (
                <a className="primary" href="/auth/login">
                  {catalog.auth.authenticated
                    ? "Googleへ再接続"
                    : "Googleアカウントに接続"}
                </a>
              )}
              {!catalog.auth?.authenticated && (
                <button
                  className="secondary"
                  disabled={loading}
                  onClick={() => void catalog.checkConnection()}
                >
                  接続状態を再確認
                </button>
              )}
              {catalog.auth?.authenticated && (
                <>
                  <button
                    className="secondary"
                    disabled={loading}
                    onClick={() => void catalog.refresh(true)}
                  >
                    登録チャンネルと過去分を再取得
                  </button>
                  <button
                    className="text-button"
                    disabled={loading}
                    onClick={() => void catalog.endConnection()}
                  >
                    ログアウト
                  </button>
                  <button
                    className="text-button danger"
                    disabled={loading}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Google接続を解除し、サーバーの動画・トークン・セッションを削除しますか？所有者固定用の識別子と、このブラウザのキューは保持されます。",
                        )
                      )
                        void catalog.endConnection(true);
                    }}
                  >
                    接続解除とサーバーデータ削除
                  </button>
                </>
              )}
            </div>
            {catalog.watermark && (
              <p className="panel-note">
                次回更新の基準:{" "}
                {new Date(catalog.watermark * 1000).toLocaleString("ja-JP")}
              </p>
            )}
            {catalog.progress && (
              <p className="panel-note" role="status">
                {catalog.progress}
              </p>
            )}
            {catalog.error && (
              <p className="notice error" role="alert">
                {catalog.error}
              </p>
            )}
            {catalog.issues.length > 0 && <SyncWarnings catalog={catalog} />}
          </div>
          <div className="settings-section">
            <h3>動画一覧</h3>
            <label className="setting-row">
              <span>表示密度</span>
              <select
                value={settings.densityPercent}
                onChange={(event) =>
                  updateSettings({
                    densityPercent: Number(event.target.value),
                  })
                }
              >
                {Array.from({ length: 20 }, (_, index) => (index + 1) * 10).map(
                  (percent) => (
                    <option key={percent} value={percent}>
                      {percent}%{percent === 100 ? "（標準）" : ""}
                    </option>
                  ),
                )}
              </select>
            </label>
            <p className="panel-note">
              100%が標準です。大きいほど画像・文字・行間を広げます。押しやすさと読みやすさのため最小サイズを設けています。
            </p>
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
              <span>除外する分数（以下）</span>
              <input
                type="number"
                min={1 / 60}
                max="60"
                step="any"
                disabled={!settings.excludeShort}
                value={settings.shortThreshold / 60}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value) && value >= 1 / 60 && value <= 60)
                    updateSettings({ shortThreshold: Math.round(value * 60) });
                }}
              />
            </label>
            <p className="panel-note">
              初期値は3分です。Shortsだけの正確な判別はできないため、通常の短い動画も除外されます。
            </p>
          </div>
          <div className="settings-section">
            <h3>この試作について</h3>
            <p className="panel-note">
              v{appVersion} ·
              Google認証・登録チャンネル同期に対応しました。キューの端末間同期・PWAのインストールとオフライン更新は次の段階です。
            </p>
            <p className="panel-note">
              プレーヤーにはYouTubeの利用規約とプライバシーポリシーが適用されます。
            </p>
            <div className="legal-links">
              <a href="/privacy.html" target="_blank" rel="noreferrer">
                このアプリのデータの取り扱い ↗
              </a>
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
                toggleQueue(menuVideo);
                setMenuVideo(null);
              }}
            >
              <Icon
                name={saved.queue.includes(menuVideo.id) ? "close" : "plus"}
              />
              {saved.queue.includes(menuVideo.id)
                ? "キューから削除"
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
