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
import { getQueueEditStart, PlaylistTracker, type QueueEditStart } from "./playback";
import { loadYouTubeApi } from "./youtube";

interface Props {
  videos: Video[];
  playbackPositions: Record<string, number>;
  saveIntervalSeconds: number;
  resumePlaybackPosition: boolean;
  restartNearEndSeconds?: number;
  active: boolean;
  onClose: () => void;
  onPlaybackProgress?: (videoId: string, positionSeconds: number) => void;
  onCompleteChange?: (complete: boolean) => void;
  onVideoPlaying?: (video: Video) => void;
  onSaveQueue?: () => void;
  onQueueEdit?: (videos: Video[], start: QueueEditStart) => void;
  queueEditStart?: QueueEditStart;
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
  startAt: (position: number, positionSeconds: number) => boolean;
  endSession: () => void;
  togglePlayback: () => "playing" | "paused" | null;
  seekBy: (seconds: number) => boolean;
}

// 再生順はセッションで管理し、再生画面の編集操作でだけ更新する。
export function Player({
  videos,
  playbackPositions,
  saveIntervalSeconds,
  resumePlaybackPosition,
  restartNearEndSeconds = 10,
  active,
  onClose,
  onPlaybackProgress,
  onCompleteChange,
  onVideoPlaying,
  onSaveQueue,
  onQueueEdit,
  queueEditStart,
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
  const [index, setIndex] = useState(0);
  const [queueDisplay, setQueueDisplay] = useState<{
    videoId: string;
    positions: Record<string, number>;
  } | null>(null);
  const displayedVideoId = useRef<string | null>(null);
  const queueDrag = useRef<{ from: number; to: number } | null>(null);
  const [draggedRow, setDraggedRow] = useState<{ from: number; to: number } | null>(null);
  const lastQueueEditStart = useRef<QueueEditStart | undefined>(undefined);
  const restoreAfterEdit = useRef<QueueEditStart | null>(null);
  const recordedQueuePositions = useRef<Record<string, number>>({});
  const [status, setStatus] = useState("YouTubeプレーヤーを読み込んでいます…");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [complete, setComplete] = useState(false);
  // キュー完了と再開をシアターの自動ロック防止へ伝える。
  useEffect(() => {
    onCompleteChange?.(complete);
  }, [complete, onCompleteChange]);
  const [attempt, setAttempt] = useState(0);
  const tracker = useRef(new PlaylistTracker(videos.length));
  const queueReady = useRef(false);
  const startRequested = useRef<{
    position: number;
    positionSeconds: number;
  } | null>(null);
  const pendingSeek = useRef<{
    position: number;
    positionSeconds: number;
  } | null>(null);
  const resumeCheckedVideoId = useRef<string | null>(null);
  const lastPlaylistIndex = useRef(-1);
  const lastPlayingIndex = useRef(-1);
  const lastPlaybackSample = useRef<{
    videoId: string;
    positionSeconds: number;
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
  }) {
    lastPositionSavedAt.current = Date.now();
    recordedQueuePositions.current[sample.videoId] = sample.positionSeconds;
    onPlaybackProgressRef.current?.(sample.videoId, sample.positionSeconds);
  }

  // 間隔保存が有効な時は位置をメモリ上でも観測し、動画切替時に直前の位置を保存する。
  function samplePlaybackProgress(
    instance: YT.Player,
    positionSeconds?: number,
  ) {
    const current = instance.getPlaylistIndex();
    const video = videosRef.current[current];
    const seconds = positionSeconds ?? instance.getCurrentTime();
    if (!video || !Number.isFinite(seconds) || seconds < 0) return null;
    const sample = {
      videoId: video.id,
      positionSeconds: Math.floor(seconds),
    };
    const previous = lastPlaybackSample.current;
    if (
      previous &&
      previous.videoId !== sample.videoId &&
      saveIntervalSecondsRef.current > 0
    )
      persistPlaybackSample(previous);
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
    const sample = { videoId: video.id, positionSeconds: Math.floor(video.durationSeconds) };
    lastPlaybackSample.current = sample;
    persistPlaybackSample(sample);
  }

  // すべての動画遷移をこの関数へ通し、設定がオンの時だけ保存位置へ移動する。
  function restoreCurrentVideoPosition(
    instance: YT.Player,
    current: number,
    requestedSeconds?: number,
  ): boolean {
    const video = videosRef.current[current];
    if (!video || resumeCheckedVideoId.current === video.id) return false;
    resumeCheckedVideoId.current = video.id;
    if (!resumePlaybackPositionRef.current) return false;
    const savedSeconds =
      requestedSeconds ?? playbackPositionsRef.current[video.id] ?? 0;
    const duration = instance.getDuration() || video.durationSeconds;
    const threshold = restartNearEndSecondsRef.current;
    const seconds = threshold > 0 && duration > 0 && duration - savedSeconds <= threshold
      ? 0
      : savedSeconds;
    if (savedSeconds <= 0) return false;
    tracker.current.observe(1, current);
    setIndex(current);
    setStatus(`${current + 1}本目の続きへ移動しています…`);
    instance.seekTo(seconds, true);
    return true;
  }

  function playRequestedPosition(
    instance: YT.Player,
    request: { position: number; positionSeconds: number },
  ) {
    startRequested.current = null;
    pendingSeek.current = request;
    resumeCheckedVideoId.current = null;
    tracker.current = new PlaylistTracker(videosRef.current.length);
    setComplete(false);
    setIndex(request.position);
    setStatus(`${request.position + 1}本目を再生します…`);
    instance.playVideoAt(request.position);
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
      instance.pauseVideo();
      setPlaying(false);
      return "paused";
    }
    instance.playVideo();
    setPlaying(true);
    return "playing";
  }

  // 推測した状態ではなく公式プレーヤーの現在状態で切り替え、完了後は再開しない。
  useImperativeHandle(
    ref,
    () => ({
      startAt(position, positionSeconds) {
        const startPosition =
          position >= 0 && position < videos.length ? position : 0;
        const startSeconds =
          Number.isFinite(positionSeconds) && positionSeconds > 0
            ? Math.floor(positionSeconds)
            : 0;
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
        startRequested.current = null;
        pendingSeek.current = null;
        resumeCheckedVideoId.current = null;
        const instance = player.current;
        if (instance) {
          persistCurrentPlayback(instance);
          instance.pauseVideo();
        }
        setPlaying(false);
        setStatus("キュー再生を終了しました。");
      },
      togglePlayback: togglePlayerPlayback,
      seekBy: seekPlayerBy,
    }),
    [ready, complete, error, videos.length],
  );

  useEffect(() => {
    let disposed = false;
    let instance: YT.Player | undefined;
    let readyTimer: number | undefined;
    let playerReady = false;
    // 再接続中は準備前のインスタンスへサイズ変更を送らない。
    playerSizeReady.current = false;
    playerSize.current = null;
    queueReady.current = false;
    startRequested.current = null;
    pendingSeek.current = null;
    resumeCheckedVideoId.current = null;
    videosRef.current = videos;
    // 再接続でも、まだ再開できていない編集直後の位置は維持する。
    const edit = queueEditStart === lastQueueEditStart.current
      ? restoreAfterEdit.current
      : queueEditStart ?? null;
    lastQueueEditStart.current = queueEditStart;
    restoreAfterEdit.current = edit;
    const editedIndex = edit ? videos.findIndex((video) => video.id === edit.videoId) : -1;
    lastPlaylistIndex.current = -1;
    lastPlayingIndex.current = -1;
    lastPlaybackSample.current = null;
    lastPositionSavedAt.current = 0;
    tracker.current = new PlaylistTracker(videos.length);
    setReady(false);
    setPlaying(false);
    setComplete(false);
    setError("");
    setIndex(Math.max(0, editedIndex));
    setStatus("YouTubeプレーヤーを読み込んでいます…");
    const handleVisibilityChange = () => {
      if (document.hidden && playerReady) {
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
              const ids = videos.map((video) => video.id);
              if (edit && editedIndex >= 0) {
                // 編集直前の位置は「途中から再生」設定や終端付近の補正を通さない。
                if (edit.autoplay && !document.hidden)
                  event.target.loadPlaylist(ids, editedIndex, edit.seconds);
                else
                  event.target.cuePlaylist(ids, editedIndex, edit.seconds);
              } else {
                event.target.cuePlaylist(ids, 0, 0);
              }
            },
            onStateChange: (event) => {
              if (disposed) return;
              if (event.data === 5) {
                setPlaying(false);
                queueReady.current = true;
                if (startRequested.current !== null && !document.hidden)
                  playRequestedPosition(event.target, startRequested.current);
                else setStatus("再生を開始できます。");
                return;
              }
              const current = event.target.getPlaylistIndex();
              if (current !== lastPlaylistIndex.current) {
                lastPlaylistIndex.current = current;
                resumeCheckedVideoId.current = null;
              }
              let restoredSeconds: number | undefined;
              if (event.data === 1) {
                queueReady.current = true;
                const video = videosRef.current[current];
                const restore = restoreAfterEdit.current;
                if (video && restore) {
                  restoreAfterEdit.current = null;
                  const actualSeconds = event.target.getCurrentTime();
                  if (video.id === restore.videoId &&
                      (!Number.isFinite(actualSeconds) || Math.abs(actualSeconds - restore.seconds) > 1)) {
                    event.target.seekTo(restore.seconds, true);
                    restoredSeconds = restore.seconds;
                  }
                }
                if (video) onVideoPlayingRef.current?.(video);
                if (complete) setComplete(false);
                lastPlayingIndex.current = current;
                setPlaying(true);
                samplePlaybackProgress(event.target, restoredSeconds);
                if (video) updateQueueDisplay(video.id);
                const pending = pendingSeek.current;
                pendingSeek.current = null;
                const requestedSeconds =
                  pending?.position === current
                    ? pending.positionSeconds
                    : undefined;
                // 埋め込み内の前・次には位置補正を適用しない。アプリ操作・自然終了だけが要求を作る。
                // 番号変化だけでの restoreCurrentVideoPosition 呼び出しは無効化。
                if (pending?.position === current &&
                  restoreCurrentVideoPosition(
                    event.target,
                    current,
                    requestedSeconds,
                  )
                )
                  return;
              }
              const actionIndex =
                event.data === 0 ? lastPlayingIndex.current : current;
              if (event.data === 0) {
                saveCompletedPlayback(actionIndex);
                const next = actionIndex + 1;
                if (next < videosRef.current.length) {
                  pendingSeek.current = {
                    position: next,
                    positionSeconds: playbackPositionsRef.current[videosRef.current[next].id] ?? 0,
                  };
                }
              }
              const action = tracker.current.observe(event.data, actionIndex);
              if (action === "playing") {
                setComplete(false);
                setIndex(current);
                persistCurrentPlayback(event.target, restoredSeconds);
                setError("");
                setStatus("再生中");
                if (document.hidden) event.target.pauseVideo();
              } else if (action === "complete") {
                setPlaying(false);
                setComplete(true);
                setStatus("選んだ動画の再生が終わりました。");
              } else if (event.data === 0) {
                setPlaying(false);
              } else if (event.data === 2) {
                if (saveIntervalSecondsRef.current > 0)
                  persistCurrentPlayback(event.target);
                setPlaying(false);
                setStatus("一時停止中");
              } else if (event.data === 3) setStatus("動画を読み込んでいます…");
            },
            onAutoplayBlocked: (event) => {
              if (!disposed) {
                const restore = restoreAfterEdit.current;
                if (restore && editedIndex >= 0)
                  event.target.cuePlaylist(videos.map((video) => video.id), editedIndex, restore.seconds);
                setPlaying(false);
                setStatus(
                  "自動再生が制限されました。「再開」を押してください。",
                );
              }
            },
            onError: (event) => {
              if (disposed) return;
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
      window.clearTimeout(readyTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      playerSizeReady.current = false;
      playerSize.current = null;
      instance?.destroy();
      player.current = null;
    };
  }, [videos, attempt, queueEditStart]);

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
    startRequested.current = null;
    restoreAfterEdit.current = null;
    pendingSeek.current = {
      position,
      positionSeconds:
        playbackPositionsRef.current[videos[position]?.id ?? ""] ?? 0,
    };
    resumeCheckedVideoId.current = null;
    if (complete) {
      tracker.current = new PlaylistTracker(videos.length);
      setComplete(false);
    }
    setIndex(position);
    setStatus(`${position + 1}本目を再生します…`);
    instance.playVideoAt(position);
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
    const currentTime = instance.getCurrentTime();
    const duration = instance.getDuration();
    const upperLimit = duration > 0 ? duration : currentTime + seconds;
    const nextTime = Math.max(0, Math.min(currentTime + seconds, upperLimit));
    instance.seekTo(nextTime, true);
    samplePlaybackProgress(instance, nextTime);
    setStatus(seconds < 0 ? "10秒戻しました。" : "10秒進めました。");
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
    const measured = restore?.videoId === videoId ? restore.seconds : instance.getCurrentTime();
    const seconds = Number.isFinite(measured) && measured >= 0
      ? measured
      : recordedQueuePositions.current[videoId] ?? playbackPositionsRef.current[videoId] ?? 0;
    const saved = getQueueEditStart(
      videos.map((video) => video.id),
      next.map((video) => video.id),
      { videoId, seconds, autoplay: state === 1 || state === 3 },
    );
    if (!saved) {
      onClose();
      return;
    }
    if (state === 1 || state === 2 || state === 3)
      persistPlaybackSample({ videoId, positionSeconds: Math.floor(seconds) });
    queueReady.current = false;
    setReady(false);
    setIndex(next.findIndex((video) => video.id === saved.videoId));
    onQueueEdit(next, saved);
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
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <h2 className="now-title">{current.title}</h2>
      <p className="muted">{current.channel}</p>
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
            onClick={() => player.current?.playVideo()}
          >
            再開
          </button>
        )}
        {error && (
          <button
            className="primary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {queueEditStart ? "再接続" : "先頭から再接続"}
          </button>
        )}
        <button className="secondary" onClick={onClose}>
          キュー再生を終了
        </button>
        {onSaveQueue && (
          <button
            className="secondary save-playing-queue"
            onClick={onSaveQueue}
          >
            このキューを保存
          </button>
        )}
      </div>
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
