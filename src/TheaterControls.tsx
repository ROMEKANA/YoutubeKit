import { useEffect, useRef, useState } from "react";
import { createTheaterGestures } from "./theaterGestures";

// 映像を隠さない透明な操作面で、利用者が解除するまで誤タップを防ぐ。
export function TheaterControls({
  onPause,
  onExit,
}: {
  onPause: () => void;
  onExit: () => void;
}) {
  const callbacks = useRef({ onPause, onExit });
  callbacks.current = { onPause, onExit };
  const [message, setMessage] = useState("");
  const [wakeMessage, setWakeMessage] = useState(
    "画面の自動ロック防止を確認しています…",
  );
  const [gestures] = useState(() =>
    createTheaterGestures(
      () => {
        callbacks.current.onPause();
        setMessage("一時停止しました。3秒長押しで解除して再開できます。");
      },
      () => callbacks.current.onExit(),
    ),
  );
  const pad = useRef<HTMLDivElement>(null);
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
      aria-label={`トリプルタップで一時停止、3秒長押しでシアターモードを解除。キーボードではEscapeまたはEnterで解除。${wakeMessage} ${message}`}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Tab") event.preventDefault();
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          onExit();
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        gestures.down(event.pointerId, event.clientX, event.clientY);
      }}
      onPointerMove={(event) =>
        gestures.move(event.pointerId, event.clientX, event.clientY)
      }
      onPointerUp={(event) => gestures.up(event.pointerId)}
      onPointerCancel={(event) => gestures.cancel(event.pointerId)}
    />
  );
}
