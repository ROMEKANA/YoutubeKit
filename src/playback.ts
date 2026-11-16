export interface QueueEditStart {
  videoId: string;
  seconds: number;
  autoplay: boolean;
}

// 編集前後の番号が変わっても、再生を戻す動画はIDで決める。
export function getQueueEditStart(
  before: string[],
  after: string[],
  current: QueueEditStart,
  playbackPositions: Record<string, number>,
): QueueEditStart | null {
  if (!after.length) return null;
  if (after.includes(current.videoId)) return current;

  const previousIndex = Math.max(0, before.indexOf(current.videoId));
  const next = after[previousIndex];
  if (next) return { videoId: next, seconds: 0, autoplay: current.autoplay };

  // 後続がない削除では、残った末尾を保存位置から再生する。
  const last = after[after.length - 1];
  return { videoId: last, seconds: playbackPositions[last] ?? 0, autoplay: true };
}

// 切替直後と、保存位置へ移動中の古い時刻は履歴に使わない。
export function canSamplePlaybackPosition(seconds: number, now: number, after: number, target: number | null, first: boolean): boolean {
  return Number.isFinite(seconds) && seconds >= (first ? 2 : 0) && now >= after &&
    (target === null || seconds >= target - 1);
}

// 進行は公式プレーヤーに任せ、最終動画の終了だけをアプリ側で判定する。
// ENDEDごとにnextVideoを呼ぶ方式は、公式の自動遷移と二重になるため使わない。
export class PlaylistTracker {
  private playedIndex = -1;
  private completed = false;

  constructor(private readonly count: number) {}

  observe(state: number, index: number): "playing" | "complete" | null {
    if (index < 0 || index >= this.count) return null;
    if (state === 1) {
      this.completed = false;
      this.playedIndex = index;
      return "playing";
    }
    if (!this.completed && state === 0 && index === this.count - 1 && this.playedIndex === index) {
      this.completed = true;
      return "complete";
    }
    return null;
  }
}
