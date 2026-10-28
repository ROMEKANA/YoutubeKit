export interface Video {
  id: string;
  title: string;
  channelId: string;
  channel: string;
  publishedAt: string;
  durationSeconds: number;
}

export interface Settings {
  density: "compact" | "standard" | "large";
  initialCount: number;
  additionalCount: number;
  excludeShort: boolean;
  shortThreshold: number;
}

export interface SavedState {
  queue: string[];
  hidden: string[];
  settings: Settings;
}

export const storageKey = "youtubekit.prototype.v1";
export const defaultSettings: Settings = {
  density: "standard",
  initialCount: 30,
  additionalCount: 20,
  excludeShort: true,
  shortThreshold: 180,
};

// 保存データが旧形式や破損状態でも、利用できる項目だけを復元する。
export function restoreState(raw: string | null): SavedState {
  const empty = { queue: [], hidden: [], settings: { ...defaultSettings } };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return empty;
    const ids = (list: unknown): string[] =>
      Array.isArray(list)
        ? [
            ...new Set(
              list.filter(
                (id): id is string =>
                  typeof id === "string" && /^[\w-]{11}$/.test(id),
              ),
            ),
          ]
        : [];
    const number = (input: unknown, fallback: number, max: number) =>
      typeof input === "number" &&
      Number.isInteger(input) &&
      input >= 1 &&
      input <= max
        ? input
        : fallback;
    const settings = value.settings ?? {};
    return {
      queue: ids(value.queue),
      hidden: ids(value.hidden),
      settings: {
        density: ["compact", "standard", "large"].includes(settings.density)
          ? settings.density
          : "standard",
        initialCount: number(settings.initialCount, 30, 100),
        additionalCount: number(settings.additionalCount, 20, 100),
        excludeShort:
          typeof settings.excludeShort === "boolean"
            ? settings.excludeShort
            : true,
        shortThreshold: number(settings.shortThreshold, 180, 3600),
      },
    };
  } catch {
    return empty;
  }
}

// キューの操作は動画ID単位に行い、非表示状態とは独立させる。
export function addToQueue(queue: string[], id: string): string[] {
  return queue.includes(id) ? queue : [...queue, id];
}

export function moveItem(queue: string[], from: number, to: number): string[] {
  if (
    from < 0 ||
    to < 0 ||
    from >= queue.length ||
    to >= queue.length ||
    from === to
  )
    return queue;
  const result = [...queue];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

export function formatDuration(seconds: number, total = false): string {
  if (total) {
    const minutes = Math.ceil(seconds / 60);
    return minutes >= 60
      ? `${Math.floor(minutes / 60)}時間${minutes % 60}分`
      : `${minutes}分`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

// API応答への差し替えに備え、サンプルデータも読み込み時に検証する。
export function parseVideos(value: unknown): Video[] {
  if (!Array.isArray(value))
    throw new Error("動画一覧の形式が正しくありません。");
  return value
    .map((v) => {
      if (
        !v ||
        !/^[\w-]{11}$/.test(v.id) ||
        typeof v.title !== "string" ||
        typeof v.channelId !== "string" ||
        typeof v.channel !== "string" ||
        !Number.isFinite(Date.parse(v.publishedAt)) ||
        !Number.isFinite(v.durationSeconds) ||
        v.durationSeconds < 0
      ) {
        throw new Error("動画情報を読み込めませんでした。");
      }
      return v as Video;
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
