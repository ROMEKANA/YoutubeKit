import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type { Video } from "./model";
import { PlaylistTracker } from "./playback";
import { loadYouTubeApi } from "./youtube";

interface Props {
  videos: Video[];
  onClose: () => void;
  testMode?: boolean;
  ref?: Ref<PlayerHandle>;
}

export interface PlayerHandle {
  togglePlayback: () => "playing" | "paused" | null;
}

// 再生開始時のキューを固定し、一覧や保存キューの編集で再生順序を変えない。
export function Player({ videos, onClose, testMode = false, ref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YT.Player | null>(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState("YouTubeプレーヤーを読み込んでいます…");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [complete, setComplete] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const tracker = useRef(new PlaylistTracker(videos.length));

  // 推測した状態ではなく公式プレーヤーの現在状態で切り替え、完了後は再開しない。
  useImperativeHandle(
    ref,
    () => ({
      togglePlayback() {
        const instance = player.current;
        if (!instance || !ready || complete || error) return null;
        const state = instance.getPlayerState();
        if (state === 0) return null;
        if (state === 1 || state === 3) {
          instance.pauseVideo();
          return "paused";
        }
        instance.playVideo();
        return "playing";
      },
    }),
    [ready, complete, error],
  );

  useEffect(() => {
    let disposed = false;
    let instance: YT.Player | undefined;
    let readyTimer: number | undefined;
    let playerReady = false;
    tracker.current = new PlaylistTracker(videos.length);
    setReady(false);
    setComplete(false);
    setError("");
    setIndex(0);
    setStatus("YouTubeプレーヤーを読み込んでいます…");
    const pauseWhenHidden = () => {
      if (document.hidden && playerReady) {
        instance?.pauseVideo?.();
        setStatus("画面に戻ったら「再開」を押してください。");
      }
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);

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
              setStatus(
                "再生を開始します。始まらない場合は「再開」を押してください。",
              );
              event.target.setLoop(false);
              if (document.hidden)
                event.target.cuePlaylist(
                  videos.map((video) => video.id),
                  0,
                  0,
                );
              else
                event.target.loadPlaylist(
                  videos.map((video) => video.id),
                  0,
                  0,
                );
            },
            onStateChange: (event) => {
              if (disposed) return;
              const current = event.target.getPlaylistIndex();
              const action = tracker.current.observe(event.data, current);
              if (action === "playing") {
                setIndex(current);
                setError("");
                setStatus("再生中");
                if (document.hidden) event.target.pauseVideo();
              } else if (action === "complete") {
                setComplete(true);
                setStatus("選んだ動画の再生が終わりました。");
                event.target.pauseVideo();
              } else if (event.data === 2) setStatus("一時停止中");
              else if (event.data === 3) setStatus("動画を読み込んでいます…");
            },
            onAutoplayBlocked: () => {
              if (!disposed)
                setStatus(
                  "自動再生が制限されました。「再開」を押してください。",
                );
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
      document.removeEventListener("visibilitychange", pauseWhenHidden);
      instance?.destroy();
      player.current = null;
    };
  }, [videos, attempt]);

  // 利用者が選んだキュー位置を先頭から再生し、完了後なら終了判定も新しく始める。
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
    if (complete) {
      tracker.current = new PlaylistTracker(videos.length);
      setComplete(false);
    }
    setIndex(position);
    setStatus(`${position + 1}本目を最初から再生します…`);
    instance.playVideoAt(position);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const current = videos[index];
  return (
    <section className="playback-view">
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
      </div>
      <div className="session-queue">
        <h2>今回の再生キュー</h2>
        <p className="muted">
          {complete
            ? "おつかれさまでした。動画を押すと、その位置からもう一度再生できます。"
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
                aria-label={`${position + 1}本目 ${video.title}を最初から再生`}
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
