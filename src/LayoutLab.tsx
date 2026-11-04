import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { version } from "../package.json";
import {
  Player,
  type PlayerHandle,
  type PlayerLayoutDiagnostic,
} from "./Player";
import type { Video } from "./model";
import "./layoutLab.css";

const cases = [
  {
    id: "A",
    name: "現状の自動調整",
    description: "本体と同じ計算・幅100%・画面外で準備。比較の基準です。",
    sizing: "auto",
  },
  {
    id: "B",
    name: "開始時のサイズで固定",
    description: "Aと同じ初回計算の後、回転や操作バーへの追従だけを止めます。",
    sizing: "freeze",
  },
  {
    id: "C",
    name: "横幅に合わせる",
    description:
      "高さから横幅を縮める計算だけを外します。横画面で上下が画面外になる場合はスクロールしてください。",
    sizing: "width",
  },
  {
    id: "D",
    name: "iframeの幅を最小・最大幅で指定",
    description:
      "Aからiframeの幅指定だけ変更。幅0・最小幅100%・最大幅100%です。",
    sizing: "auto",
  },
  {
    id: "E",
    name: "iframeの幅をピクセルで指定",
    description:
      "Aからiframeの幅指定だけ変更。外枠と同じピクセル幅を直接指定します。",
    sizing: "auto",
  },
  {
    id: "F",
    name: "画面外で準備しない",
    description:
      "Aから画面外の200×200pxでの準備だけを外します。表示位置で読み込み、必要なら再開ボタンを押します。",
    sizing: "auto",
  },
  {
    id: "G",
    name: "角丸と切り抜きを外す",
    description:
      "Aから外枠の角丸・overflow:hiddenだけを外します。枠の外へ映像がはみ出すかも確認してください。",
    sizing: "auto",
  },
] as const;
type CaseId = (typeof cases)[number]["id"];
const samples: Video[] = [
  {
    id: "aqz-KE-bpKQ",
    title: "Big Buck Bunny",
    channelId: "blender",
    channel: "Blender Open Movies",
    publishedAt: "2008-05-30T00:00:00Z",
    durationSeconds: 596,
  },
];

// 画面外・内部DOMへ触れず、親ページから見える外枠とiframeの実寸だけを記録する。
function geometry(root: HTMLElement | null) {
  const rect = (element: Element | null | undefined) => {
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      cssWidth: style.width,
      minWidth: style.minWidth,
      maxWidth: style.maxWidth,
      overflow: style.overflow,
      widthAttribute: element.getAttribute("width"),
      heightAttribute: element.getAttribute("height"),
    };
  };
  const viewport = window.visualViewport;
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && navigator.standalone === true);
  return {
    orientation: window.innerWidth > window.innerHeight ? "横" : "縦",
    mode: standalone ? "PWA" : "ブラウザ",
    window: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      documentWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      dpr: window.devicePixelRatio,
    },
    visualViewport: viewport
      ? {
          width: viewport.width,
          height: viewport.height,
          scale: viewport.scale,
          offsetLeft: viewport.offsetLeft,
          offsetTop: viewport.offsetTop,
        }
      : null,
    shell: rect(root?.querySelector(".player-shell")),
    iframe: rect(root?.querySelector(".player-shell iframe")),
  };
}

// 比較条件と手動の見え方を組にし、結果が返ってきた後で原因候補を絞れるようにする。
export function LayoutLab() {
  const [choice, setChoice] = useState<CaseId>("A");
  const [trial, setTrial] = useState<{
    id: CaseId;
    run: number;
    videos: Video[];
  } | null>(null);
  const [videoInput, setVideoInput] = useState("");
  const [started, setStarted] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [environment, setEnvironment] = useState("iPhone 16e / iOS 26.7.1");
  const [note, setNote] = useState("");
  const [report, setReport] = useState("");
  const [status, setStatus] = useState("");
  const [records, setRecords] = useState<unknown[]>([]);
  const [preview, setPreview] = useState<ReturnType<typeof geometry> | null>(
    null,
  );
  const area = useRef<HTMLElement>(null);
  const player = useRef<PlayerHandle>(null);
  const events = useRef<unknown[]>([]);
  const began = useRef<ReturnType<typeof geometry> | null>(null);
  const configured = cases.find((item) => item.id === (trial?.id ?? choice))!;
  const selected = cases.find((item) => item.id === choice)!;
  const onLayout = useCallback((event: PlayerLayoutDiagnostic) => {
    events.current.push({ at: new Date().toISOString(), ...event });
    if (events.current.length > 120) events.current.shift();
  }, []);

  useEffect(() => {
    const update = () => setPreview(geometry(area.current));
    update();
    const timer = window.setInterval(update, 1000);
    const recordResize = () => {
      events.current.push({
        at: new Date().toISOString(),
        event: "viewport-resize",
        ...geometry(area.current),
      });
      if (events.current.length > 120) events.current.shift();
    };
    window.addEventListener("resize", recordResize);
    window.visualViewport?.addEventListener("resize", recordResize);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", recordResize);
      window.visualViewport?.removeEventListener("resize", recordResize);
    };
  }, []);

  function prepare() {
    let id = videoInput.trim();
    if (id && !/^[\w-]{11}$/.test(id)) {
      try {
        const url = new URL(id);
        if (url.hostname === "youtu.be")
          id = url.pathname.slice(1).split("/")[0];
        else if (
          ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(
            url.hostname,
          )
        )
          id =
            url.searchParams.get("v") ??
            url.pathname.match(/^\/(?:embed|shorts)\/([\w-]{11})/)?.[1] ??
            "";
        else id = "";
      } catch {
        id = "";
      }
      if (!/^[\w-]{11}$/.test(id)) {
        setStatus(
          "YouTube動画のURLか11文字の動画IDを入力してください。空欄ならサンプルを使います。",
        );
        return;
      }
    }
    const videos = id
      ? [{ ...samples[0], id, title: "比較用動画", durationSeconds: 0 }]
      : samples;
    events.current = [];
    began.current = null;
    setStarted(false);
    setMaximized(false);
    setStatus("");
    setTrial((previous) => ({
      id: choice,
      run: (previous?.run ?? 0) + 1,
      videos,
    }));
  }

  function start() {
    began.current = geometry(area.current);
    flushSync(() => setStarted(true));
    player.current?.startAt(0, 0);
    // 本体の開始操作と同じ位置へ合わせる。
    window.scrollTo({ top: 0 });
  }

  function makeReport(results: unknown[]) {
    return JSON.stringify(
      {
        version,
        environment,
        userAgent: navigator.userAgent,
        observations: results,
        limitation:
          "映像内部の位置・寸法はクロスオリジンのため取得できません。見え方は利用者の記録です。",
      },
      null,
      2,
    );
  }

  function record(result: string) {
    const entry = {
      at: new Date().toISOString(),
      case: configured.id,
      name: configured.name,
      videoId: trial?.videos[0].id,
      run: trial?.run,
      started,
      maximized,
      result,
      note,
      began: began.current,
      current: geometry(area.current),
      events: [...events.current],
    };
    const next = [...records, entry];
    setRecords(next);
    const text = makeReport(next);
    setReport(text);
    try {
      localStorage.setItem("youtubekit.layout-diagnostic-report", text);
      setStatus(`${configured.id}：${result}を記録しました。`);
    } catch {
      setStatus(
        "画面には記録しましたが、ブラウザへ保存できません。閉じる前に結果をコピーしてください。",
      );
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(report || makeReport(records));
      setStatus("結果をコピーしました。このチャットへ貼り付けてください。");
    } catch {
      setStatus(
        "自動コピーできませんでした。下の結果欄を選択してコピーしてください。",
      );
    }
  }

  return (
    <div
      className={`app-shell layout-lab ${maximized ? "video-maximized" : ""} layout-case-${trial?.id ?? "A"}`}
    >
      <header className="header">
        <div className="header-inner">
          <a className="brand" href="/">
            YoutubeKit
          </a>
          <span>表示ずれの比較 v{version}</span>
        </div>
      </header>
      <main className="main playing-main" ref={area}>
        {trial && (configured.id !== "F" || started) && (
          <Player
            key={trial.run}
            ref={player}
            videos={trial.videos}
            playbackPositions={{}}
            saveIntervalSeconds={0}
            resumePlaybackPosition={false}
            active={started}
            onClose={() => {
              player.current?.endSession();
              setTrial(null);
              setStarted(false);
              setMaximized(false);
            }}
            videoMaximized={maximized}
            onToggleVideoMaximized={() => setMaximized((value) => !value)}
            diagnosticSizing={configured.sizing}
            onLayoutDiagnostic={onLayout}
          />
        )}
        <section className="layout-lab-controls">
          <h1>横画面の表示ずれを比較</h1>
          <p>
            最初は通常表示で A → B → D
            を試してください。同じ動画を使い、各条件で「縦で開始 →
            横へ回転」と「最初から横で開始」を比べます。
          </p>
          <p>
            青い線は外枠です。「映像だけ右にずれる・左が黒い・右端が切れる」かを見てください。Bで動画が小さいこと、Cで上下が画面外になることは、その条件の想定どおりです。
          </p>
          <label>
            実機情報
            <input
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
            />
          </label>
          <label>
            動画URLまたはID（空欄ならサンプル）
            <input
              value={videoInput}
              onChange={(event) => setVideoInput(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=…"
            />
          </label>
          <label>
            比較条件
            <select
              value={choice}
              onChange={(event) => setChoice(event.target.value as CaseId)}
            >
              {cases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}：{item.name}
                </option>
              ))}
            </select>
          </label>
          <p>{selected.description}</p>
          <button className="secondary" onClick={prepare}>
            1. この条件で準備・やり直し
          </button>
          <button
            className="primary"
            disabled={!trial || started}
            onClick={start}
          >
            2. 再生開始
          </button>
          <p>
            適用中：{trial ? `${configured.id}：${configured.name}` : "未準備"}
            。条件を選び直したら「1.
            この条件で準備」を押してください。再生できなければプレーヤーの「再開」を押します。
          </p>
          <label>
            気づいた点
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例：縦は正常、横にすると左に黒帯。停止中もずれたまま。"
            />
          </label>
          <div className="layout-lab-actions">
            {[
              "正常",
              "右ずれ・左黒帯・右見切れ",
              "その他の異常",
              "再生できない",
            ].map((result) => (
              <button
                key={result}
                className="secondary"
                disabled={!trial || !started}
                onClick={() => record(result)}
              >
                {result}を記録
              </button>
            ))}
          </div>
          <p role="status">{status}</p>
          <p>
            記録：{records.length}
            件。通常表示と最大化、縦・横それぞれで記録できます。見え方は自動判定できません。
          </p>
          <details>
            <summary>現在の寸法</summary>
            <pre>{JSON.stringify(preview, null, 2)}</pre>
          </details>
          <button
            className="primary"
            disabled={!records.length}
            onClick={() => void copy()}
          >
            3. 結果をまとめてコピー
          </button>
          <button
            className="text-button"
            onClick={() => {
              try {
                const saved = localStorage.getItem(
                  "youtubekit.layout-diagnostic-report",
                );
                if (saved) {
                  const data = JSON.parse(saved);
                  setRecords(data.observations ?? []);
                  setReport(saved);
                  setStatus("保存した結果を読み込みました。");
                } else setStatus("保存した結果はありません。");
              } catch {
                setStatus("保存した結果を読み込めません。");
              }
            }}
          >
            前回保存した結果を読み込む
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
            結果はこのブラウザにだけ保存します。自動送信はせず、Googleの認証情報・通常のキュー・クラウド設定は読み書きしません。別ブラウザやPWAでも、このURLを開いて同じ比較ができます。
          </p>
          <a href="/?lab">従来の連続再生検証へ</a>
        </section>
      </main>
    </div>
  );
}
