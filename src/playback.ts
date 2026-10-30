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
