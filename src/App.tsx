import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { version as appVersion } from "../package.json";
import {
  addToQueue,
  catalogAutoRefreshIntervals,
  createSavedQueueId,
  getQueueStart,
  toggleQueueItem,
  createVideoFilter,
  durationOptions,
  getVideoFilters,
  watchedPercentOptions,
  formatDuration,
  formatPublishedAt,
  readWarningDismissal,
  moveItem,
  loadSavedQueue,
  newestSavedQueuesFirst,
  playbackSaveIntervals,
  restoreState,
  storageKey,
  type ChannelSort,
  type Settings,
  type Video,
} from "./model";
import { Icon } from "./Icon";
import { Player, type PlayerHandle } from "./Player";
import type { QueueEditStart } from "./playback";
import { TheaterControls } from "./TheaterControls";
import { addLatestChannelTimes, readLatestChannelTimes, readSavedVideos, useCatalog, type CatalogController } from "./useCatalog";
import { usePwa, type PwaController } from "./usePwa";
import { useCloud } from "./useCloud";
import { cloudIntervals } from "../shared/cloud";

type Panel =
  "channels" | "queue" | "savedQueues" | "savedQueuePreview" | "saveQueue" | "settings" | "hiddenVideos" | null;
const thumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const dateLabel = formatPublishedAt;
const channelNameOrder = new Intl.Collator("ja", { numeric: true });
const channelSortOptions: { key: ChannelSort; label: string }[] = [
  { key: "name", label: "名前" },
  { key: "latest", label: "最新の動画" },
  { key: "watched", label: "最近視聴した" },
];
const durationLabel = (seconds: number) => seconds < 3600 ? `${seconds / 60}分` : `${seconds / 3600}時間`;

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
      {queuePosition > 0 && (
        <span className="added-mark">{queuePosition}番目</span>
      )}
      <span className="duration">{formatDuration(video.durationSeconds)}</span>
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
  const pwa = usePwa();
  return <CatalogApp key={catalog.sourceKey} catalog={catalog} pwa={pwa} />;
}

// 取得できた一覧を使いながら、飛ばした対象と次の操作を確認できるようにする。
function SyncWarnings({
  catalog,
  onDismiss,
}: {
  catalog: CatalogController;
  onDismiss?: () => void;
}) {
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
      {onDismiss && (
        <button className="text-button" onClick={onDismiss}>
          一覧では非表示にする
        </button>
      )}
    </div>
  );
}

// サンプルと実アカウントで保存先を分け、キューや非表示状態を混在させない。
function CatalogApp({
  catalog,
  pwa,
}: {
  catalog: CatalogController;
  pwa: PwaController;
}) {
  const stateKey =
    catalog.sourceKey === "prototype"
      ? storageKey
      : `youtubekit.${catalog.sourceKey}.v1`;
  const [initial] = useState(() => readInitialState(stateKey));
  const [saved, setSaved] = useState(initial.state);
  const [storageError, setStorageError] = useState(initial.error);
  const warningKey = `${stateKey}.warning-dismissal`;
  const [dismissedRevision, setDismissedRevision] = useState(() => {
    try {
      return readWarningDismissal(localStorage.getItem(warningKey));
    } catch {
      return null;
    }
  });
  const videos = catalog.videos;
  const loading = catalog.loading || catalog.checking;
  const loadError = catalog.error;
  const updatedAt = catalog.lastSyncedAt
    ? new Date(catalog.lastSyncedAt * 1000).toLocaleString("ja-JP")
    : "";
  const [panel, setPanel] = useState<Panel>(null);
  const [saveQueueReturnPanel, setSaveQueueReturnPanel] = useState<
    "queue" | null
  >(null);
  const [savedQueuesReturnPanel, setSavedQueuesReturnPanel] = useState<"queue" | null>(null);
  const [previewQueueId, setPreviewQueueId] = useState<string | null>(null);
  const [previewVideos, setPreviewVideos] = useState<Video[]>([]);
  const previewQueue = saved.savedQueues.find((item) => item.id === previewQueueId);
  const [saveQueueVideoIds, setSaveQueueVideoIds] = useState<string[]>([]);
  const [saveQueueName, setSaveQueueName] = useState("");
  const [saveQueueDefaultName, setSaveQueueDefaultName] = useState("");
  const [menuVideo, setMenuVideo] = useState<Video | null>(null);
  const [channelId, setChannelId] = useState("all");
  const [channelTimes, setChannelTimes] = useState<ReadonlyMap<string, number>>(new Map());
  const [channelSortLoading, setChannelSortLoading] = useState(false);
  const [channelSortError, setChannelSortError] = useState("");
  const channelSortRequest = useRef<AbortController | null>(null);
  const [hiddenPage, setHiddenPage] = useState(0);
  const [hiddenDetails, setHiddenDetails] = useState<Video[]>([]);
  const [hiddenVideoToRestore, setHiddenVideoToRestore] = useState<string | null>(null);
  const [limit, setLimit] = useState(saved.settings.initialCount);
  const [toast, setToast] = useState("");
  const [session, setSession] = useState<{
    videos: Video[];
    single: boolean;
    editStart?: QueueEditStart;
  } | null>(null);
  // 一覧の操作メニューを開いた時点で、単独再生用の1本を準備する。
  const singleQueue = useMemo(() => menuVideo && panel === null ? [menuVideo] : null, [menuVideo, panel]);
  const [theater, setTheater] = useState(false);
  const [playbackComplete, setPlaybackComplete] = useState(false);
  const playerHandle = useRef<PlayerHandle>(null);
  const theaterButton = useRef<HTMLButtonElement>(null);
  const suppressTheaterClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragTargetIndex, setDragTargetIndex] = useState<number | null>(null);
  const dragOrigin = useRef<number | null>(null);
  const dragTarget = useRef<number | null>(null);
  const settings = saved.settings;
  const [foreground, setForeground] = useState<{ leftAt: number; openedAt: number } | null>(null);
  const autoRefreshHandled = useRef<typeof foreground>(null);
  const headerRefresh = useRef(false);
  const cloud = useCloud(stateKey, saved, setSaved, catalog.auth?.authenticated ? catalog.auth.csrfToken : undefined, !!session);
  const knownVideos = useRef(new Map<string, Video>());
  for (const video of catalog.queueVideos)
    knownVideos.current.set(video.id, video);
  for (const video of previewVideos) knownVideos.current.set(video.id, video);
  for (const video of hiddenDetails) knownVideos.current.set(video.id, video);
  for (const video of videos) knownVideos.current.set(video.id, video);
  const queueVideos = useMemo(
    () => saved.queue.map((id) => knownVideos.current.get(id)),
    [saved.queue, catalog.queueVideos, previewVideos, hiddenDetails, videos],
  );
  const playableQueue = useMemo(
    () => queueVideos.filter((video): video is Video => !!video),
    [queueVideos],
  );
  const queueSeconds = queueVideos.reduce(
    (sum, video) => sum + (video?.durationSeconds ?? 0),
    0,
  );
  const canPlay =
    saved.queue.length > 0 && playableQueue.length === saved.queue.length;
  const channels = catalog.channels;
  const orderedChannels = useMemo(() => [...channels].sort((a, b) =>
    (channelTimes.get(b.id) ?? 0) - (channelTimes.get(a.id) ?? 0) ||
    channelNameOrder.compare(a.title, b.title) || a.id.localeCompare(b.id),
  ), [channels, channelTimes]);
  const filters = useMemo(() => getVideoFilters(settings, saved.hidden), [settings, saved.hidden]);
  const filterPositions = filters.watchedMinPercent > 0 || filters.watchedMaxPercent < 100
    ? saved.playbackPositions
    : undefined;
  const visible = videos.filter(createVideoFilter(filters, filterPositions))
    .filter((video) => channelId === "all" || video.channelId === channelId);
  const sortedHidden = useMemo(() => [...saved.hidden].reverse().sort(
    (a, b) => (saved.hiddenAt[b] ?? 0) - (saved.hiddenAt[a] ?? 0),
  ), [saved.hidden, saved.hiddenAt]);
  const hiddenPageCount = 1 + Math.ceil(Math.max(0, sortedHidden.length - settings.initialCount) / settings.additionalCount);
  const currentHiddenPage = Math.min(hiddenPage, hiddenPageCount - 1);
  const hiddenPageIds = useMemo(() => {
    if (currentHiddenPage === 0) return sortedHidden.slice(0, settings.initialCount);
    const offset = settings.initialCount + (currentHiddenPage - 1) * settings.additionalCount;
    return sortedHidden.slice(offset, offset + settings.additionalCount);
  }, [currentHiddenPage, sortedHidden, settings.initialCount, settings.additionalCount]);
  const durationMin = settings.shortThreshold < 0 ? -1 : settings.shortThreshold + 1;
  const currentChannel =
    channels.find((channel) => channel.id === channelId)?.title ??
    "すべてのチャンネル";

  useEffect(() => {
    if (panel !== "channels") return;
    return () => channelSortRequest.current?.abort();
  }, [panel]);

  // 別ブラウザで保存されたキューは、プレビュー時にも不足する動画情報を補う。
  useEffect(() => {
    if (!previewQueue || !catalog.auth?.authenticated) return;
    const missingIds = previewQueue.videoIds.filter((id) => !knownVideos.current.has(id));
    if (!missingIds.length) return;
    const controller = new AbortController();
    void readSavedVideos(missingIds, controller.signal).then((details) => {
      if (!controller.signal.aborted) setPreviewVideos(details);
    }).catch(() => {
      // 取得できない場合も、IDを表示して保存時の並びを確認できる。
    });
    return () => controller.abort();
  }, [previewQueue, catalog.auth?.authenticated]);

  // 非表示リストは表示するページの詳細だけを取得する。
  useEffect(() => {
    if (panel !== "hiddenVideos" || !catalog.auth?.authenticated) return;
    const missingIds = hiddenPageIds.filter((id) => !knownVideos.current.has(id));
    if (!missingIds.length) return;
    const controller = new AbortController();
    void readSavedVideos(missingIds, controller.signal).then((details) => {
      if (!controller.signal.aborted) setHiddenDetails(details);
    }).catch(() => {
      // メタデータが無い場合もIDで非表示を解除できる。
    });
    return () => controller.abort();
  }, [panel, hiddenPageIds, catalog.auth?.authenticated]);

  const refresh = () => catalog.refresh();

  function refreshWithAppCheck() {
    void pwa.checkUpdate();
    if (headerRefresh.current || catalog.refreshQueued) return;
    headerRefresh.current = true;
    void refresh().finally(() => { headerRefresh.current = false; });
  }

  // 画面を離れた時刻を保存し、起動・復帰の重複イベントをまとめる。
  useEffect(() => {
    if (catalog.sourceKey === "locked") return;
    const activityKey = `${stateKey}.catalog-left-at`;
    let leftAt = 0;
    let visible = false;
    try {
      leftAt = Number(localStorage.getItem(activityKey)) || 0;
    } catch {
      // 保存不可でも、同じページ内の前面復帰は判定できる。
    }
    const enter = () => {
      if (visible || document.hidden) return;
      visible = true;
      setForeground({ leftAt, openedAt: Date.now() });
    };
    const leave = () => {
      if (!visible) return;
      visible = false;
      leftAt = Date.now();
      setForeground(null);
      try {
        localStorage.setItem(activityKey, String(leftAt));
      } catch {
        // 画面を離れた時刻はメモリ上にも保持する。
      }
    };
    const visibilityChanged = () => {
      if (document.hidden) leave();
      else enter();
    };
    enter();
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", enter);
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", enter);
    };
  }, [stateKey, catalog.sourceKey]);

  // 通信や再生が終わるまで、今回の復帰で発生した更新要求を保持する。
  useEffect(() => {
    const minutes = settings.catalogAutoRefreshMinutes;
    if (!minutes || !foreground || autoRefreshHandled.current === foreground ||
        !pwa.online || loading || session ||
        (!catalog.isDemo && !catalog.auth?.connected)) return;
    const lastActivity = Math.max(foreground.leftAt, (catalog.lastSyncedAt ?? 0) * 1000);
    if (!lastActivity || foreground.openedAt - lastActivity < minutes * 60_000) return;
    autoRefreshHandled.current = foreground;
    refreshWithAppCheck();
  }, [foreground, loading, session, settings.catalogAutoRefreshMinutes, pwa.online,
    catalog.isDemo, catalog.auth?.connected, catalog.lastSyncedAt, refreshWithAppCheck]);
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
  }, [channelId, settings]);
  useEffect(() => {
    if (catalog.sourceKey === "locked" || session) return;
    catalog.selectView({
      channelId,
      count: limit,
      ...filters,
      playbackPositions: filterPositions,
    });
  }, [
    channelId,
    limit,
    filters,
    filterPositions,
    session,
    catalog.sourceKey,
  ]);

  function dismissWarnings() {
    try {
      localStorage.setItem(
        warningKey,
        JSON.stringify({ revision: catalog.warningRevision }),
      );
      setDismissedRevision(catalog.warningRevision);
    } catch {
      setStorageError(
        "通知の非表示設定を保存できませんでした。ブラウザの保存領域を確認してください。",
      );
    }
  }

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

  function addQueueVideo(id: string) {
    setSaved((state) => ({ ...state, queue: addToQueue(state.queue, id) }));
    setMenuVideo(null);
    setToast("キューに追加しました");
  }

  function moveQueueVideoToFront(id: string) {
    setSaved((state) => {
      const index = state.queue.indexOf(id);
      if (index === 0) return state;
      return {
        ...state,
        queue: index < 0 ? [id, ...state.queue] : moveItem(state.queue, index, 0),
      };
    });
    setMenuVideo(null);
    setToast("キューの先頭に置きました");
  }

  function removeQueueVideo(id: string) {
    setSaved((state) => ({
      ...state,
      queue: state.queue.filter((item) => item !== id),
    }));
    setMenuVideo(null);
    setToast("キューから削除しました");
  }

  function recordChannelWatch(video: Video) {
    const watchedAt = Date.now();
    setSaved((state) => ({
      ...state,
      watchedChannelAt: { ...state.watchedChannelAt, [video.channelId]: watchedAt },
    }));
  }

  // 視聴済みの目印を付けても、キューを再開する動画は変えない。
  function markVideoWatched(video: Video) {
    if (video.durationSeconds <= 0) return;
    const position = Math.max(0, Math.floor(video.durationSeconds) - 1);
    const watchedAt = Date.now();
    setSaved((state) => ({
      ...state,
      playbackPositions: { ...state.playbackPositions, [video.id]: position },
      watchedChannelAt: { ...state.watchedChannelAt, [video.channelId]: watchedAt },
    }));
    setMenuVideo(null);
    setToast("視聴済みとしてマークしました");
  }

  function clearQueue() {
    if (!saved.queue.length) return;
    if (!window.confirm("再生キューをすべて削除しますか？")) return;
    setSaved((state) => ({
      ...state,
      queue: [],
    }));
    setToast("再生キューをすべて削除しました");
  }

  function setVideoHidden(id: string, hidden: boolean) {
    const changedAt = Date.now();
    setSaved((state) => {
      if (state.hidden.includes(id) === hidden) return state;
      const hiddenAt = { ...state.hiddenAt };
      if (hidden) hiddenAt[id] = changedAt;
      else delete hiddenAt[id];
      return {
        ...state,
        hidden: hidden ? [...state.hidden, id] : state.hidden.filter((item) => item !== id),
        hiddenAt,
      };
    });
    setMenuVideo(null);
    setHiddenVideoToRestore(null);
    setHiddenPage(currentHiddenPage);
    setToast(hidden ? "動画を非表示にしました" : "動画を再表示しました");
  }

  function updateSettings(value: Partial<Settings>) {
    setSaved((state) => ({
      ...state,
      settings: { ...state.settings, ...value },
    }));
  }

  // 開いた時点の絞り込みと履歴で順位を決め、モードを切り替えたときに再計算する。
  function sortChannels(mode: ChannelSort) {
    channelSortRequest.current?.abort();
    setChannelSortLoading(false);
    setChannelSortError("");
    if (mode === "watched") {
      setChannelTimes(new Map(Object.entries(saved.watchedChannelAt)));
      return;
    }
    const times = new Map<string, number>();
    setChannelTimes(times);
    if (mode === "name") return;
    if (catalog.isDemo) {
      addLatestChannelTimes(times, videos, createVideoFilter(filters, filterPositions));
      return;
    }
    if (!catalog.auth?.authenticated) return;
    const controller = new AbortController();
    channelSortRequest.current = controller;
    setChannelSortLoading(true);
    void readLatestChannelTimes(filters, filterPositions, channels.length, controller.signal).then((latestTimes) => {
      if (!controller.signal.aborted) setChannelTimes(latestTimes);
    }).catch(() => {
      if (!controller.signal.aborted)
        setChannelSortError("最新の動画を確認できませんでした。再試行してください。");
    }).finally(() => {
      if (!controller.signal.aborted) setChannelSortLoading(false);
    });
  }

  function reorder(from: number, to: number) {
    setSaved((state) => ({ ...state, queue: moveItem(state.queue, from, to) }));
  }

  // 保存元のキューを固定し、名前入力中の並び変更や再生終了の影響を受けないようにする。
  function openSaveQueue(videoIds: string[], returnPanel: "queue" | null) {
    if (!videoIds.length) return;
    setSaveQueueVideoIds([...videoIds]);
    setSaveQueueName("");
    setSaveQueueDefaultName(formatPublishedAt(new Date().toISOString()));
    setSaveQueueReturnPanel(returnPanel);
    setPanel("saveQueue");
  }

  function closeSaveQueue() {
    setPanel(saveQueueReturnPanel);
  }

  function saveNamedQueue() {
    if (!saveQueueVideoIds.length) return;
    const name = saveQueueName.trim() || saveQueueDefaultName;
    setSaved((state) => ({
      ...state,
      savedQueues: [
        ...state.savedQueues,
        {
          id: createSavedQueueId(),
          name,
          videoIds: [...saveQueueVideoIds],
        },
      ],
    }));
    setToast(`「${name}」を保存しました`);
    setPanel(saveQueueReturnPanel);
  }

  function closeSavedQueuePreview() {
    setPreviewQueueId(null);
    setPanel("savedQueues");
  }

  function applySavedQueue(replace: boolean) {
    const selected = previewQueue;
    if (!selected) {
      setPanel("savedQueues");
      return;
    }
    const addedCount = selected.videoIds.filter((id) => !saved.queue.includes(id)).length;
    setSaved((state) => {
      const current = state.savedQueues.find((item) => item.id === selected.id);
      if (!current) return state;
      return loadSavedQueue(state, current, replace);
    });
    setPanel(savedQueuesReturnPanel);
    setToast(replace
      ? `「${selected.name}」に置き換えました`
      : addedCount
        ? `「${selected.name}」から${addedCount}本追加しました`
        : "保存キューの動画はすべて追加済みです");
  }

  function deleteSavedQueue(id: string) {
    const selected = saved.savedQueues.find((item) => item.id === id);
    if (!selected) return;
    if (!window.confirm(`保存したキュー「${selected.name}」を削除しますか？`))
      return;
    setSaved((state) => ({
      ...state,
      savedQueues: state.savedQueues.filter((item) => item.id !== id),
    }));
    setToast(`「${selected.name}」を削除しました`);
  }

  function startPlayback(from: "resume" | "beginning" | { videoId: string } = "resume") {
    if (!canPlay) return;
    const start = from === "beginning"
      ? { index: 0, positionSeconds: 0 }
      : getQueueStart(
          saved.queue,
          from === "resume" ? saved.resumeVideoId : from.videoId,
          saved.playbackPositions,
        );
    beginPlayback(playableQueue, start, false);
  }

  function startSinglePlayback() {
    if (!singleQueue) return;
    const positionSeconds = saved.playbackPositions[singleQueue[0].id] ?? 0;
    beginPlayback(singleQueue, { index: 0, positionSeconds }, true);
  }

  // 準備済みプレーヤーを同じタップ処理内で表示し、iPhoneの再生許可を維持する。
  function beginPlayback(videos: Video[], start: { index: number; positionSeconds: number }, single: boolean) {
    flushSync(() => {
      setPanel(null);
      setMenuVideo(null);
      setSession({ videos, single });
    });
    playerHandle.current?.startAt(start.index, start.positionSeconds);
    window.scrollTo({ top: 0 });
  }

  function endPlayback() {
    playerHandle.current?.endSession();
    setTheater(false);
    setSession(null);
  }

  // ロゴから一覧の初期位置へ戻し、保存キューや表示設定は維持する。
  function returnToCatalogHome() {
    if (session) playerHandle.current?.endSession();
    setTheater(false);
    setPanel(null);
    setMenuVideo(null);
    setSession(null);
    setChannelId("all");
    setLimit(settings.initialCount);
    window.scrollTo({ top: 0 });
  }

  function queueSaveActions(returnPanel: "queue" | null) {
    return (
      <div className="queue-save-actions">
        <button
          className="saved-queue-link"
          onClick={() => {
            setSavedQueuesReturnPanel(returnPanel);
            setPanel("savedQueues");
          }}
        >
          保存したキューを選択
        </button>
        <button
          className="saved-queue-link"
          disabled={!saved.queue.length}
          onClick={() => openSaveQueue(saved.queue, returnPanel)}
        >
          このキューを保存
        </button>
      </div>
    );
  }

  return (
    <div
      className={`app-shell ${theater ? "theater-mode" : ""}`}
      style={
        {
          "--theater-brightness": `${settings.theaterBrightness}%`,
        } as CSSProperties
      }
    >
      <header className="header" inert={theater}>
        <div className="header-inner">
          <button
            className="icon-button"
            aria-label="チャンネル一覧"
            onClick={() => {
              setPanel("channels");
              sortChannels(settings.channelSort);
            }}
            disabled={!!session}
          >
            <Icon name="menu" />
          </button>
          <a
            className="brand"
            href="/"
            aria-label="すべてのチャンネルへ戻る"
            onClick={(event) => {
              event.preventDefault();
              returnToCatalogHome();
            }}
          >
            <img src="/icon.svg" alt="" />
            <span>
              Youtube<span className="brand-light">Kit</span>
            </span>
          </a>
          <span className="prototype-badge" hidden>
            PROTOTYPE
          </span>
          <div className="header-actions">
            <button
              className={`icon-button ${loading ? "spinning" : ""}`}
              aria-label="動画一覧を更新・アプリの新版を確認"
              title={
                catalog.refreshQueued
                  ? "現在の処理後に新着更新を行います"
                  : catalog.isDemo
                    ? "サンプル一覧を再読み込み"
                    : "登録チャンネルと新着動画を更新・アプリの新版を確認"
              }
              aria-busy={loading}
              onClick={() => {
                if (!catalog.auth?.authenticated && !catalog.isDemo) {
                  void pwa.checkUpdate();
                  if (!catalog.checking) setPanel("settings");
                  return;
                }
                if (loading && !headerRefresh.current && !catalog.refreshQueued)
                  setToast("処理後の新着更新を受け付けました");
                refreshWithAppCheck();
              }}
            >
              <Icon name="refresh" />
            </button>
            {!session && (
              <>
                <button
                  className={`icon-button filter-toggle ${settings.excludeShort ? "active" : ""}`}
                  aria-label="動画時間で絞り込む"
                  title="動画時間で絞り込む"
                  aria-pressed={settings.excludeShort}
                  onClick={() => updateSettings({ excludeShort: !settings.excludeShort })}
                >
                  <Icon name="clock" />
                </button>
                <button
                  className={`icon-button filter-toggle ${settings.excludeByWatchedRange ? "active" : ""}`}
                  aria-label="再生位置で絞り込む"
                  title="再生位置で絞り込む"
                  aria-pressed={settings.excludeByWatchedRange}
                  onClick={() => updateSettings({ excludeByWatchedRange: !settings.excludeByWatchedRange })}
                >
                  <Icon name="percent" />
                </button>
                <button
                  className={`icon-button filter-toggle ${settings.excludeHiddenVideos ? "active" : ""}`}
                  aria-label="非表示動画を除外する"
                  title="非表示動画を除外する"
                  aria-pressed={settings.excludeHiddenVideos}
                  onClick={() => updateSettings({ excludeHiddenVideos: !settings.excludeHiddenVideos })}
                >
                  <Icon name={settings.excludeHiddenVideos ? "eye-off" : "eye"} />
                </button>
              </>
            )}
            <button
              className="icon-button"
              aria-label="設定"
              onClick={() => setPanel("settings")}
            >
              <Icon name="settings" />
            </button>
            {session && (
              <button
                className="icon-button"
                ref={theaterButton}
                aria-label="シアターモード"
                title="シアターモード"
                onPointerDown={() => { suppressTheaterClick.current = false; }}
                onClick={() => {
                  // 解除直後に届くクリックで再突入しない。
                  if (suppressTheaterClick.current) {
                    suppressTheaterClick.current = false;
                    return;
                  }
                  setTheater(true);
                }}
              >
                <Icon name="theater" />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className={`main ${session ? "playing-main" : ""}`} inert={theater}>
        {!pwa.online && (
          <p className="notice sync-warning" role="status">
            通信できません。動画の取得・再生にはインターネット接続が必要です。保存したキューと設定はこの端末に残っています。
          </p>
        )}
        {pwa.message && <p className="notice error" role="alert">{pwa.message}</p>}
        {pwa.updateReady && (
          <div className="notice app-update" role="status">
            <p>
              {session
                ? "アプリの新版があります。再生を終了すると更新できます。"
                : "アプリの新版があります。キューと設定を引き継いで更新します。"}
            </p>
            <button
              className="secondary"
              disabled={!!session || loading || !pwa.online}
              onClick={() => pwa.applyUpdate(!!session || loading)}
            >
              アプリを更新
            </button>
          </div>
        )}
        {storageError && (
          <p className="notice error" role="alert">
            {storageError}
          </p>
        )}
        {(session || singleQueue || canPlay) && (
          <Player
            ref={playerHandle}
            active={!!session}
            videos={session?.videos ?? singleQueue ?? playableQueue}
            queueEditStart={session?.editStart}
            onQueueEdit={session && !session.single ? (videos, editStart) => {
              setSession({ videos, editStart, single: false });
            } : undefined}
            playbackPositions={saved.playbackPositions}
            saveIntervalSeconds={settings.playbackSaveIntervalSeconds}
            resumePlaybackPosition={settings.resumePlaybackPosition}
            restartNearEndSeconds={settings.restartNearEndSeconds}
            onClose={endPlayback}
            onCompleteChange={setPlaybackComplete}
            onVideoPlaying={recordChannelWatch}
            onPlaybackProgress={(videoId, positionSeconds) => {
              if (!session) return;
              setSaved((state) => {
                // 単独再生の位置は動画履歴に記録し、キューの再開先は保持する。
                const resumeVideoId = session.single ? state.resumeVideoId : videoId;
                const previousPosition = state.playbackPositions[videoId] ?? 0;
                const changedPosition = positionSeconds > 0 && previousPosition !== positionSeconds;
                if (!changedPosition && resumeVideoId === state.resumeVideoId)
                  return state;
                const playbackPositions = changedPosition
                  ? { ...state.playbackPositions, [videoId]: positionSeconds }
                  : state.playbackPositions;
                return { ...state, resumeVideoId, playbackPositions };
              });
            }}
            onSaveQueue={() =>
              openSaveQueue(
                (session?.videos ?? playableQueue).map((video) => video.id),
                null,
              )
            }
          />
        )}
        {!session && (
          <>
            <div className="demo-banner" hidden>
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
                    {queueSaveActions(null)}
                    <p className="eyebrow" hidden>VIDEO LIBRARY</p>
                    <h1>{currentChannel}</h1>
                  </div>
                </div>
                <div className="list-meta">
                  <span>
                    {settings.excludeHiddenVideos ? "公開日の新しい順" : "非表示の動画も表示中"}
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
                {catalog.issues.length > 0 &&
                  dismissedRevision !== catalog.warningRevision && (
                    <SyncWarnings
                      catalog={catalog}
                      onDismiss={dismissWarnings}
                    />
                  )}
                {catalog.refreshQueued && (
                  <p className="sync-progress" role="status">
                    処理後に新着更新を行います。
                  </p>
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
                    const position = saved.playbackPositions[video.id] ?? 0;
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
                            {position > 0 && (
                              <span> · 再生位置 {formatDuration(position)}</span>
                            )}
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
                      チャンネルや動画の絞り込み設定を変更してみてください。
                    </p>
                  </div>
                )}
                {visible.length > limit || catalog.hasMore ? (
                  <button
                    className="load-more secondary"
                    disabled={loading}
                    onClick={() =>
                      setLimit((value) => value + settings.additionalCount)
                    }
                  >
                    さらに表示
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
              <aside
                className="queue-aside"
                role="button"
                tabIndex={0}
                aria-label={`再生キューの詳細を開く（${saved.queue.length}本、合計${formatDuration(queueSeconds, true)}）`}
                onClick={() => setPanel("queue")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setPanel("queue");
                  }
                }}
              >
                <div className="aside-heading">
                  <Icon name="list" />
                  <h2>再生キュー</h2>
                  <small className="queue-total">
                    合計 {formatDuration(queueSeconds, true)}
                  </small>
                  <span>{saved.queue.length}</span>
                </div>
                {saved.queue.length ? (
                  <>
                    <ol className="queue-preview">
                      {queueVideos.slice(0, 30).map((video, index) => (
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
                    {saved.queue.length > 30 && (
                      <p className="muted">ほか {saved.queue.length - 30} 本</p>
                    )}
                    <button
                      className="secondary full-width"
                      hidden
                      onClick={() => setPanel("queue")}
                    >
                      キューを確認する
                    </button>
                  </>
                ) : (
                  <div className="aside-empty" hidden>
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
                <div className="aside-note" hidden>
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
        <footer className="queue-bar" inert={theater}>
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
              className="secondary queue-clear"
              aria-label="再生キューを全削除"
              title="再生キューを全削除"
              disabled={!saved.queue.length}
              onClick={clearQueue}
            >
              <Icon name="trash" size={18} />
              <span>全削除</span>
            </button>
            <button
              className="primary play-button"
              disabled={!canPlay}
              onClick={() => startPlayback()}
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
          <div className="channel-sort-options" role="group" aria-label="チャンネルの並べ替え">
            {channelSortOptions.map(({ key, label }) => (
              <button key={key} className="secondary" aria-pressed={settings.channelSort === key}
                onClick={() => {
                  updateSettings({ channelSort: key });
                  sortChannels(key);
                }}>
                {label}
              </button>
            ))}
          </div>
          {channelSortLoading && <p className="panel-note" role="status">最新の動画を確認中…</p>}
          {channelSortError && <p className="panel-note" role="alert">{channelSortError}</p>}
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
            {orderedChannels.map((channel) => (
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
          {queueSaveActions("queue")}
          <div className="queue-heading">
            <p>
              {saved.queue.length} 本 <span>·</span> 合計{" "}
              {formatDuration(queueSeconds, true)}
            </p>
            <button
              className="text-button danger"
              disabled={!saved.queue.length}
              onClick={clearQueue}
            >
              全削除
            </button>
          </div>
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
              const dropPosition =
                dragging && dragTargetIndex === index
                  ? index <= (dragOrigin.current ?? index)
                    ? "drop-before"
                    : "drop-after"
                  : "";
              const rowDetails = (
                <>
                  <span className="queue-thumb-wrap">
                    <img className="queue-thumb" src={video?.thumbnailUrl || thumbnail(id)} alt="" />
                    {video && <span className="duration">{formatDuration(video.durationSeconds)}</span>}
                  </span>
                  <span className="queue-item-info">
                    <strong>{index + 1}. {video?.title ?? `取得できない動画 (${id})`}</strong>
                    <small>
                      {video
                        ? `${video.channel} · 再生位置 ${formatDuration(saved.playbackPositions[id] ?? 0)}`
                        : "保存状態を残しています。必要に応じて削除してください。"}
                    </small>
                  </span>
                </>
              );
              return (
                <li
                  key={id}
                  data-queue-index={index}
                  className={
                    `${dragging === id ? "dragging" : ""} ${dropPosition}`.trim()
                  }
                >
                  <button
                    className="drag-handle icon-button"
                    aria-label={`${video?.title ?? id}をドラッグして移動`}
                    onPointerDown={(event) => {
                      dragOrigin.current = index;
                      dragTarget.current = index;
                      setDragging(id);
                      setDragTargetIndex(index);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (dragOrigin.current === null) return;
                      const row = document
                        .elementFromPoint(event.clientX, event.clientY)
                        ?.closest<HTMLElement>("[data-queue-index]");
                      if (row) {
                        const target = Number(row.dataset.queueIndex);
                        dragTarget.current = target;
                        setDragTargetIndex(target);
                      }
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
                      setDragTargetIndex(null);
                    }}
                    onPointerCancel={() => {
                      dragOrigin.current = null;
                      dragTarget.current = null;
                      setDragging(null);
                      setDragTargetIndex(null);
                    }}
                  >
                    <Icon name="grip" size={18} />
                  </button>
                  {video ? (
                    <button
                      className="queue-item-details"
                      aria-label={`${video.title}の操作`}
                      onClick={() => setMenuVideo(video)}
                    >
                      {rowDetails}
                    </button>
                  ) : (
                    <div className="queue-item-details">{rowDetails}</div>
                  )}
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
                  {!video && (
                    <button
                      className="icon-button remove-button"
                      aria-label={`${id}をキューから削除`}
                      onClick={() => removeQueueVideo(id)}
                    >
                      <Icon name="close" size={17} />
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="modal-footer queue-play-actions">
            <button className="secondary" disabled={!canPlay} onClick={() => startPlayback("beginning")}>
              最初から再生
            </button>
            <button
              className="primary"
              disabled={!canPlay}
              onClick={() => startPlayback()}
            >
              <Icon name="play" size={16} />
              このキューを再生
            </button>
          </div>
        </Modal>
      )}

      {panel === "savedQueues" && (
        <Modal title="保存したキュー" onClose={() => setPanel(savedQueuesReturnPanel)}>
          {!saved.savedQueues.length && (
            <div className="empty-state">
              <Icon name="list" size={32} />
              <h3>保存したキューはまだありません</h3>
              <p>再生キューを作り、「このキューを保存」から保存できます。</p>
            </div>
          )}
          <ul className="saved-queue-list">
            {newestSavedQueuesFirst(saved.savedQueues).map((item) => (
              <li key={item.id}>
                <button
                  className="saved-queue-select"
                  onClick={() => {
                    setPreviewQueueId(item.id);
                    setPanel("savedQueuePreview");
                  }}
                >
                  <span>{item.name}</span>
                </button>
                <button
                  className="icon-button"
                  aria-label={`保存したキュー「${item.name}」を削除`}
                  onClick={() => deleteSavedQueue(item.id)}
                >
                  <Icon name="trash" size={18} />
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {panel === "savedQueuePreview" && (
        <Modal title={previewQueue?.name ?? "保存したキュー"} onClose={closeSavedQueuePreview}>
          {previewQueue ? (
            <>
              <ol className="saved-queue-preview saved-queue-list" tabIndex={0} aria-label="保存した動画">
                {previewQueue.videoIds.map((id, index) => {
                  const video = knownVideos.current.get(id);
                  return (
                    <li key={id}>
                      <img className="queue-thumb" src={video?.thumbnailUrl || thumbnail(id)} alt="" loading="lazy" />
                      <div className="queue-item-info">
                        <strong>{index + 1}. {video?.title ?? id}</strong>
                        {video && <small>{video.channel}</small>}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="modal-footer saved-queue-preview-actions">
                <button className="primary" onClick={() => applySavedQueue(false)}>キューに追加</button>
                <button className="secondary" onClick={() => applySavedQueue(true)}>今のキューを置き換え</button>
                <button className="text-button" onClick={closeSavedQueuePreview}>キャンセル</button>
              </div>
            </>
          ) : (
            <p className="panel-note">この保存キューは利用できません。保存一覧へ戻ってください。</p>
          )}
        </Modal>
      )}

      {panel === "hiddenVideos" && (
        <Modal title="非表示にした動画" onClose={() => setPanel("settings")}>
          {hiddenPageIds.length === 0 && <p className="panel-note">非表示にした動画はありません。</p>}
          <ul className="saved-queue-preview saved-queue-list" aria-label="非表示にした動画">
            {hiddenPageIds.map((id) => {
              const video = knownVideos.current.get(id);
              return (
                <li key={id}>
                  <button className="queue-item-details" onClick={() => setHiddenVideoToRestore(id)}>
                    <img className="queue-thumb" src={video?.thumbnailUrl || thumbnail(id)} alt="" loading="lazy" />
                    <span className="queue-item-info">
                      <strong>{video?.title ?? id}</strong>
                      {video && <small>{video.channel}</small>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {hiddenPageCount > 1 && (
            <div className="hidden-page-controls">
              <button className="secondary" disabled={currentHiddenPage === 0} onClick={() => setHiddenPage(currentHiddenPage - 1)}>前へ</button>
              <span>{currentHiddenPage + 1} / {hiddenPageCount}</span>
              <button className="secondary" disabled={currentHiddenPage + 1 >= hiddenPageCount} onClick={() => setHiddenPage(currentHiddenPage + 1)}>次へ</button>
            </div>
          )}
        </Modal>
      )}
      {panel === "hiddenVideos" && hiddenVideoToRestore && (
        <Modal title={knownVideos.current.get(hiddenVideoToRestore)?.title ?? hiddenVideoToRestore} onClose={() => setHiddenVideoToRestore(null)}>
          <div className="action-menu">
            <button onClick={() => setVideoHidden(hiddenVideoToRestore, false)}>非表示を解除する</button>
            <button onClick={() => setHiddenVideoToRestore(null)}>閉じる</button>
          </div>
        </Modal>
      )}

      {panel === "saveQueue" && (
        <Modal title="このキューを保存" onClose={closeSaveQueue}>
          <form
            className="save-queue-form"
            onSubmit={(event) => {
              event.preventDefault();
              saveNamedQueue();
            }}
          >
            <label htmlFor="saved-queue-name">名前</label>
            <input
              id="saved-queue-name"
              autoFocus
              value={saveQueueName}
              placeholder={saveQueueDefaultName}
              onChange={(event) => setSaveQueueName(event.target.value)}
            />
            <p className="panel-note">
              空白のまま保存すると「{saveQueueDefaultName}」になります。
            </p>
            <button className="primary full-width" type="submit">
              保存
            </button>
          </form>
        </Modal>
      )}

      {panel === "settings" && (
        <Modal title="設定" onClose={() => setPanel(null)}>
          {catalog.auth?.authenticated && (
            <div className="settings-section">
              <h3>クラウド保存と同期</h3>
              <p role="status">{cloud.status}</p>
              <label className="setting-row"><span>自動同期</span><input type="checkbox" checked={cloud.options.enabled} onChange={(event) => cloud.updateOptions({ enabled: event.target.checked })} /></label>
              <label className="setting-row"><span>再生位置の定期送信</span>
                <select value={cloud.options.positionSeconds} onChange={(event) => cloud.updateOptions({ positionSeconds: Number(event.target.value) })}>
                  {cloudIntervals.map((seconds) => <option key={seconds} value={seconds}>{seconds === 0 ? "オフ（手動同期で送信）" : `${seconds}秒`}</option>)}
                </select>
              </label>
              <label className="setting-row"><span>他ブラウザの変更を定期確認</span>
                <select value={cloud.options.pollSeconds} onChange={(event) => cloud.updateOptions({ pollSeconds: Number(event.target.value) })}>
                  {cloudIntervals.map((seconds) => <option key={seconds} value={seconds}>{seconds === 0 ? "オフ" : `${seconds}秒`}</option>)}
                </select>
              </label>
              <p className="panel-note">同期設定はこのブラウザ専用です。ローカルの再生位置保存間隔とは別です。定期確認がオフでも起動・復帰・変更の送信時に同期します。</p>
              <button className="secondary" disabled={!cloud.ready || cloud.busy} onClick={() => void cloud.sync()}>今すぐ同期</button>
              <button className="text-button" disabled={!!session || cloud.busy} onClick={cloud.inheritQueue}>別ブラウザのキューを引き継ぐ</button>
              <details>
                <summary onClick={() => void cloud.listBackups()}>バックアップから復元</summary>
                <p className="panel-note">各ブラウザの同期前の状態と削除前の状態を直近30世代保持します。</p>
                <button className="text-button" onClick={() => void cloud.listBackups()}>一覧を更新</button>
                {cloud.backups.map((backup) => <div key={backup.id} className="setting-row"><span>{new Date(backup.createdAt).toLocaleString("ja-JP")}（{backup.device.slice(0, 8)}）</span><button className="text-button" disabled={!!session || cloud.busy} onClick={() => void cloud.restoreBackup(backup.id)}>復元</button></div>)}
              </details>
            </div>
          )}
          <div className="settings-section settings-list">
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
            <p className="panel-note" hidden>
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
            <h3>動画時間での絞り込み</h3>
            <label className="setting-row">
              <span>動画時間で除外する</span>
              <input type="checkbox" checked={settings.excludeShort}
                onChange={(event) => updateSettings({ excludeShort: event.target.checked })} />
            </label>
            <label className="setting-row">
              <span>表示する動画時間の下限</span>
              <select value={durationMin} disabled={!settings.excludeShort} onChange={(event) => {
                const seconds = Number(event.target.value);
                updateSettings({
                  shortThreshold: seconds < 0 ? -1 : seconds - 1,
                  durationMaxSeconds: settings.durationMaxSeconds < 0 ? -1 : Math.max(seconds, settings.durationMaxSeconds),
                });
              }}>
                <option value={-1}>なし</option>
                {durationMin >= 0 && !durationOptions.includes(durationMin) && (
                  <option value={durationMin}>{formatDuration(settings.shortThreshold)}を超える（従来の設定）</option>
                )}
                {durationOptions.map((seconds) => <option key={seconds} value={seconds}>{durationLabel(seconds)}</option>)}
              </select>
            </label>
            <label className="setting-row">
              <span>表示する動画時間の上限</span>
              <select value={settings.durationMaxSeconds} disabled={!settings.excludeShort} onChange={(event) => {
                const seconds = Number(event.target.value);
                updateSettings({
                  durationMaxSeconds: seconds,
                  shortThreshold: seconds < 0 ? settings.shortThreshold : Math.min(settings.shortThreshold, seconds - 1),
                });
              }}>
                <option value={-1}>なし</option>
                {durationOptions.map((seconds) => <option key={seconds} value={seconds}>{durationLabel(seconds)}</option>)}
              </select>
            </label>
          </div>
          <div className="settings-section">
            <h3>再生位置での絞り込み</h3>
            <label className="setting-row">
              <span>再生位置で除外する</span>
              <input type="checkbox" checked={settings.excludeByWatchedRange}
                onChange={(event) => updateSettings({ excludeByWatchedRange: event.target.checked })} />
            </label>
            <label className="setting-row">
              <span>表示する視聴割合の下限</span>
              <select value={settings.watchedMinPercent} disabled={!settings.excludeByWatchedRange} onChange={(event) => {
                const value = Number(event.target.value);
                updateSettings({ watchedMinPercent: value, watchedMaxPercent: Math.max(value, settings.watchedMaxPercent) });
              }}>
                {!watchedPercentOptions.includes(settings.watchedMinPercent) && <option value={settings.watchedMinPercent}>{settings.watchedMinPercent}%（従来の設定）</option>}
                {watchedPercentOptions.map((percent) => <option key={percent} value={percent}>{percent}%</option>)}
              </select>
            </label>
            <label className="setting-row">
              <span>表示する視聴割合の上限</span>
              <select value={settings.watchedMaxPercent} disabled={!settings.excludeByWatchedRange} onChange={(event) => {
                const value = Number(event.target.value);
                updateSettings({ watchedMaxPercent: value, watchedMinPercent: Math.min(value, settings.watchedMinPercent) });
              }}>
                {!watchedPercentOptions.includes(settings.watchedMaxPercent) && <option value={settings.watchedMaxPercent}>{settings.watchedMaxPercent}%（従来の設定）</option>}
                {watchedPercentOptions.map((percent) => <option key={percent} value={percent}>{percent}%</option>)}
              </select>
            </label>
            <p className="panel-note">未視聴は0%として扱います。</p>
          </div>
          <div className="settings-section">
            <h3>非表示にした動画</h3>
            <label className="setting-row">
              <span>非表示の動画を除外する</span>
              <input type="checkbox" checked={settings.excludeHiddenVideos}
                onChange={(event) => updateSettings({ excludeHiddenVideos: event.target.checked })} />
            </label>
            <button className="secondary" onClick={() => {
              setHiddenPage(0);
              setPanel("hiddenVideos");
            }}>非表示リストを見る</button>
          </div>
          <div className="settings-section">
            <h3>再生位置</h3>
            <label className="setting-row">
              <span>途中から再生する</span>
              <input
                type="checkbox"
                checked={settings.resumePlaybackPosition}
                onChange={(event) =>
                  updateSettings({
                    resumePlaybackPosition: event.target.checked,
                  })
                }
              />
            </label>
            <label className="setting-row">
              <span>保存間隔</span>
              <select
                value={settings.playbackSaveIntervalSeconds}
                onChange={(event) =>
                  updateSettings({
                    playbackSaveIntervalSeconds: Number(event.target.value),
                  })
                }
              >
                {playbackSaveIntervals.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds === 0
                      ? "なし（切替・終了時のみ）"
                      : `${seconds}秒`}
                  </option>
                ))}
              </select>
            </label>
            <label className="setting-row">
              <span>終端付近は最初から再生</span>
              <select value={settings.restartNearEndSeconds} onChange={(event) => updateSettings({ restartNearEndSeconds: Number(event.target.value) })}>
                {[0, 5, 10, 15, 30].map((seconds) => (
                  <option key={seconds} value={seconds}>{seconds === 0 ? "なし" : `残り${seconds}秒以下`}</option>
                ))}
              </select>
            </label>
            <p className="panel-note" hidden>
              再生位置の記録と最後に再生した動画IDの保存は常に有効です。オフにすると保存位置を使わず最初から再生します。本家YouTubeの視聴位置とは同期しません。
            </p>
          </div>
          <div className="settings-section">
            <h3>シアターモード</h3>
            <label className="theater-brightness">
              表示の明るさ <output>{settings.theaterBrightness}%</output>
              <input
                type="range"
                min="1"
                max="100"
                step="1"
                value={settings.theaterBrightness}
                onChange={(event) =>
                  updateSettings({
                    theaterBrightness: Number(event.target.value),
                  })
                }
              />
            </label>
            <p className="panel-note theater-instructions" hidden>
              再生中の画面右上、設定の右にあるシアターアイコンを押すと、確認なしでページ全体をこの明るさにします。プレーヤーを含む画面全体のタップをガードし、トリプルタップで再生・一時停止を切り替えます。シアターボタンの位置をタップ、または3秒長押しで解除します。
            </p>
            <p className="panel-note" hidden>
              本体の輝度やSafariのアドレスバーは変更できません。省電力にはコントロールセンターで本体の明るさも下げてください。自動ロック防止は端末が許可する場合だけ有効です。画面ロック中やバックグラウンドでの再生には対応しません。
            </p>
          </div>
          <div className="connection-card">
            <span className="tag">
              {catalog.auth?.authenticated
                ? "接続済み"
                : catalog.isDemo
                  ? "サンプルモード"
                  : "未接続"}
            </span>
            <h3>{catalog.auth?.account?.email ?? "Googleアカウント未接続"}</h3>
            <p hidden={!!catalog.auth?.authenticated}>
              {catalog.auth?.authenticated
                ? "保存キュー・非表示・共通設定・再生位置はクラウドへ同期できます。現在のキューはブラウザごとに保存します。"
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
              <p className="panel-note" hidden>
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
          <div className="settings-section settings-app">
            <h3>アプリとホーム画面</h3>
            <label className="setting-row">
              <span>しばらく閉じた後に自動更新</span>
              <select
                value={settings.catalogAutoRefreshMinutes}
                onChange={(event) => updateSettings({
                  catalogAutoRefreshMinutes: Number(event.target.value),
                })}
              >
                {catalogAutoRefreshIntervals.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes ? `${minutes}分` : "オフ"}
                  </option>
                ))}
              </select>
            </label>
            <p><a className="text-button" href="/?lab=layout">表示ずれの比較画面</a></p>
            <p className="panel-note">
              iPhoneはSafariの共有から「ホーム画面に追加」を選びます。
              <span hidden>
                追加後はホーム画面から開いてGoogleへ接続してください。
              </span>
            </p>
            <p className="panel-note" hidden>
              キューと設定はこの端末内に保存します。動画の取得・再生には通信が必要です。
            </p>
            <p className="panel-note" hidden>
              {pwa.enabled
                ? pwa.installed
                  ? "アプリ本体をこの端末に保存済みです。"
                  : "アプリ本体をこの端末に保存しています。"
                : "ホーム画面からの起動とアプリ更新は公開URLで確認できます。"}
            </p>
            <p className="app-version">
              {pwa.enabled
                ? pwa.installed
                  ? "アプリを保存済み"
                  : "アプリを保存中"
                : "アプリ"}{" "}
              v{appVersion}
            </p>
            {pwa.enabled && (
              <button
                className="secondary"
                onClick={() => void pwa.checkUpdate()}
              >
                アプリの更新を確認
              </button>
            )}
            {pwa.updateReady && (
              <p className="panel-note">
                新版を検出しました。設定を閉じ、一覧上部の「アプリを更新」から適用できます。
              </p>
            )}
            {pwa.message && (
              <p className="notice error" role="alert">
                {pwa.message}
              </p>
            )}
            <p className="panel-note" hidden>
              v{appVersion} ·
              キュー・非表示・表示設定の端末間同期は後の段階です。
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
            {panel === "queue" ? (
              <>
                <button onClick={() => removeQueueVideo(menuVideo.id)}>
                  <Icon name="close" />
                  キューから削除
                </button>
                <button disabled={!canPlay} onClick={() => startPlayback({ videoId: menuVideo.id })}>
                  <Icon name="play" />
                  この動画から再生
                </button>
              </>
            ) : (
              <>
                {saved.queue.includes(menuVideo.id) ? (
                  <button onClick={() => removeQueueVideo(menuVideo.id)}>
                    <Icon name="close" />
                    キューから削除
                  </button>
                ) : (
                  <button onClick={() => addQueueVideo(menuVideo.id)}>
                    <Icon name="plus" />
                    キューに追加
                  </button>
                )}
                {saved.queue[0] !== menuVideo.id && (
                  <button onClick={() => moveQueueVideoToFront(menuVideo.id)}>
                    <Icon name="list" />
                    {saved.queue.includes(menuVideo.id) ? "先頭に移動" : "キューの最初に追加"}
                  </button>
                )}
                <button onClick={startSinglePlayback}>
                  <Icon name="play" />
                  この動画のみを再生
                </button>
              </>
            )}
            <button disabled={menuVideo.durationSeconds <= 0} onClick={() => markVideoWatched(menuVideo)}>
              <Icon name="check" />
              視聴済みとしてマーク
            </button>
            <button onClick={() => setVideoHidden(menuVideo.id, !saved.hidden.includes(menuVideo.id))}>
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
      {theater && (
        <TheaterControls
          playbackComplete={playbackComplete}
          onTogglePlayback={() =>
            playerHandle.current?.togglePlayback() ?? null
          }
          onSeek={(seconds) => playerHandle.current?.seekBy(seconds) ?? false}
          exitButton={theaterButton}
          onExit={() => {
            suppressTheaterClick.current = true;
            setTheater(false);
          }}
        />
      )}
    </div>
  );
}
