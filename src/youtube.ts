let apiPromise: Promise<typeof YT> | undefined;

declare global {
  interface Window {
    YT?: typeof YT;
    onYouTubeIframeAPIReady?: () => void;
  }
}

// 再生画面を開いたときだけAPIを読み込み、失敗時は再試行できるようにする。
export function loadYouTubeApi(): Promise<typeof YT> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => fail(), 15000);
    const previous = window.onYouTubeIframeAPIReady;
    const fail = () => {
      window.clearTimeout(timer);
      script.remove();
      window.onYouTubeIframeAPIReady = previous;
      apiPromise = undefined;
      reject(
        new Error(
          "YouTubeに接続できませんでした。通信状況を確認して再試行してください。",
        ),
      );
    };
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer);
      previous?.();
      if (window.YT?.Player) resolve(window.YT);
      else fail();
    };
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = fail;
    document.head.append(script);
  });
  return apiPromise;
}
