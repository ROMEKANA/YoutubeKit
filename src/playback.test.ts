import { expect, it } from "vitest";
import { getQueueEditStart, PlaylistTracker } from "./playback";

it("並べ替え・別の動画の削除では、再生中の動画IDと秒数を維持する", () => {
  const current = { videoId: "b", seconds: 42.5, autoplay: true };
  expect(getQueueEditStart(["a", "b", "c"], ["b", "c", "a"], current)).toEqual(current);
  expect(getQueueEditStart(["a", "b", "c"], ["b", "c"], current)).toEqual(current);
  const paused = { ...current, autoplay: false };
  expect(getQueueEditStart(["a", "b", "c"], ["a", "c", "b"], paused)).toEqual(paused);
});

it("再生中の動画を削除すると次へ進み、末尾の削除や空になった場合は自動再生しない", () => {
  const current = { videoId: "b", seconds: 42.5, autoplay: true };
  expect(getQueueEditStart(["a", "b", "c"], ["a", "c"], current)).toEqual({
    videoId: "c", seconds: 0, autoplay: true,
  });
  expect(getQueueEditStart(["a", "b"], ["a"], current)).toEqual({
    videoId: "a", seconds: 0, autoplay: false,
  });
  expect(getQueueEditStart(["b"], [], current)).toBeNull();
});

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
