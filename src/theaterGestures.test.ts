import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTheaterGestures } from "./theaterGestures";

describe("シアターモードの誤操作防止", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function setup() {
    const pause = vi.fn();
    const exit = vi.fn();
    const gestures = createTheaterGestures(pause, exit);
    const tap = () => {
      gestures.down(1, 10, 10);
      vi.advanceTimersByTime(50);
      gestures.up(1);
      vi.advanceTimersByTime(100);
    };
    return { gestures, pause, exit, tap };
  }
  it("1・2回のタップでは反応せず、3回で一時停止する", () => {
    const { tap, pause, exit } = setup();
    tap();
    tap();
    expect(pause).not.toHaveBeenCalled();
    tap();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
  it("間が空いたタップを合算しない", () => {
    const { tap, pause } = setup();
    tap();
    tap();
    vi.advanceTimersByTime(500);
    tap();
    expect(pause).not.toHaveBeenCalled();
  });
  it("3秒未満で離すと解除せず、3秒続けると解除する", () => {
    const { gestures, pause, exit } = setup();
    gestures.down(1, 10, 10);
    vi.advanceTimersByTime(2999);
    expect(exit).not.toHaveBeenCalled();
    gestures.up(1);
    gestures.down(1, 10, 10);
    vi.advanceTimersByTime(3000);
    gestures.up(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });
  it("移動・複数指・キャンセル・破棄では長押しを中断する", () => {
    for (const action of ["move", "multi", "cancel", "dispose"]) {
      const { gestures, exit } = setup();
      gestures.down(1, 10, 10);
      if (action === "move") gestures.move(1, 30, 10);
      if (action === "multi") gestures.down(2, 10, 10);
      if (action === "cancel") gestures.cancel(1);
      if (action === "dispose") gestures.dispose();
      vi.advanceTimersByTime(4000);
      expect(exit).not.toHaveBeenCalled();
    }
  });
});
