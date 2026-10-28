import { useState } from "react";
import { Player } from "./Player";
import type { Video } from "./model";

const samples: Video[] = [
  {
    id: "aqz-KE-bpKQ",
    title: "Big Buck Bunny",
    channelId: "blender",
    channel: "Blender Open Movies",
    publishedAt: "2008-05-30T00:00:00Z",
    durationSeconds: 596,
  },
  {
    id: "eRsGyueVLvQ",
    title: "Sintel",
    channelId: "blender",
    channel: "Blender Open Movies",
    publishedAt: "2010-09-30T00:00:00Z",
    durationSeconds: 888,
  },
];

// 本番UIと分けた技術検証ページ。動画の終端近くへ移動して有限再生を確認できる。
export function Lab() {
  const [started, setStarted] = useState(false);
  return (
    <main className="main playing-main">
      {started ? (
        <Player videos={samples} testMode onClose={() => setStarted(false)} />
      ) : (
        <>
          <p className="eyebrow">PHASE 0 / PLAYER LAB</p>
          <h1>YouTubeキュー再生の技術検証</h1>
          <p className="intro-description">
            2本の動画で自動遷移と最終動画の終了を確認します。
          </p>
          <ol className="lab-steps">
            <li>再生を開始します。</li>
            <li>再生が始まったら「終了10秒前へ」を押します。</li>
            <li>2本目へ自動で進むことを確認します。</li>
            <li>
              2本目でも「終了10秒前へ」を押し、最後で停止することを確認します。
            </li>
          </ol>
          <button className="primary" onClick={() => setStarted(true)}>
            検証キューを再生
          </button>
          <p className="panel-note">
            動画はサンプルです。iPhone
            Safari・ホーム画面PWAは別途実機で確認します。
          </p>
          <a className="text-button" href="/">
            ← 試作の動画一覧へ
          </a>
        </>
      )}
    </main>
  );
}
