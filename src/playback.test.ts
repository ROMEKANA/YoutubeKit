import { expect, it } from "vitest";
import { PlaylistTracker } from "./playback";

it("途中の終了では完了せず、最終動画を再生した後だけ完了する", () => {
  const tracker = new PlaylistTracker(2);
  expect(tracker.observe(1, 0)).toBe("playing");
  expect(tracker.observe(0, 0)).toBeNull();
  expect(tracker.observe(1, 1)).toBe("playing");
  expect(tracker.observe(0, 1)).toBe("complete");
});

it("終了イベントの重複や未再生の最終項目で二重処理しない", () => {
  const tracker = new PlaylistTracker(1);
  expect(tracker.observe(0, 0)).toBeNull();
  tracker.observe(1, 0);
  expect(tracker.observe(0, 0)).toBe("complete");
  expect(tracker.observe(0, 0)).toBeNull();
  expect(tracker.observe(1, 3)).toBeNull();
});

it("途中の動画番号から開始しても最終動画で完了する", () => {
  const tracker = new PlaylistTracker(3);
  expect(tracker.observe(1, 1)).toBe("playing");
  expect(tracker.observe(0, 1)).toBeNull();
  expect(tracker.observe(1, 2)).toBe("playing");
  expect(tracker.observe(0, 2)).toBe("complete");
});
