import { useEffect, useRef, useState } from "react";

// アプリ本体の更新は動画一覧の更新と分離し、利用者が選んだ時だけ適用する。
export function usePwa() {
  const [online, setOnline] = useState(navigator.onLine);
  const [installed, setInstalled] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [message, setMessage] = useState("");
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const applying = useRef(false);
  const reloadReady = useRef(false);
  const enabled = import.meta.env.PROD && "serviceWorker" in navigator;

  useEffect(() => {
    let disposed = false;
    const network = () => setOnline(navigator.onLine);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    if (!enabled)
      return () => {
        window.removeEventListener("online", network);
        window.removeEventListener("offline", network);
      };
    let previous = navigator.serviceWorker.controller;
    const changed = () => {
      const current = navigator.serviceWorker.controller;
      if (previous && current !== previous) {
        if (applying.current) {
          window.location.reload();
          return;
        }
        // 別タブで新版が適用されても、このタブの再生や画面は継続する。
        reloadReady.current = true;
        setUpdateReady(true);
      }
      previous = current;
      setInstalled(!!current);
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    let removeUpdateListener = () => {};
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        if (disposed) return;
        registration.current = reg;
        setInstalled(!!reg.active);
        const waiting = () => {
          if (!disposed && reg.waiting && navigator.serviceWorker.controller)
            setUpdateReady(true);
        };
        const installing = () => {
          const worker = reg.installing;
          if (!worker) return;
          const state = () => {
            if (worker.state === "installed") waiting();
          };
          worker.addEventListener("statechange", state);
          const previousRemove = removeUpdateListener;
          removeUpdateListener = () => {
            previousRemove();
            worker.removeEventListener("statechange", state);
          };
        };
        reg.addEventListener("updatefound", installing);
        removeUpdateListener = () =>
          reg.removeEventListener("updatefound", installing);
        waiting();
        installing();
      })
      .catch(() => {
        if (!disposed)
          setMessage(
            "アプリの保存に失敗しました。通信を確認して開き直してください。",
          );
      });
    return () => {
      disposed = true;
      removeUpdateListener();
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
    };
  }, [enabled]);

  async function checkUpdate() {
    if (!registration.current) return;
    setMessage("");
    try {
      await registration.current.update();
    } catch {
      setMessage(
        "更新を確認できませんでした。通信を確認して再試行してください。",
      );
    }
  }

  function applyUpdate(playing: boolean) {
    if (playing || !online) return;
    if (reloadReady.current) {
      window.location.reload();
      return;
    }
    const worker = registration.current?.waiting;
    if (!worker) return;
    applying.current = true;
    worker.postMessage({ type: "APPLY_UPDATE" });
  }

  return {
    online,
    installed,
    updateReady,
    enabled,
    message,
    checkUpdate,
    applyUpdate,
  };
}

export type PwaController = ReturnType<typeof usePwa>;
