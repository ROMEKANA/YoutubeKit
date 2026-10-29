// 短い3連続タップ、横スワイプ、移動せず3秒続いた長押しだけを受け付ける。
export function createTheaterGestures(
  togglePlayback: () => void,
  exit: () => void,
  seekBy: (seconds: number) => void,
) {
  const pointers = new Set<number>();
  let start: {
    id: number;
    x: number;
    y: number;
    time: number;
    moved: boolean;
  } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let taps = 0;
  let lastTap = 0;
  const reset = () => {
    clearTimeout(timer);
    start = null;
    taps = 0;
  };
  return {
    down(id: number, x: number, y: number) {
      pointers.add(id);
      if (pointers.size !== 1) {
        reset();
        return;
      }
      start = { id, x, y, time: Date.now(), moved: false };
      timer = setTimeout(() => {
        reset();
        exit();
      }, 3000);
    },
    move(id: number, x: number, y: number) {
      if (start?.id !== id) return;
      if (Math.hypot(x - start.x, y - start.y) > 12) {
        start.moved = true;
        clearTimeout(timer);
        taps = 0;
      }
    },
    up(id: number, x: number, y: number) {
      pointers.delete(id);
      if (start?.id !== id) return;
      clearTimeout(timer);
      const elapsed = Date.now() - start.time;
      const deltaX = x - start.x;
      const deltaY = y - start.y;
      const moved = start.moved;
      start = null;
      if (
        elapsed <= 1000 &&
        Math.abs(deltaX) >= 48 &&
        Math.abs(deltaX) > Math.abs(deltaY) * 1.25
      ) {
        taps = 0;
        seekBy(deltaX < 0 ? -10 : 10);
        return;
      }
      const short = elapsed <= 350;
      if (!short || moved || Math.hypot(deltaX, deltaY) > 12) {
        taps = 0;
        return;
      }
      if (Date.now() - lastTap > 450) taps = 0;
      lastTap = Date.now();
      if (++taps === 3) {
        taps = 0;
        togglePlayback();
      }
    },
    cancel(id: number) {
      pointers.delete(id);
      reset();
    },
    dispose() {
      pointers.clear();
      reset();
    },
  };
}
