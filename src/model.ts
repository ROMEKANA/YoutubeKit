export interface Video {
  id: string;
  title: string;
  channelId: string;
  channel: string;
  publishedAt: string;
  durationSeconds: number;
  thumbnailUrl?: string;
  channelThumbnailUrl?: string;
}

export interface Settings {
  densityPercent: number;
  initialCount: number;
  additionalCount: number;
  excludeShort: boolean;
  shortThreshold: number;
  theaterBrightness: number;
}

export interface SavedQueue {
  id: string;
  name: string;
  videoIds: string[];
  resumeVideoId: string | null;
}

export interface SavedState {
  queue: string[];
  resumeVideoId: string | null;
  savedQueues: SavedQueue[];
  hidden: string[];
  settings: Settings;
}

export const storageKey = "youtubekit.prototype.v1";
export const defaultSettings: Settings = {
  densityPercent: 100,
  initialCount: 30,
  additionalCount: 30,
  excludeShort: true,
  shortThreshold: 180,
  theaterBrightness: 20,
};

// 保存データが旧形式や破損状態でも、利用できる項目だけを復元する。
export function restoreState(raw: string | null): SavedState {
  const empty = {
    queue: [],
    resumeVideoId: null,
    savedQueues: [],
    hidden: [],
    settings: { ...defaultSettings },
  };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return empty;
    const videoId = (input: unknown): string | null =>
      typeof input === "string" && /^[\w-]{11}$/.test(input) ? input : null;
    const ids = (list: unknown): string[] =>
      Array.isArray(list)
        ? [
            ...new Set(
              list.filter((id): id is string => videoId(id) !== null),
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
    const savedQueueIds = new Set<string>();
    const savedQueues: SavedQueue[] = Array.isArray(value.savedQueues)
      ? value.savedQueues.flatMap((item: unknown) => {
          if (!item || typeof item !== "object") return [];
          const candidate = item as Record<string, unknown>;
          const id = candidate.id;
          const name = candidate.name;
          const videoIds = ids(candidate.videoIds);
          if (
            typeof id !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              id,
            ) ||
            savedQueueIds.has(id) ||
            typeof name !== "string" ||
            !name.trim() ||
            !videoIds.length
          )
            return [];
          savedQueueIds.add(id);
          return [
            {
              id,
              name,
              videoIds,
              resumeVideoId: videoId(candidate.resumeVideoId),
            },
          ];
        })
      : [];
    // 旧3段階の表示設定を近い倍率へ移し、保存済みキューはそのまま引き継ぐ。
    const legacyDensity =
      settings.density === "compact"
        ? 80
        : settings.density === "large"
          ? 130
          : 100;
    const densityPercent =
      typeof settings.densityPercent === "number" &&
      Number.isInteger(settings.densityPercent) &&
      settings.densityPercent >= 10 &&
      settings.densityPercent <= 200 &&
      settings.densityPercent % 10 === 0
        ? settings.densityPercent
        : legacyDensity;
    return {
      queue: ids(value.queue),
      resumeVideoId: videoId(value.resumeVideoId),
      savedQueues,
      hidden: ids(value.hidden),
      settings: {
        densityPercent,
        initialCount: number(settings.initialCount, 30, 100),
        additionalCount: number(settings.additionalCount, 30, 100),
        excludeShort:
          typeof settings.excludeShort === "boolean"
            ? settings.excludeShort
            : true,
        shortThreshold: number(settings.shortThreshold, 180, 3600),
        theaterBrightness: number(settings.theaterBrightness, 20, 100),
      },
    };
  } catch {
    return empty;
  }
}

// 将来サーバー同期してもブラウザ間で衝突しにくいUUIDを保存キューへ割り当てる。
export function createSavedQueueId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

// 保存済みキューは現在の末尾へ追加し、既に選んでいる動画は重複させない。
export function appendQueue(queue: string[], videoIds: string[]): string[] {
  const result = [...queue];
  const existing = new Set(queue);
  for (const id of videoIds) {
    if (existing.has(id)) continue;
    existing.add(id);
    result.push(id);
  }
  return result;
}

// 保存キューに再開動画があれば履歴を上書きし、旧保存形式などでなければ現在値を維持する。
export function mergeSavedQueue(
  queue: string[],
  resumeVideoId: string | null,
  savedQueue: SavedQueue,
): { queue: string[]; resumeVideoId: string | null } {
  return {
    queue: appendQueue(queue, savedQueue.videoIds),
    resumeVideoId: savedQueue.resumeVideoId ?? resumeVideoId,
  };
}

// 最後に再生した動画が現在のキューに含まれる場合だけ、その位置から開始する。
export function getQueueStartIndex(
  queue: string[],
  resumeVideoId: string | null,
): number {
  const index = resumeVideoId ? queue.indexOf(resumeVideoId) : -1;
  return index >= 0 ? index : 0;
}

// キューの操作は動画ID単位に行い、非表示状態とは独立させる。
export function addToQueue(queue: string[], id: string): string[] {
  return queue.includes(id) ? queue : [...queue, id];
}

// 再タップでは対象だけを削除し、残りの並び順を維持する。
export function toggleQueueItem(queue: string[], id: string): string[] {
  return queue.includes(id)
    ? queue.filter((item) => item !== id)
    : addToQueue(queue, id);
}

// 設定画面は分単位、動画データと保存済みの閾値は秒単位で比較する。
export function isExcludedByDuration(
  durationSeconds: number,
  settings: Settings,
): boolean {
  return settings.excludeShort && durationSeconds <= settings.shortThreshold;
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

export function formatPublishedAt(date: string): string {
  return new Date(date).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

// 通常更新の警告が変わっても閉じた状態を維持し、過去分再取得で失敗した世代だけ再表示する。
export function readWarningDismissal(raw: string | null): string | null {
  try {
    const value = JSON.parse(raw ?? "null");
    return typeof value?.revision === "string" ? value.revision : null;
  } catch {
    return null;
  }
}

// API応答への差し替えに備え、サンプルデータも読み込み時に検証する。
export function parseVideos(value: unknown): Video[] {
  if (!Array.isArray(value))
    throw new Error("動画一覧の形式が正しくありません。");
  const parsed = value.map((item: unknown): Video => {
    if (!item || typeof item !== "object")
      throw new Error("動画情報を読み込めませんでした。");
    const v = item as Record<string, unknown>;
    if (
      typeof v.id !== "string" ||
      !/^[\w-]{11}$/.test(v.id) ||
      typeof v.title !== "string" ||
      typeof v.channelId !== "string" ||
      typeof v.channel !== "string" ||
      typeof v.publishedAt !== "string" ||
      !Number.isFinite(Date.parse(v.publishedAt)) ||
      typeof v.durationSeconds !== "number" ||
      !Number.isFinite(v.durationSeconds) ||
      v.durationSeconds < 0
    ) {
      throw new Error("動画情報を読み込めませんでした。");
    }
    const image = (url: unknown) =>
      typeof url === "string" && url.startsWith("https://") ? url : undefined;
    return {
      id: v.id,
      title: v.title,
      channelId: v.channelId,
      channel: v.channel,
      publishedAt: v.publishedAt,
      durationSeconds: v.durationSeconds,
      ...(image(v.thumbnailUrl) && { thumbnailUrl: image(v.thumbnailUrl) }),
      ...(image(v.channelThumbnailUrl) && {
        channelThumbnailUrl: image(v.channelThumbnailUrl),
      }),
    };
  });
  return [...new Map(parsed.map((video) => [video.id, video])).values()].sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
}
