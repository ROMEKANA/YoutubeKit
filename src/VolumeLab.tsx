import { useEffect, useRef, useState } from "react";
import { version } from "../package.json";
import { loadYouTubeApi } from "./youtube";
import "./layoutLab.css";

const reportKey = "youtubekit.volume-diagnostic-report";
const methods = [
  "A：再生中にAPIで変更",
  "B：一時停止中にAPIで変更",
  "C：ミュート中にAPIで変更",
  "D：コントロールセンター",
  "E：ショートカットで数値指定",
];

// 通常のPlayer・キュー・設定から分離し、APIの返値と実際の聞こえ方を別々に記録する。
export function VolumeLab() {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YT.Player | null>(null);
  const history = useRef<unknown[]>([]);
  const [run, setRun] = useState(0);
  const [input, setInput] = useState("aqz-KE-bpKQ");
  const [videoId, setVideoId] = useState("");
  const [ready, setReady] = useState(false);
  const [method, setMethod] = useState(methods[0]);
  const [volume, setVolume] = useState(100);
  const [environment, setEnvironment] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");
  const [reading, setReading] = useState("");
  const [records, setRecords] = useState<unknown[]>([]);
  const [report, setReport] = useState("");

  function snapshot(instance: YT.Player) {
    return {
      volume: instance.getVolume(),
      muted: instance.isMuted(),
      state: instance.getPlayerState(),
      seconds: instance.getCurrentTime(),
    };
  }

  function log(action: string) {
    history.current.push({
      at: new Date().toISOString(),
      action,
      ...(player.current && ready ? snapshot(player.current) : {}),
    });
    if (history.current.length > 120) history.current.shift();
  }

  useEffect(() => {
    if (!videoId || !host.current) return;
    let disposed = false;
    let instance: YT.Player | undefined;
    let timer: number | undefined;
    const mount = document.createElement("div");
    host.current.replaceChildren(mount);
    const timeout = window.setTimeout(() => {
      if (!disposed)
        setStatus(
          "読み込みに時間がかかっています。通信を確認して「準備・やり直し」を押してください。",
        );
    }, 20000);
    loadYouTubeApi()
      .then((api) => {
        if (disposed) return;
        instance = new api.Player(mount, {
          width: "100%",
          height: 240,
          videoId,
          playerVars: {
            playsinline: 1,
            controls: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (event) => {
              if (disposed) return;
              window.clearTimeout(timeout);
              player.current = event.target;
              event.target.setVolume(100);
              setReady(true);
              setStatus(
                "準備できました。端末音量を小さくしてから、動画内の再生ボタンを押してください。",
              );
              timer = window.setInterval(() => {
                if (disposed || !instance) return;
                const value = snapshot(instance);
                setReading(JSON.stringify(value));
              }, 500);
            },
            onError: (event) => {
              if (!disposed)
                setStatus(
                  `YouTubeエラー ${event.data}。別の動画IDで準備し直してください。`,
                );
            },
            onStateChange: (event) => {
              if (disposed) return;
              history.current.push({
                at: new Date().toISOString(),
                state: event.data,
              });
              if (history.current.length > 120) history.current.shift();
            },
            onAutoplayBlocked: () => {
              if (!disposed)
                setStatus(
                  "再開が止められました。動画内の再生ボタンを押してください。",
                );
            },
          },
        });
      })
      .catch(() => {
        if (!disposed)
          setStatus(
            "YouTubeに接続できません。「準備・やり直し」で再試行してください。",
          );
      });
    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      window.clearInterval(timer);
      player.current = null;
      instance?.destroy();
    };
  }, [videoId, run]);

  function prepare() {
    let id = input.trim();
    if (!/^[\w-]{11}$/.test(id)) {
      try {
        const url = new URL(id);
        id =
          url.hostname === "youtu.be"
            ? url.pathname.slice(1).split("/")[0]
            : ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(
                  url.hostname,
                )
              ? (url.searchParams.get("v") ??
                url.pathname.match(/^\/(?:embed|shorts)\/([\w-]{11})/)?.[1] ??
                "")
              : "";
      } catch {
        id = "";
      }
    }
    if (!/^[\w-]{11}$/.test(id)) {
      setStatus("YouTube動画のURLか11文字の動画IDを入力してください。");
      return;
    }
    setReady(false);
    setReading("");
    setVolume(100);
    history.current = [];
    setVideoId(id);
    setRun((value) => value + 1);
    setStatus("読み込み中…");
  }

  function command(action: string, operation: (instance: YT.Player) => void) {
    if (!ready || !player.current) return;
    log(`${method} / ${action}`);
    operation(player.current);
    setStatus(
      `${action}を要求しました。API返値は下に表示します。実際の音量は耳で確認してください。`,
    );
  }

  function apply(value: number) {
    setVolume(value);
    command(`setVolume(${value})`, (instance) => instance.setVolume(value));
  }

  function record(result: string) {
    if (!ready || !player.current) return;
    const entry = {
      at: new Date().toISOString(),
      version,
      environment,
      userAgent: navigator.userAgent,
      mode:
        window.matchMedia("(display-mode: standalone)").matches ||
        ("standalone" in navigator && navigator.standalone === true)
          ? "PWA"
          : "ブラウザ",
      videoId,
      method,
      requestedVolume: volume,
      reported: snapshot(player.current),
      result,
      note,
      history: [...history.current],
    };
    const next = [...records, entry];
    const text = JSON.stringify(
      {
        observations: next,
        limitation:
          "API返値は実音量の証明ではありません。端末音量は取得していません。",
      },
      null,
      2,
    );
    setRecords(next);
    setReport(text);
    try {
      localStorage.setItem(reportKey, text);
      setStatus("聞こえ方を保存しました。");
    } catch {
      setStatus(
        "ブラウザに保存できません。閉じる前に結果をコピーしてください。",
      );
    }
  }

  return (
    <div className="app-shell">
      <header className="header">
        <div className="header-inner">
          <a className="brand" href="/">
            YoutubeKit
          </a>
          <span>音量の比較 v{version}</span>
        </div>
      </header>
      <main className="main">
        <section className="layout-lab-controls">
          <h1>iPhoneで音量を細かく変えられるか比較</h1>
          <p>
            まず端末音量を小さくしてください。A〜Cでは端末音量を固定し、同じ動画の同じ箇所で100%
            → 20% →
            5%を比較します。100%は増幅なしの基準で、端末の最大音量を超える機能ではありません。
          </p>
          <label>
            実機・出力先
            <input
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
              placeholder="例：iPhone / iOSの版 / 本体スピーカー・イヤホン"
            />
          </label>
          <label>
            動画URLまたはID
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          <button className="primary" onClick={prepare}>
            準備・やり直し（API音量100%）
          </button>
          <div ref={host} style={{ minHeight: videoId ? 240 : 0 }} />
          <p>
            動画内の再生・シーク操作を使えます。比較する箇所を毎回そろえ、広告中は判定しないでください。
          </p>
          <label>
            比較方法
            <select
              value={method}
              onChange={(event) => {
                setMethod(event.target.value);
                setNote("");
              }}
            >
              {methods.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <p>
            方法を選んだだけでは音量・再生状態は変わりません。前の条件でミュート・停止した場合は、解除・再開してください。
          </p>
          {method === methods[0] && (
            <p>A：再生中に下の音量ボタンを押します。</p>
          )}
          {method === methods[1] && (
            <p>
              B：「一時停止」→ 停止を確認 → 音量を変更 →「再開」の順で試します。
            </p>
          )}
          {method === methods[2] && (
            <p>
              C：「ミュート」→ 無音を確認 → 音量を変更
              →「ミュート解除」の順で試します。
            </p>
          )}
          {method === methods[3] && (
            <p>
              D：API音量を100%に戻し、iPhoneのコントロールセンターを開いて音量スライダーを細かく動かします。物理ボタンの隣り合う段階の間や、小さい音量を作れるか比較してください。端末共通の音量が変わります。
            </p>
          )}
          {method === methods[4] && (
            <div>
              <p>
                E：iPhoneの「ショートカット」で「音量を設定」アクションを追加し、対象をメディアにして、まず5%で試します。必要に応じて1・2・3・10%へ変更して実行し、YouTubeKitへ戻ります。API音量は100%に戻してください。
              </p>
              <p>
                端末共通の音量が変わります。アプリ切替で停止したら再開してください。指定値どおりの細かさになるか、最小音量が改善するかは実機で判断します。検証後は端末音量を普段の値へ戻してください。
              </p>
            </div>
          )}
          <div className="layout-lab-actions">
            <button
              className="secondary"
              disabled={!ready}
              onClick={() => command("一時停止", (p) => p.pauseVideo())}
            >
              一時停止
            </button>
            <button
              className="secondary"
              disabled={!ready}
              onClick={() => command("再開", (p) => p.playVideo())}
            >
              再開
            </button>
            <button
              className="secondary"
              disabled={!ready}
              onClick={() => command("ミュート", (p) => p.mute())}
            >
              ミュート
            </button>
            <button
              className="secondary"
              disabled={!ready}
              onClick={() => command("ミュート解除", (p) => p.unMute())}
            >
              ミュート解除
            </button>
          </div>
          <label>
            APIへ指定：{volume}%（端末音量ではありません）
            <input
              type="range"
              min="1"
              max="100"
              step="1"
              value={volume}
              disabled={!ready}
              onChange={(event) => apply(Number(event.target.value))}
            />
          </label>
          <div className="layout-lab-actions">
            {[1, 5, 10, 20, 50, 100].map((value) => (
              <button
                className="secondary"
                key={value}
                disabled={!ready}
                onClick={() => apply(value)}
              >
                {value}%
              </button>
            ))}
          </div>
          <p>
            API返値（音量・ミュート・再生状態・秒）：{reading || "未準備"}
            。再生状態は1＝再生、2＝停止、3＝読み込みです。数値が変わっても音量が変わるとは限りません。
          </p>
          <label>
            聞こえ方・端末音量の変更内容
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例：100%と5%で音量差なし。ショートカット3%なら最小ボタン段階より小さくできた。"
            />
          </label>
          <div className="layout-lab-actions">
            {[
              "細かく調整できた",
              "音量差なし",
              "無音になった",
              "判定できない",
            ].map((result) => (
              <button
                className="secondary"
                key={result}
                disabled={!ready}
                onClick={() => record(result)}
              >
                {result}を記録
              </button>
            ))}
          </div>
          <p role="status">{status}</p>
          <p>
            記録：{records.length}
            件。Safariとホーム画面PWA、本体スピーカーと普段使うイヤホンは別々に記録してください。
          </p>
          <button
            className="primary"
            disabled={!report}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(report);
                setStatus(
                  "結果をコピーしました。このチャットへ貼り付けてください。",
                );
              } catch {
                setStatus("下の結果欄を選択してコピーしてください。");
              }
            }}
          >
            結果をコピー
          </button>
          <button
            className="secondary"
            onClick={() => {
              try {
                const saved = localStorage.getItem(reportKey);
                if (!saved) {
                  setStatus("保存結果はありません。");
                  return;
                }
                const data = JSON.parse(saved);
                if (!Array.isArray(data.observations)) throw new Error();
                setRecords(data.observations);
                setReport(saved);
                setStatus("保存結果を読み込みました。");
              } catch {
                setStatus("保存結果を読み込めません。");
              }
            }}
          >
            前回の結果を読み込む
          </button>
          <details>
            <summary>コピー用の結果</summary>
            <textarea
              className="layout-lab-report"
              readOnly
              value={report}
              onFocus={(event) => event.currentTarget.select()}
            />
          </details>
          <p>
            結果だけをこのブラウザへ保存します。通常のキュー・設定やクラウド同期には反映しません。準備時のAPI音量は毎回100%です。
          </p>
          <details>
            <summary>ほかの方法を使えるか</summary>
            <p>
              Web
              AudioのGainNodeは自分で管理する音源には使えますが、YouTubeの別オリジンiframe内の音声を接続する公開APIはありません。昔のネイティブアプリで内部AVPlayerを操作する先行例も、Safari/PWAでは使えません。YouTube標準の「一定音量」は音量差を抑える機能で、自由な音量倍率の指定とは異なります。
            </p>
          </details>
          <p>
            <a href="/?lab=layout">表示ずれの比較画面</a> /{" "}
            <a href="/">通常画面へ戻る</a>
          </p>
        </section>
      </main>
    </div>
  );
}
