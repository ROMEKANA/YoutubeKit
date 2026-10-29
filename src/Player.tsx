import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { Icon } from "./Icon";
import type { Video } from "./model";
import { PlaylistTracker } from "./playback";
import { loadYouTubeApi } from "./youtube";

interface Props {
  videos: Video[];
  playbackPositions: Record<string, number>;
  saveIntervalSeconds: number;
  resumePlaybackPosition: boolean;
  active: boolean;
  onClose: () => void;
  onPlaybackProgress?: (videoId: string, positionSeconds: number) => void;
  onSaveQueue?: () => void;
  testMode?: boolean;
  ref?: Ref<PlayerHandle>;
}

export interface PlayerHandle {
  startAt: (position: number, positionSeconds: number) => boolean;
  endSession: () => void;
  togglePlayback: () => "playing" | "paused" | null;
  seekBy: (seconds: number) => boolean;
}

// 再生開始時のキューを固定し、一覧や保存キューの編集で再生順序を変えない。
export function Player({
  videos,
  playbackPositions,
  saveIntervalSeconds,
  resumePlaybackPosition,
  active,
  onClose,
  onPlaybackProgress,
  onSaveQueue,
  testMode = false,
  ref,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YT.Player | null>(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState("YouTubeプレーヤーを読み込んでいます…");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [complete, setComplete] = useState(false);
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
  const onPlaybackProgressRef = useRef(onPlaybackProgress);
  videosRef.current = videos;
  playbackPositionsRef.current = playbackPositions;
  saveIntervalSecondsRef.current = saveIntervalSeconds;
  resumePlaybackPositionRef.current = resumePlaybackPosition;
  onPlaybackProgressRef.current = onPlaybackProgress;

  function persistPlaybackSample(sample: {
    videoId: string;
    positionSeconds: number;
  }) {
    lastPositionSavedAt.current = Date.now();
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

  // 終了イベント時にプレーヤー番号が次へ変わっていても、実際に終了した動画だけを消去する。
  function clearCompletedPlayback(position: number) {
    const video = videosRef.current[position];
    if (!video) return;
    const sample = { videoId: video.id, positionSeconds: 0 };
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
    const seconds =
      requestedSeconds ?? playbackPositionsRef.current[video.id] ?? 0;
    if (seconds <= 0) return false;
    tracker.current.observe(1, current);
    setIndex(current);
    setStatus(`${current + 1}本目の続きへ移動しています…`);
    persistPlaybackSample({
      videoId: video.id,
      positionSeconds: Math.floor(seconds),
    });
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
    if (!instance || !ready || complete || error) return null;
    const state = instance.getPlayerState();
    if (state === 0) return null;
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
    queueReady.current = false;
    startRequested.current = null;
    pendingSeek.current = null;
    resumeCheckedVideoId.current = null;
    lastPlaylistIndex.current = -1;
    lastPlayingIndex.current = -1;
    lastPlaybackSample.current = null;
    lastPositionSavedAt.current = 0;
    tracker.current = new PlaylistTracker(videos.length);
    setReady(false);
    setPlaying(false);
    setComplete(false);
    setError("");
    setIndex(0);
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
          width: "100%",
          height: "100%",
          playerVars: {
            playsinline: 1,
            controls: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (event) => {
              if (disposed) return;
              playerReady = true;
              window.clearTimeout(readyTimer);
              readyTimer = undefined;
              setError("");
              setReady(true);
              setStatus("再生キューを準備しています…");
              event.target.setLoop(false);
              event.target.cuePlaylist(
                videos.map((video) => video.id),
                0,
                0,
              );
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
              if (event.data === 1) {
                lastPlayingIndex.current = current;
                setPlaying(true);
                samplePlaybackProgress(event.target);
                const pending = pendingSeek.current;
                pendingSeek.current = null;
                const requestedSeconds =
                  pending?.position === current
                    ? pending.positionSeconds
                    : undefined;
                if (
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
              if (event.data === 0) clearCompletedPlayback(actionIndex);
              const action = tracker.current.observe(event.data, actionIndex);
              if (action === "playing") {
                setIndex(current);
                persistCurrentPlayback(event.target);
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
            onAutoplayBlocked: () => {
              if (!disposed) {
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
      instance?.destroy();
      player.current = null;
    };
  }, [videos, attempt]);

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
    if (!instance || !ready || complete || error) return false;
    const currentTime = instance.getCurrentTime();
    const duration = instance.getDuration();
    const upperLimit = duration > 0 ? duration : currentTime + seconds;
    const nextTime = Math.max(0, Math.min(currentTime + seconds, upperLimit));
    instance.seekTo(nextTime, true);
    samplePlaybackProgress(instance, nextTime);
    setStatus(seconds < 0 ? "10秒戻しました。" : "10秒進めました。");
    return true;
  }

  const current = videos[index];
  return (
    <section
      className={`playback-view ${active ? "" : "player-preparing"}`.trim()}
      aria-hidden={!active}
      inert={!active}
    >
      <button className="text-button back" onClick={onClose}>
        ← 動画一覧に戻る
      </button>
      <div className="section-heading">
        <div>
          <p className="eyebrow">NOW WATCHING</p>
          <h1>選んだ分だけ観れるサイト</h1>
        </div>
        <span className="tag">
          {index + 1} / {videos.length} 本
        </span>
      </div>
      <div className="player-shell" ref={host} />
      <div className="player-transport" aria-label="動画の再生操作">
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
          disabled={!ready || complete || !!error}
          onClick={() => seekPlayerBy(-10)}
        >
          <Icon name="back-10" />
        </button>
        <button
          className="icon-button player-control-button"
          aria-label={playing ? "一時停止" : "再生"}
          title={playing ? "一時停止" : "再生"}
          disabled={!ready || complete || !!error}
          onClick={togglePlayerPlayback}
        >
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <button
          className="icon-button player-control-button"
          aria-label="10秒進む"
          title="10秒進む"
          disabled={!ready || complete || !!error}
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
      <div className="player-status" role="status">
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
            先頭から再接続
          </button>
        )}
        <button className="secondary" onClick={onClose}>
          キュー再生を終了
        </button>
        {onSaveQueue && (
          <button
            className="secondary save-playing-queue"
            onClick={() => {
              const instance = player.current;
              if (instance) persistCurrentPlayback(instance);
              onSaveQueue();
            }}
          >
            このキューを保存
          </button>
        )}
      </div>
      <div className="session-queue">
        <h2>今回の再生キュー</h2>
        <p className="muted">
          {complete
            ? resumePlaybackPosition
              ? "おつかれさまでした。動画を押すと、保存位置からもう一度再生できます。"
              : "おつかれさまでした。動画を押すと、最初からもう一度再生できます。"
            : resumePlaybackPosition
              ? "動画を押すと、その動画の保存位置から再生します。最後の動画で終了します。"
              : "動画を押すと、その動画を最初から再生します。最後の動画で終了します。"}
        </p>
        <ol>
          {videos.map((video, position) => (
            <li
              key={video.id}
              className={position === index ? "current" : ""}
            >
              <button
                className="session-queue-item"
                disabled={!ready || !!error}
                aria-current={position === index ? "true" : undefined}
                aria-label={`${position + 1}本目 ${video.title}を${resumePlaybackPosition ? "保存位置から" : "最初から"}再生`}
                onClick={() => playFromQueue(position)}
              >
                <span>{String(position + 1).padStart(2, "0")}</span>
                <div>
                  {video.title}
                  <small>
                    {position === index
                      ? "現在の動画"
                      : position === index + 1
                        ? "次の動画"
                        : video.channel}
                  </small>
                </div>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
