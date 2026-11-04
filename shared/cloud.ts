import {
  defaultSettings,
  restoreState,
  type SavedQueue,
  type SavedState,
} from "../src/model";

export interface CloudEntry {
  key: string;
  value: string;
  revision: number;
  updatedAt: number;
  ordinal?: number;
}
export interface CloudChange {
  key: string;
  value: string;
  base: number;
}
export const cloudIntervals = [0, 15, 30, 60, 120, 300, 600] as const;
const localSettings = new Set([
  "densityPercent",
  "theaterBrightness",
  "playerVideoMaximized",
]);
export const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// 全状態の上書きを避け、設定・動画・保存キューをそれぞれ独立した項目へ分ける。
export function cloudValues(
  state: SavedState,
  device: string,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const queue of state.savedQueues)
    values[`queue/${queue.id}`] = JSON.stringify(queue);
  for (const id of state.hidden) values[`hidden/${id}`] = "true";
  for (const [id, seconds] of Object.entries(state.playbackPositions))
    values[`position/${id}`] = JSON.stringify(seconds);
  for (const [key, value] of Object.entries(state.settings)) {
    if (!localSettings.has(key))
      values[`setting/${key}`] = JSON.stringify(value);
  }
  values[`device/${device}`] = JSON.stringify({
    queue: state.queue,
    resumeVideoId: state.resumeVideoId,
  });
  return values;
}

export function absentValue(key: string): string {
  return key.startsWith("hidden/")
    ? "false"
    : key.startsWith("position/")
      ? "0"
      : "null";
}

// クラウドから届いた値でも既存の復元処理と同じ形式・値域を要求する。
export function validCloudValue(key: string, value: string): boolean {
  if (value.length > 200000) return false;
  try {
    const data = JSON.parse(value);
    const [kind, id] = key.split("/");
    if (key.split("/").length !== 2) return false;
    if (kind === "queue") {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
      if (data === null) return true;
      return (
        data?.id === id &&
        equal(
          restoreState(JSON.stringify({ savedQueues: [data] })).savedQueues[0],
          data,
        )
      );
    }
    if (kind === "hidden")
      return /^[\w-]{11}$/.test(id) && typeof data === "boolean";
    if (kind === "position")
      return /^[\w-]{11}$/.test(id) && Number.isSafeInteger(data) && data >= 0;
    if (kind === "setting") {
      if (!Object.hasOwn(defaultSettings, id) || localSettings.has(id))
        return false;
      return equal(
        restoreState(JSON.stringify({ settings: { [id]: data } })).settings[
          id as keyof typeof defaultSettings
        ],
        data,
      );
    }
    if (kind === "device" && /^[0-9a-f-]{36}$/i.test(id)) {
      const restored = restoreState(JSON.stringify(data));
      return equal(
        { queue: restored.queue, resumeVideoId: restored.resumeVideoId },
        data,
      );
    }
  } catch {
    return false;
  }
  return false;
}

// 再生中のキューと再生位置は変更せず、次に同期する機会まで受信値を保持する。
export function applyCloud(
  state: SavedState,
  entries: CloudEntry[],
  playing: boolean,
): SavedState {
  const next = {
    ...state,
    settings: { ...state.settings },
    hidden: [...state.hidden],
    playbackPositions: { ...state.playbackPositions },
  };
  const queues = new Map(state.savedQueues.map((queue) => [queue.id, queue]));
  for (const entry of entries) {
    if (!validCloudValue(entry.key, entry.value)) continue;
    const [kind, id] = entry.key.split("/");
    const value = JSON.parse(entry.value);
    if (kind === "queue") {
      if (value === null) queues.delete(id);
      else queues.set(id, value as SavedQueue);
    } else if (kind === "hidden") {
      next.hidden = next.hidden.filter((item) => item !== id);
      if (value) next.hidden.push(id);
    } else if (kind === "position" && !playing)
      next.playbackPositions[id] = value;
    else if (kind === "setting") Object.assign(next.settings, { [id]: value });
  }
  next.savedQueues = [...queues.values()];
  // 上限・下限の別々の変更が交差した場合も、一覧の条件を有効な範囲へ戻す。
  next.settings.watchedMaxPercent = Math.max(
    next.settings.watchedMinPercent,
    next.settings.watchedMaxPercent,
  );
  return next;
}
