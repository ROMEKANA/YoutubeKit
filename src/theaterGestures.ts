// 短い3連続タップと、移動せず3秒続いた長押しだけを受け付ける。
export function createTheaterGestures(pause: () => void, exit: () => void) {
  const pointers = new Set<number>();
  let start: { id: number; x: number; y: number; time: number } | null = null;
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
      start = { id, x, y, time: Date.now() };
      timer = setTimeout(() => {
        reset();
        exit();
      }, 3000);
    },
    move(id: number, x: number, y: number) {
      if (start?.id === id && Math.hypot(x - start.x, y - start.y) > 12)
        reset();
    },
    up(id: number) {
      pointers.delete(id);
      if (start?.id !== id) return;
      clearTimeout(timer);
      const short = Date.now() - start.time <= 350;
      start = null;
      if (!short) {
        taps = 0;
        return;
      }
      if (Date.now() - lastTap > 450) taps = 0;
      lastTap = Date.now();
      if (++taps === 3) {
        taps = 0;
        pause();
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
