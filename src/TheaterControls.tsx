import { useEffect, useRef, useState, type RefObject } from "react";
import { createTheaterGestures } from "./theaterGestures";

// 映像を隠さない透明な操作面で、利用者が解除するまで誤タップを防ぐ。
export function TheaterControls({
  onTogglePlayback,
  onSeek,
  onExit,
  exitButton,
}: {
  onTogglePlayback: () => "playing" | "paused" | null;
  onSeek: (seconds: number) => boolean;
  onExit: () => void;
  exitButton: RefObject<HTMLButtonElement | null>;
}) {
  const callbacks = useRef({ onTogglePlayback, onSeek, onExit });
  callbacks.current = { onTogglePlayback, onSeek, onExit };
  const exitTap = useRef<{
    id: number;
    x: number;
    y: number;
    time: number;
  } | null>(null);
  const hitsExit = (x: number, y: number) => {
    const rect = exitButton.current?.getBoundingClientRect();
    return (
      !!rect &&
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom
    );
  };
  const [message, setMessage] = useState("");
  const [wakeMessage, setWakeMessage] = useState(
    "画面の自動ロック防止を確認しています…",
  );
  const [gestures] = useState(() =>
    createTheaterGestures(
      () => {
        const state = callbacks.current.onTogglePlayback();
        setMessage(
          state === "paused"
            ? "一時停止しました。"
            : state === "playing"
              ? "再生を再開します。"
              : "現在は再生を切り替えられません。",
        );
      },
      () => callbacks.current.onExit(),
      (seconds) => {
        setMessage(
          callbacks.current.onSeek(seconds)
            ? seconds < 0
              ? "10秒戻しました。"
              : "10秒進めました。"
            : "現在は再生位置を変更できません。",
        );
      },
    ),
  );
  const pad = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // メタタグに加え、背景色を参照するSafari向けにも黒を指定する。
    const originals = [
      ["theme-color", "#000000"],
      ["apple-mobile-web-app-status-bar-style", "black-translucent"],
    ].map(([name, color]) => {
      const meta = document.querySelector<HTMLMetaElement>(
        `meta[name="${name}"]`,
      );
      const content = meta?.getAttribute("content") ?? null;
      meta?.setAttribute("content", color);
      return { meta, content };
    });
    const backgrounds = [document.documentElement, document.body].map(
      (element) => {
        const value = element.style.getPropertyValue("background-color");
        const priority = element.style.getPropertyPriority("background-color");
        element.style.setProperty("background-color", "#000000");
        return { element, value, priority };
      },
    );
    return () => {
      for (const { meta, content } of originals) {
        if (content === null) meta?.removeAttribute("content");
        else meta?.setAttribute("content", content);
      }
      for (const { element, value, priority } of backgrounds) {
        if (value)
          element.style.setProperty("background-color", value, priority);
        else element.style.removeProperty("background-color");
      }
    };
  }, []);
  useEffect(() => {
    pad.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    let disposed = false;
    let lock: WakeLockSentinel | undefined;
    // 正規のWake Lockが使えない場合は、ロック防止を保証せず状態を表示する。
    void (async () => {
      try {
        if (!("wakeLock" in navigator)) throw new Error("unsupported");
        lock = await navigator.wakeLock.request("screen");
        if (disposed) {
          await lock.release();
          return;
        }
        setWakeMessage("画面の自動ロックを防止中");
        lock.addEventListener("release", () => {
          if (!disposed)
            setWakeMessage(
              "自動ロック防止が解除されました。必要ならモードを入り直してください。",
            );
        });
      } catch {
        if (!disposed)
          setWakeMessage(
            "自動ロック防止を利用できません。端末の設定によって画面がロックされます。",
          );
      }
    })();
    return () => {
      disposed = true;
      gestures.dispose();
      document.body.style.overflow = overflow;
      void lock?.release().catch(() => {});
    };
  }, [gestures]);
  return (
    <div
      ref={pad}
      className="theater-shield"
      role="button"
      tabIndex={0}
      aria-label={`左スワイプで10秒戻し、右スワイプで10秒進む。トリプルタップで再生・一時停止を切り替え、シアターボタンの位置をタップまたは3秒長押しで解除。キーボードではEscapeまたはEnterで解除。${wakeMessage} ${message}`}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Tab") event.preventDefault();
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          onExit();
        }
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        if (event.pointerType === "mouse" && event.button !== 0) return;
        exitTap.current =
          event.isPrimary && hitsExit(event.clientX, event.clientY)
            ? {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                time: Date.now(),
              }
            : null;
        event.currentTarget.setPointerCapture(event.pointerId);
        gestures.down(event.pointerId, event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        const tap = exitTap.current;
        if (
          tap &&
          Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12
        )
          exitTap.current = null;
        gestures.move(event.pointerId, event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const tap = exitTap.current;
        exitTap.current = null;
        if (
          tap?.id === event.pointerId &&
          Date.now() - tap.time <= 350 &&
          hitsExit(event.clientX, event.clientY)
        ) {
          gestures.cancel(event.pointerId);
          onExit();
        } else gestures.up(event.pointerId, event.clientX, event.clientY);
      }}
      onPointerCancel={(event) => {
        exitTap.current = null;
        gestures.cancel(event.pointerId);
      }}
    />
  );
}
