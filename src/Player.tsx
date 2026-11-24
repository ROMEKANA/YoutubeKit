import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { Icon } from "./Icon";
import { formatDuration, type Video } from "./model";
import { canSamplePlaybackPosition, getQueueEditStart, PlaylistTracker, type QueueEditStart } from "./playback";
import { loadYouTubeApi } from "./youtube";
import { VideoDescription } from "./VideoDescription";
import { VideoInteractions, YouTubePrivacyConsent } from "./VideoInteractions";
import { canSeekToTimestamp, loadedVideoId, observedTimestampPosition } from "./timestamps";
import type { ServerStatus } from "./useCatalog";

interface Props {
  videos: Video[];
  playbackPositions: Record<string, number>;
  saveIntervalSeconds: number;
  resumePlaybackPosition: boolean;
  restartNearEndSeconds?: number;
  active: boolean;
  youtubeAuth?: ServerStatus | null;
  interactionRefresh?: number;
  interactionPolicyAccepted?: boolean;
  onAcceptInteractionPolicy?: () => void;
  onClose: () => void;
  onPlaybackProgress?: (videoId: string, positionSeconds: number, recordedAt: number, restart?: boolean) => void;
  onPlayingChange?: (playing: boolean) => void;
  onVideoPlaying?: (video: Video) => void;
  onSaveQueue?: (videoIds: string[]) => void;
  onQueueEdit?: (videos: Video[]) => void;
  videoMaximized?: boolean;
  onToggleVideoMaximized?: () => void;
  testMode?: boolean;
  diagnosticSizing?: "auto" | "freeze" | "width";
  onLayoutDiagnostic?: (event: PlayerLayoutDiagnostic) => void;
  ref?: Ref<PlayerHandle>;
}

export interface PlayerLayoutDiagnostic {
  event: "measure" | "setSize";
  width: number;
  height: number;
  availableHeight?: number;
  limitedBy?: "width" | "height";
}

export interface PlayerHandle {
  startAt: (position: number, positionSeconds?: number, restartQueue?: boolean) => boolean;
  endSession: () => void;
  togglePlayback: () => "playing" | "paused" | null;
  seekBy: (seconds: number) => boolean;
  seekTo: (videoId: string, seconds: number) => boolean;
}

// 再生順はセッションで管理し、再生画面の編集操作でだけ更新する。
export function Player({
  videos: sourceVideos,
  playbackPositions,
  saveIntervalSeconds,
  resumePlaybackPosition,
  restartNearEndSeconds = 10,
  active,
  youtubeAuth,
  interactionRefresh = 0,
  interactionPolicyAccepted = false,
  onAcceptInteractionPolicy,
  onClose,
  onPlaybackProgress,
  onPlayingChange,
  onVideoPlaying,
  onSaveQueue,
  onQueueEdit,
  videoMaximized = false,
  onToggleVideoMaximized,
  testMode = false,
  diagnosticSizing = "auto",
  onLayoutDiagnostic,
  ref,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const transport = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const player = useRef<YT.Player | null>(null);
  const playerSizeReady = useRef(false);
  const playerSize = useRef<{ instance: YT.Player; width: number; height: number } | null>(null);

  // 外枠と埋め込みの寸法を揃え、サイズ変更後に古い表示寸法が残らないようにする。
  function syncPlayerSize(instance: YT.Player, width: number, height: number) {
    const previous = playerSize.current;
    if (previous?.instance === instance && previous.width === width && previous.height === height) return;
    instance.setSize(width, height);
    playerSize.current = { instance, width, height };
    onLayoutDiagnostic?.({ event: "setSize", width, height });
  }

  // 表示領域と操作列の実寸から枠とプレーヤーを変更し、同じiframeで再生を続ける。
  useLayoutEffect(() => {
    if (!active) return;
    const section = view.current;
    const shell = host.current;
    const top = toolbar.current;
    const bottom = transport.current;
    const probe = viewport.current;
    if (!section || !shell || !top || !bottom || !probe) return;
    const header = document.querySelector<HTMLElement>(".header");
    let frame = 0;
    let align = true;
    let viewportWidth = window.innerWidth;
    const measure = () => {
      const headerHeight = header && getComputedStyle(header).position === "sticky" ? header.getBoundingClientRect().height : 0;
      const safeTop = headerHeight > 0 ? 0 : parseFloat(getComputedStyle(probe).paddingTop) || 0;
      const safeBottom = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
      const visibleHeight = Math.min(probe.clientHeight, window.visualViewport?.height ?? window.innerHeight);
      const controlsHeight = videoMaximized ? 0 : top.offsetHeight + bottom.offsetHeight + 24;
      const availableHeight = Math.max(200, visibleHeight - headerHeight - safeTop - safeBottom - 12 - controlsHeight);
      const width = Math.max(200, Math.floor(diagnosticSizing === "width" ? section.clientWidth : Math.min(section.clientWidth, availableHeight * 16 / 9)));
      const height = Math.max(200, Math.floor(width * 9 / 16));
      shell.style.width = `${width}px`;
      shell.style.height = `${height}px`;
      if (playerSizeReady.current && player.current) syncPlayerSize(player.current, width, height);
      onLayoutDiagnostic?.({ event: "measure", width, height, availableHeight, limitedBy: diagnosticSizing === "width" || section.clientWidth <= availableHeight * 16 / 9 ? "width" : "height" });
      if (align) {
        align = false;
        const target = videoMaximized ? shell : top;
        window.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top + window.scrollY - headerHeight - safeTop - 6), behavior: "instant" });
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = () => {
      // 操作バーの開閉でサイズだけを変え、上へ戻るスクロールを妨げない。
      align ||= viewportWidth !== window.innerWidth;
      viewportWidth = window.innerWidth;
      schedule();
    };
    const observer = new ResizeObserver(schedule);
    // 固定条件では開始時だけ計算し、回転・操作バー変化への追従を外して比較する。
    if (diagnosticSizing !== "freeze") {
      for (const element of [section, top, bottom, probe, header]) {
        if (element) observer.observe(element);
      }
      window.addEventListener("resize", resize);
      window.visualViewport?.addEventListener("resize", resize);
    }
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, [active, videoMaximized, diagnosticSizing]);
  const [editedQueue, setEditedQueue] = useState<{ source: Video[]; videos: Video[] } | null>(null);
  const videos = editedQueue?.source === sourceVideos ? editedQueue.videos : sourceVideos;
  const [index, setIndex] = useState(0);
  const [queueDisplay, setQueueDisplay] = useState<{
    videoId: string;
    positions: Record<string, number>;
  } | null>(null);
  const displayedVideoId = useRef<string | null>(null);
  const queueDrag = useRef<{ from: number; to: number } | null>(null);
  const [draggedRow, setDraggedRow] = useState<{ from: number; to: number } | null>(null);
  const restoreAfterEdit = useRef<QueueEditStart | null>(null);
  const restartOnFirstPlay = useRef(new Set<string>());
  const loadingEdit = useRef<{ ids: string[]; index: number } | null>(null);
  const playbackWatch = useRef<number | null>(null);
  const requestedIndex = useRef<number | null>(null);
  const [resumeNotice, setResumeNotice] = useState("");
  const sampleAfter = useRef(0);
  const pendingRestoreSeconds = useRef<number | null>(null);
  const recordedQueuePositions = useRef<Record<string, number>>({});
  const [status, setStatus] = useState("YouTubeプレーヤーを読み込んでいます…");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [complete, setComplete] = useState(false);
  const [playbackLoad, setPlaybackLoad] = useState<{ videoId: string; serial: number }>();
  const timestampSample = useRef<number | null>(null);
  // 一時停止や再開をシアターの自動ロック防止へ伝える。
  useEffect(() => {
    onPlayingChange?.(active && playing);
  }, [active, playing, onPlayingChange]);
  const [attempt, setAttempt] = useState(0);
  const tracker = useRef(new PlaylistTracker(videos.length));
  const queueReady = useRef(false);
  const startRequested = useRef<{ position: number; positionSeconds?: number } | null>(null);
  const explicitStart = useRef<{ position: number; positionSeconds?: number } | null>(null);
  const resumeCheckedVideoId = useRef<string | null>(null);
  const lastPlayingIndex = useRef(-1);
  const lastPlaybackSample = useRef<{
    videoId: string;
    positionSeconds: number;
    recordedAt: number;
  } | null>(null);
  const lastPositionSavedAt = useRef(0);
  const videosRef = useRef(videos);
  const playbackPositionsRef = useRef(playbackPositions);
  const saveIntervalSecondsRef = useRef(saveIntervalSeconds);
  const resumePlaybackPositionRef = useRef(resumePlaybackPosition);
  const restartNearEndSecondsRef = useRef(restartNearEndSeconds);
  const onPlaybackProgressRef = useRef(onPlaybackProgress);
  const onVideoPlayingRef = useRef(onVideoPlaying);
  onVideoPlayingRef.current = onVideoPlaying;
  playbackPositionsRef.current = playbackPositions;
  saveIntervalSecondsRef.current = saveIntervalSeconds;
  resumePlaybackPositionRef.current = resumePlaybackPosition;
  restartNearEndSecondsRef.current = restartNearEndSeconds;
  onPlaybackProgressRef.current = onPlaybackProgress;

  useEffect(() => {
    if (active) return;
    displayedVideoId.current = null;
    recordedQueuePositions.current = {};
    setQueueDisplay(null);
    setPlaybackLoad(undefined);
    clearTimestampSample();
  }, [active]);

  // 緑の行と他の動画の再生位置を、実際に再生する動画が変わったときだけ更新する。
  function updateQueueDisplay(videoId: string) {
    if (displayedVideoId.current === videoId) return;
    displayedVideoId.current = videoId;
    setQueueDisplay({
      videoId,
      positions: Object.fromEntries(videosRef.current.map((video) => [
        video.id,
        recordedQueuePositions.current[video.id] ?? playbackPositionsRef.current[video.id] ?? 0,
      ])),
    });
  }

  function persistPlaybackSample(sample: {
    videoId: string;
    positionSeconds: number;
    recordedAt: number;
  }, restart = false) {
    lastPositionSavedAt.current = Date.now();
    recordedQueuePositions.current[sample.videoId] = sample.positionSeconds;
    onPlaybackProgressRef.current?.(sample.videoId, sample.positionSeconds, sample.recordedAt, restart);
  }

  // 間隔保存が有効な時は位置をメモリ上でも観測し、動画切替時に直前の位置を保存する。
  function samplePlaybackProgress(
    instance: YT.Player,
    positionSeconds?: number,
  ) {
    const current = instance.getPlaylistIndex();
    const video = videosRef.current[current];
    const seconds = positionSeconds ?? instance.getCurrentTime();
    const recordedAt = Date.now();
    if (!video || current !== lastPlayingIndex.current ||
        video.id !== resumeCheckedVideoId.current || loadingEdit.current || timestampSample.current !== null ||
        !canSamplePlaybackPosition(
          seconds, recordedAt, sampleAfter.current, pendingRestoreSeconds.current, lastPlaybackSample.current === null,
        ))
      return null;
    pendingRestoreSeconds.current = null;
    const sample = { videoId: video.id, positionSeconds: Math.floor(seconds), recordedAt };
    lastPlaybackSample.current = sample;
    return sample;
  }

  function persistCurrentPlayback(
    instance: YT.Player,
    positionSeconds?: number,
  ) {
    const sample = samplePlaybackProgress(instance, positionSeconds);
    if (sample) persistPlaybackSample(sample);
  }

  // 終了した動画の位置を残し、次回の開始位置は終端設定で判断する。
  function saveCompletedPlayback(position: number) {
    const video = videosRef.current[position];
    if (!video) return;
    const sample = { videoId: video.id, positionSeconds: Math.floor(video.durationSeconds), recordedAt: Date.now() };
    lastPlaybackSample.current = sample;
    persistPlaybackSample(sample);
  }

  function clearTimestampSample() {
    if (timestampSample.current !== null) window.clearTimeout(timestampSample.current);
    timestampSample.current = null;
  }

  function clearPlaybackWatch() {
    if (playbackWatch.current !== null) window.clearTimeout(playbackWatch.current);
    playbackWatch.current = null;
  }

  function cueEditedPlaylist(instance: YT.Player) {
    const edit = loadingEdit.current;
    if (edit) instance.cuePlaylist(edit.ids, edit.index, restoreAfterEdit.current?.seconds ?? 0);
  }

  // 再生開始の実績を確認し、切り替わらない場合だけ回数を限って再試行する。
  function watchPlayback(instance: YT.Player, position: number, retry: () => void) {
    clearPlaybackWatch();
    requestedIndex.current = position;
    setResumeNotice("");
    let checks = 0;
    const check = () => {
      playbackWatch.current = null;
      if (player.current !== instance || document.hidden) return;
      if (!loadingEdit.current && instance.getPlaylistIndex() === position && instance.getPlayerState() === 1) {
        requestedIndex.current = null;
        return;
      }
      checks++;
      if (checks >= 3) {
        cueEditedPlaylist(instance);
        setResumeNotice("再生を開始できませんでした。「再開」を押してください。");
        return;
      }
      playbackWatch.current = window.setTimeout(check, 3000);
      if (instance.getPlayerState() !== 3 || instance.getPlaylistIndex() !== position)
        retry();
    };
    playbackWatch.current = window.setTimeout(check, 3000);
  }

  // 実際に再生したIDを確認してから、保存位置を選ぶ。
  function restoreCurrentVideoPosition(instance: YT.Player, video: Video, position: number) {
    const edit = restoreAfterEdit.current;
    const explicit = explicitStart.current;
    restoreAfterEdit.current = null;
    explicitStart.current = null;
    // 再生開始が通知された動画だけ、そのセッションで一度だけ0秒を記録する。
    if (restartOnFirstPlay.current.delete(video.id)) {
      if (instance.getCurrentTime() >= 0.5) instance.seekTo(0, true);
      persistPlaybackSample({ videoId: video.id, positionSeconds: 0, recordedAt: Date.now() }, true);
      return;
    }
    let seconds = 0;
    if (edit?.videoId === video.id) {
      seconds = edit.seconds;
    } else if (resumePlaybackPositionRef.current) {
      seconds = (explicit?.position === position ? explicit.positionSeconds : undefined)
        ?? playbackPositionsRef.current[video.id] ?? 0;
      const duration = instance.getDuration() || video.durationSeconds;
      const threshold = restartNearEndSecondsRef.current;
      if (threshold > 0 && duration > 0 && duration - seconds <= threshold) seconds = 0;
    }
    if (seconds > 0) {
      pendingRestoreSeconds.current = seconds;
      if (Math.abs(instance.getCurrentTime() - seconds) > 0.5) instance.seekTo(seconds, true);
    }
  }

  function playRequestedPosition(
    instance: YT.Player,
    request: { position: number; positionSeconds?: number },
  ) {
    clearTimestampSample();
    startRequested.current = null;
    explicitStart.current = request;
    resumeCheckedVideoId.current = null;
    pendingRestoreSeconds.current = null;
    tracker.current = new PlaylistTracker(videosRef.current.length);
    setComplete(false);
    setStatus(`${request.position + 1}本目を再生します…`);
    const play = () => instance.playVideoAt(request.position);
    watchPlayback(instance, request.position, play);
    play();
  }

  function resumePlayer(instance: YT.Player) {
    const position = requestedIndex.current ?? instance.getPlaylistIndex();
    if (position < 0 || document.hidden) return;
    const play = () => {
      if (instance.getPlaylistIndex() === position) instance.playVideo();
      else instance.playVideoAt(position);
    };
    watchPlayback(instance, position, play);
    play();
  }

  // 通常画面の中央ボタンとシアターモードのトリプルタップで同じ切替処理を使う。
  function togglePlayerPlayback(): "playing" | "paused" | null {
    const instance = player.current;
    if (!instance || !ready || error) return null;
    const state = instance.getPlayerState();
    if (complete || state === 0) {
      tracker.current = new PlaylistTracker(videosRef.current.length);
      setComplete(false);
    }
    if (state === 1 || state === 3) {
      clearPlaybackWatch();
      requestedIndex.current = null;
      instance.pauseVideo();
      setPlaying(false);
      return "paused";
    }
    resumePlayer(instance);
    return "playing";
  }

  // 推測した状態ではなく公式プレーヤーの現在状態で切り替え、完了後は再開しない。
  useImperativeHandle(
    ref,
    () => ({
      startAt(position, positionSeconds, restartQueue = false) {
        restartOnFirstPlay.current = new Set(restartQueue ? videosRef.current.map((video) => video.id) : []);
        const startPosition =
          position >= 0 && position < videos.length ? position : 0;
        const startSeconds =
          positionSeconds !== undefined && Number.isFinite(positionSeconds)
            ? Math.max(0, Math.floor(positionSeconds))
            : undefined;
        const request = {
          position: startPosition,
          positionSeconds: startSeconds,
        };
        startRequested.current = request;
        const instance = player.current;
        if (!instance || !queueReady.current || error) {
          setStatus(`${startPosition + 1}本目を再生する準備をしています…`);
          return false;
        }
        playRequestedPosition(instance, request);
        return true;
      },
      endSession() {
        restartOnFirstPlay.current.clear();
        startRequested.current = null;
        explicitStart.current = null;
        clearPlaybackWatch();
        requestedIndex.current = null;
        const instance = player.current;
        if (instance) {
          persistCurrentPlayback(instance);
          instance.pauseVideo();
        }
        resumeCheckedVideoId.current = null;
        setResumeNotice("");
        setPlaying(false);
        setStatus("キュー再生を終了しました。");
      },
      togglePlayback: togglePlayerPlayback,
      seekBy: seekPlayerBy,
      seekTo: seekToTimestamp,
    }),
    [active, ready, complete, error, videos.length],
  );

  useLayoutEffect(() => {
    let disposed = false;
    let instance: YT.Player | undefined;
    let readyTimer: number | undefined;
    let playerReady = false;
    // 再接続中は準備前のインスタンスへサイズ変更を送らない。
    playerSizeReady.current = false;
    playerSize.current = null;
    queueReady.current = false;
    startRequested.current = null;
    explicitStart.current = null;
    resumeCheckedVideoId.current = null;
    videosRef.current = videos;
    loadingEdit.current = null;
    restoreAfterEdit.current = null;
    pendingRestoreSeconds.current = null;
    requestedIndex.current = null;
    lastPlayingIndex.current = -1;
    lastPlaybackSample.current = null;
    lastPositionSavedAt.current = 0;
    tracker.current = new PlaylistTracker(videos.length);
    setReady(false);
    setPlaying(false);
    setComplete(false);
    setError("");
    setResumeNotice("");
    setIndex(0);
    setStatus("YouTubeプレーヤーを読み込んでいます…");
    const handleVisibilityChange = () => {
      if (document.hidden && playerReady) {
        clearPlaybackWatch();
        requestedIndex.current = null;
        setPlaying(false);
        if (instance) {
          if (saveIntervalSecondsRef.current > 0)
            persistCurrentPlayback(instance);
          else samplePlaybackProgress(instance);
          instance.pauseVideo();
        }
        setStatus("画面に戻ったら「再開」を押してください。");
      } else if (
        playerReady &&
        startRequested.current !== null &&
        queueReady.current &&
        instance
      ) {
        playRequestedPosition(instance, startRequested.current);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    loadYouTubeApi()
      .then((api) => {
        if (disposed || !host.current) return;
        const target = document.createElement("div");
        host.current.replaceChildren(target);
        readyTimer = window.setTimeout(() => {
          if (!disposed)
            setError(
              "プレーヤーの準備が完了しませんでした。再接続してください。",
            );
        }, 20000);
        instance = new api.Player(target, {
          width: Math.max(200, host.current.clientWidth),
          height: Math.max(200, host.current.clientHeight),
          playerVars: {
            playsinline: 1,
            controls: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (event) => {
              if (disposed) return;
              playerReady = true;
              playerSizeReady.current = true;
              if (host.current) syncPlayerSize(event.target, Math.max(200, host.current.clientWidth), Math.max(200, host.current.clientHeight));
              window.clearTimeout(readyTimer);
              readyTimer = undefined;
              setError("");
              setReady(true);
              setStatus("再生キューを準備しています…");
              event.target.setLoop(false);
              event.target.cuePlaylist(videosRef.current.map((video) => video.id), 0, 0);
            },
            onStateChange: (event) => {
              if (disposed) return;
              const target = event.target;
              const current = target.getPlaylistIndex();
              const state = event.data;
              const loading = loadingEdit.current;
              if (loading) {
                const ids = target.getPlaylist();
                if (!ids || ids.length !== loading.ids.length ||
                    !ids.every((id, index) => id === loading.ids[index]) ||
                    current !== loading.index || (state !== 1 && state !== 5))
                  return;
                loadingEdit.current = null;
                queueReady.current = true;
                setReady(true);
              }
              if (state === 5) {
                setPlaying(false);
                queueReady.current = true;
                if (startRequested.current !== null && !document.hidden)
                  playRequestedPosition(target, startRequested.current);
                else setStatus("再生を開始できます。");
                return;
              }
              if (state === 1) {
                const video = videosRef.current[current];
                if (!video || (requestedIndex.current !== null &&
                    requestedIndex.current !== current && lastPlayingIndex.current === current))
                  return;
                queueReady.current = true;
                clearPlaybackWatch();
                requestedIndex.current = null;
                setResumeNotice("");
                if (resumeCheckedVideoId.current !== video.id) {
                  clearTimestampSample();
                  setPlaybackLoad((load) => ({ videoId: video.id, serial: (load?.serial ?? 0) + 1 }));
                  const previous = lastPlaybackSample.current;
                  if (previous && previous.videoId !== video.id) persistPlaybackSample(previous);
                  lastPlaybackSample.current = null;
                  resumeCheckedVideoId.current = video.id;
                  lastPlayingIndex.current = current;
                  sampleAfter.current = Date.now() + 2000;
                  lastPositionSavedAt.current = Date.now();
                  pendingRestoreSeconds.current = null;
                  updateQueueDisplay(video.id);
                  onVideoPlayingRef.current?.(video);
                  restoreCurrentVideoPosition(target, video, current);
                }
                setPlaying(!document.hidden);
              }
              const actionIndex = state === 0 ? lastPlayingIndex.current : current;
              if (state === 0 && actionIndex >= 0 &&
                  videosRef.current[actionIndex]?.id === resumeCheckedVideoId.current) {
                clearTimestampSample();
                saveCompletedPlayback(actionIndex);
                resumeCheckedVideoId.current = null;
                pendingRestoreSeconds.current = null;
                const next = actionIndex + 1;
                if (next < videosRef.current.length && !document.hidden) {
                  watchPlayback(target, next, () => {
                    if (target.getPlaylistIndex() === next) target.playVideo();
                    else target.playVideoAt(next);
                  });
                }
              }
              const action = tracker.current.observe(state, actionIndex);
              if (action === "playing") {
                setComplete(false);
                setIndex(current);
                setError("");
                setStatus("再生中");
                if (document.hidden) target.pauseVideo();
              } else if (action === "complete") {
                restartOnFirstPlay.current.clear();
                clearPlaybackWatch();
                requestedIndex.current = null;
                setPlaying(false);
                setComplete(true);
                setStatus("選んだ動画の再生が終わりました。");
              } else if (state === 0) {
                setPlaying(false);
              } else if (state === 2) {
                if (current === lastPlayingIndex.current && requestedIndex.current === null)
                  persistCurrentPlayback(target);
                setPlaying(false);
                setStatus("一時停止中");
              } else if (state === 3) {
                const next = videosRef.current[current];
                if (next && current !== lastPlayingIndex.current && requestedIndex.current === null &&
                    lastPlayingIndex.current >= 0 && !document.hidden)
                  watchPlayback(target, current, () => target.playVideo());
                setStatus("動画を読み込んでいます…");
              }
            },
            onAutoplayBlocked: (event) => {
              if (disposed) return;
              clearPlaybackWatch();
              cueEditedPlaylist(event.target);
              setPlaying(false);
              setResumeNotice("自動再生が制限されました。「再開」を押してください。");
            },
            onError: (event) => {
              if (disposed) return;
              clearPlaybackWatch();
              setResumeNotice("");
              const messages: Record<number, string> = {
                2: "動画IDが正しくありません。",
                5: "この環境で動画を再生できません。",
                100: "動画が削除されたか、非公開になっています。",
                101: "この動画は埋め込み再生できません。",
                150: "この動画は埋め込み再生できません。",
                153: "YouTubeが再生元を確認できませんでした。通常のブラウザでlocalhostから開いてください。",
              };
              setError(
                `${messages[event.data] ?? "動画を再生できませんでした。"}（${event.data}）`,
              );
              setPlaying(false);
              setStatus("再生を停止しています。キューは保存されています。");
              event.target.pauseVideo();
            },
          },
        });
        player.current = instance;
      })
      .catch((reason: unknown) => {
        if (!disposed)
          setError(
            reason instanceof Error
              ? reason.message
              : "YouTubeに接続できませんでした。",
          );
      });

    return () => {
      disposed = true;
      clearTimestampSample();
      clearPlaybackWatch();
      window.clearTimeout(readyTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      playerSizeReady.current = false;
      playerSize.current = null;
      instance?.destroy();
      player.current = null;
    };
  }, [sourceVideos, attempt]);

  // 1秒ごとにメモリ上だけ更新し、設定間隔に達した時だけブラウザ保存へ通知する。
  useEffect(() => {
    if (saveIntervalSeconds <= 0) return;
    const timer = window.setInterval(() => {
      const instance = player.current;
      if (instance?.getPlayerState() !== 1) return;
      const sample = samplePlaybackProgress(instance);
      const interval = saveIntervalSecondsRef.current;
      if (
        sample &&
        interval > 0 &&
        Date.now() - lastPositionSavedAt.current >= interval * 1000
      )
        persistPlaybackSample(sample);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [saveIntervalSeconds]);

  // 利用者が選んだ動画も共通の位置復元を通し、完了後なら終了判定を新しく始める。
  function playFromQueue(position: number) {
    const instance = player.current;
    if (
      !instance ||
      !ready ||
      error ||
      position < 0 ||
      position >= videos.length
    )
      return;
    persistCurrentPlayback(instance);
    restoreAfterEdit.current = null;
    playRequestedPosition(instance, { position });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // 動画内の移動は公式APIだけを使い、現在のキュー位置は変更しない。
  function seekPlayerBy(seconds: number): boolean {
    const instance = player.current;
    if (!instance || !ready || error) return false;
    if (complete) {
      tracker.current = new PlaylistTracker(videosRef.current.length);
      setComplete(false);
    }
    clearTimestampSample();
    const currentTime = instance.getCurrentTime();
    const duration = instance.getDuration();
    const upperLimit = duration > 0 ? duration : currentTime + seconds;
    const nextTime = Math.max(0, Math.min(currentTime + seconds, upperLimit));
    pendingRestoreSeconds.current = null;
    sampleAfter.current = 0;
    instance.seekTo(nextTime, true);
    samplePlaybackProgress(instance, nextTime);
    setStatus(seconds < 0 ? "10秒戻しました。" : "10秒進めました。");
    return true;
  }

  // iframeの応答を観測し、別の動画やシーク前の時刻を保存しない。
  function seekToTimestamp(videoId: string, seconds: number): boolean {
    const instance = player.current;
    if (!active || !instance || !ready || error || loadingEdit.current ||
        requestedIndex.current !== null || startRequested.current !== null ||
        instance.getPlaylistIndex() !== lastPlayingIndex.current ||
        loadedVideoId(instance.getVideoUrl()) !== videoId ||
        videosRef.current[lastPlayingIndex.current]?.id !== videoId ||
        !canSeekToTimestamp(seconds, instance.getDuration())) return false;
    const state = instance.getPlayerState();
    if (![0, 1, 2, 3].includes(state)) return false;

    clearTimestampSample();
    if (state === 0) {
      tracker.current.observe(1, lastPlayingIndex.current);
      resumeCheckedVideoId.current = videoId;
      setComplete(false);
    }
    pendingRestoreSeconds.current = null;
    const before = instance.getCurrentTime();
    const startedAt = Date.now();
    sampleAfter.current = startedAt + 1000;
    instance.seekTo(seconds, true);

    const check = () => {
      timestampSample.current = null;
      if (player.current !== instance || loadedVideoId(instance.getVideoUrl()) !== videoId ||
          instance.getPlaylistIndex() !== lastPlayingIndex.current || requestedIndex.current !== null) return;
      const position = observedTimestampPosition(instance.getCurrentTime(), before, seconds);
      if (position !== null) {
        const sample = { videoId, positionSeconds: position, recordedAt: Date.now() };
        lastPlaybackSample.current = sample;
        persistPlaybackSample(sample, sample.positionSeconds === 0);
      } else if (Date.now() - startedAt < 3000) {
        timestampSample.current = window.setTimeout(check, 100);
      }
    };
    timestampSample.current = window.setTimeout(check, 100);
    host.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return true;
  }

  // 指を離して確定した時点のIDと秒数を読み取り、編集中の自然な動画切替にも追従する。
  function editQueue(next: Video[]) {
    const instance = player.current;
    if (!instance || !onQueueEdit || !queueReady.current || error) return;
    const playlistIndex = instance.getPlaylistIndex();
    const videoId = instance.getPlaylist()?.[playlistIndex] ?? videos[playlistIndex]?.id ?? videos[index]?.id;
    if (!videoId) return;
    const state = instance.getPlayerState();
    const restore = restoreAfterEdit.current;
    const measured = restore?.videoId === videoId
      ? restore.seconds
      : (videoId === resumeCheckedVideoId.current ? pendingRestoreSeconds.current : null)
        ?? instance.getCurrentTime();
    const seconds = Number.isFinite(measured) && measured >= 0
      ? measured
      : recordedQueuePositions.current[videoId] ?? playbackPositionsRef.current[videoId] ?? 0;
    const saved = getQueueEditStart(
      videos.map((video) => video.id),
      next.map((video) => video.id),
      { videoId, seconds, autoplay: state === 1 || state === 3 },
      playbackPositionsRef.current,
    );
    if (!saved) {
      onQueueEdit([]);
      onClose();
      return;
    }
    if ((state === 1 || state === 2 || state === 3) && pendingRestoreSeconds.current === null)
      persistCurrentPlayback(instance);
    clearTimestampSample();
    clearPlaybackWatch();
    requestedIndex.current = null;
    queueReady.current = false;
    explicitStart.current = null;
    resumeCheckedVideoId.current = null;
    pendingRestoreSeconds.current = null;
    lastPlayingIndex.current = -1;
    lastPlaybackSample.current = null;
    tracker.current = new PlaylistTracker(next.length);
    const editIndex = next.findIndex((video) => video.id === saved.videoId);
    const ids = next.map((video) => video.id);
    loadingEdit.current = { ids, index: editIndex };
    const start = restartOnFirstPlay.current.has(saved.videoId)
      ? { ...saved, seconds: 0 }
      : saved;
    restoreAfterEdit.current = start;
    videosRef.current = next;
    setEditedQueue({ source: sourceVideos, videos: next });
    setReady(false);
    setComplete(false);
    setIndex(editIndex);
    onQueueEdit(next);
    // 既存iframeに対し、編集を確定したタップやドラッグの中で再生を要求する。
    if (start.autoplay && !document.hidden) {
      watchPlayback(instance, editIndex, () => {
        if (loadingEdit.current) instance.loadPlaylist(ids, editIndex, start.seconds);
        else instance.playVideo();
      });
      instance.loadPlaylist(ids, editIndex, start.seconds);
    } else {
      setResumeNotice("");
      instance.cuePlaylist(ids, editIndex, start.seconds);
    }
  }

  function moveQueueRow(from: number, to: number) {
    if (from === to || from < 0 || from >= videos.length || to < 0 || to >= videos.length) return;
    const next = [...videos];
    const [video] = next.splice(from, 1);
    next.splice(to, 0, video);
    editQueue(next);
  }

  function clearQueueDrag() {
    queueDrag.current = null;
    setDraggedRow(null);
  }

  const current = videos[index] ?? videos[0];
  return (
    <section
      ref={view}
      className={`playback-view ${active ? "" : "player-preparing"}`.trim()}
      aria-hidden={!active}
      inert={!active}
    >
      <div className="player-viewport" ref={viewport} aria-hidden="true" />
      <div hidden>
        <p className="eyebrow">NOW WATCHING</p>
        <h1>選んだ分だけ観れるサイト</h1>
      </div>
      <div className="player-toolbar" ref={toolbar}>
        <button className="text-button" onClick={onClose}>
          ← 動画一覧に戻る
        </button>
        <span className="tag">
          {index + 1} / {videos.length} 本
        </span>
        {onToggleVideoMaximized && (
          <button className={`icon-button ${videoMaximized ? "active" : ""}`}
            aria-label={videoMaximized ? "操作ボタンを含めて画面に収める" : "動画を画面内で最大化する"}
            title={videoMaximized ? "操作ボタンを含めて画面に収める" : "動画を画面内で最大化する"}
            aria-pressed={videoMaximized} onClick={onToggleVideoMaximized}>
            <Icon name={videoMaximized ? "shrink" : "expand"} />
          </button>
        )}
      </div>
      <div className="player-shell" ref={host} />
      <div className="player-transport" ref={transport} aria-label="動画の再生操作">
        <button
          className="icon-button player-control-button"
          aria-label="前の動画"
          title="前の動画"
          disabled={!ready || !!error || index <= 0}
          onClick={() => playFromQueue(index - 1)}
        >
          <Icon name="previous" />
        </button>
        <button
          className="icon-button player-control-button"
          aria-label="10秒戻る"
          title="10秒戻る"
          disabled={!ready || !!error}
          onClick={() => seekPlayerBy(-10)}
        >
          <Icon name="back-10" />
        </button>
        <button
          className="icon-button player-control-button"
          aria-label={playing ? "一時停止" : "再生"}
          title={playing ? "一時停止" : "再生"}
          disabled={!ready || !!error}
          onClick={togglePlayerPlayback}
        >
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <button
          className="icon-button player-control-button"
          aria-label="10秒進む"
          title="10秒進む"
          disabled={!ready || !!error}
          onClick={() => seekPlayerBy(10)}
        >
          <Icon name="forward-10" />
        </button>
        <button
          className="icon-button player-control-button"
          aria-label="次の動画"
          title="次の動画"
          disabled={!ready || !!error || index >= videos.length - 1}
          onClick={() => playFromQueue(index + 1)}
        >
          <Icon name="next" />
        </button>
      </div>
      <div className="player-status" role="status" hidden>
        {status}
      </div>
      {resumeNotice && <p className="notice sync-warning" role="status">{resumeNotice}</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <h2 className="now-title">{current.title}</h2>
      <p className="muted">{current.channel}</p>
      {active && youtubeAuth && interactionPolicyAccepted && <VideoInteractions auth={youtubeAuth}
        video={playbackLoad?.videoId === current.id ? current : null}
        playbackLoad={playbackLoad?.serial ?? 0} refresh={interactionRefresh} />}
      <div className="player-actions">
        {testMode && (
          <button
            className="secondary"
            disabled={!ready || complete || !!error}
            onClick={() => {
              const duration = player.current?.getDuration() ?? 0;
              if (duration > 10) player.current?.seekTo(duration - 10, true);
            }}
          >
            終了10秒前へ（検証用）
          </button>
        )}
        {!complete && (
          <button
            className="primary"
            disabled={!ready || !!error}
            onClick={() => { if (player.current) resumePlayer(player.current); }}
          >
            再開
          </button>
        )}
        {error && (
          <button
            className="primary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            先頭から再接続
          </button>
        )}
        <button className="secondary" onClick={onClose}>
          キュー再生を終了
        </button>
        {onSaveQueue && (
          <button
            className="secondary save-playing-queue"
            onClick={() => onSaveQueue(videos.map((video) => video.id))}
          >
            このキューを保存
          </button>
        )}
      </div>
      {active && youtubeAuth && <VideoDescription key={current.id} videoId={current.id}
        duration={current.durationSeconds} onSeek={seekToTimestamp} consent={
          !interactionPolicyAccepted && youtubeAuth.csrfToken && onAcceptInteractionPolicy
            ? <YouTubePrivacyConsent csrf={youtubeAuth.csrfToken} onAccept={onAcceptInteractionPolicy} />
            : undefined
        } />}
      <div className="session-queue">
        <h2>再生キュー</h2>
        <p className="muted" hidden>
          {complete
            ? resumePlaybackPosition
              ? "おつかれさまでした。動画を押すと、保存位置からもう一度再生できます。"
              : "おつかれさまでした。動画を押すと、最初からもう一度再生できます。"
            : resumePlaybackPosition
              ? "動画を押すと、その動画の保存位置から再生します。最後の動画で終了します。"
              : "動画を押すと、その動画を最初から再生します。最後の動画で終了します。"}
        </p>
        <ol>
          {videos.map((video, position) => {
            const isCurrent = queueDisplay?.videoId === video.id;
            const savedPosition = queueDisplay?.positions[video.id] ?? playbackPositions[video.id] ?? 0;
            const dropMarker = draggedRow && draggedRow.from !== position && draggedRow.to === position
              ? draggedRow.from > position ? "drop-before" : "drop-after"
              : "";
            return (
              <li
                key={video.id}
                data-session-queue-index={position}
                className={`${isCurrent ? "current" : ""} ${dropMarker}`.trim()}
              >
                {onQueueEdit && (
                  <button
                    className="icon-button drag-handle session-queue-edit"
                    aria-label={`${video.title}を並べ替える。ドラッグまたは上下キー`}
                    disabled={!ready || !!error || videos.length < 2}
                    onPointerDown={(event) => {
                      if (event.button !== 0 || !event.isPrimary) return;
                      queueDrag.current = { from: position, to: position };
                      setDraggedRow(queueDrag.current);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (!queueDrag.current || !event.isPrimary) return;
                      const row = document.elementFromPoint(event.clientX, event.clientY)
                        ?.closest<HTMLElement>("[data-session-queue-index]");
                      if (!row) return;
                      const to = Number(row.dataset.sessionQueueIndex);
                      if (to !== queueDrag.current.to) {
                        queueDrag.current = { ...queueDrag.current, to };
                        setDraggedRow(queueDrag.current);
                      }
                    }}
                    onPointerUp={(event) => {
                      if (!event.isPrimary) return;
                      const drag = queueDrag.current;
                      clearQueueDrag();
                      if (drag) moveQueueRow(drag.from, drag.to);
                    }}
                    onPointerCancel={clearQueueDrag}
                    onLostPointerCapture={clearQueueDrag}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                      event.preventDefault();
                      moveQueueRow(position, position + (event.key === "ArrowUp" ? -1 : 1));
                    }}
                  >
                    <Icon name="grip" size={18} />
                  </button>
                )}
                <button
                  className="session-queue-item"
                  disabled={!ready || !!error}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-label={`${position + 1}本目 ${video.title}を${resumePlaybackPosition ? "保存位置から" : "最初から"}再生`}
                  onClick={() => playFromQueue(position)}
                >
                  <span className="session-queue-number">{position + 1}</span>
                  <span className="queue-thumb-wrap">
                    <img className="queue-thumb" src={video.thumbnailUrl || `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`} alt="" loading="lazy" />
                    <span className="duration">{formatDuration(video.durationSeconds)}</span>
                  </span>
                  <span className="session-queue-details">
                    {video.title}
                    <small>
                      {video.channel}
                      {isCurrent ? complete ? "" : " · 再生中" : ` · 再生位置 ${formatDuration(savedPosition)}`}
                    </small>
                  </span>
                </button>
                {onQueueEdit && (
                  <button
                    className="icon-button session-queue-edit"
                    aria-label={`${video.title}を再生中のキューから削除`}
                    disabled={!ready || !!error}
                    onClick={() => {
                      if (window.confirm(`「${video.title}」を再生中のキューから削除しますか？`))
                        editQueue(videos.filter((item) => item.id !== video.id));
                    }}
                  >
                    <Icon name="close" size={17} />
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
