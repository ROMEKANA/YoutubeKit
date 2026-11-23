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

export type ChannelSort = "name" | "latest" | "watched";

export interface Settings {
  densityPercent: number;
  initialCount: number;
  catalogAutoRefreshMinutes: number;
  channelSort: ChannelSort;
  additionalCount: number;
  excludeShort: boolean;
  shortThreshold: number;
  durationMaxSeconds: number;
  excludeByWatchedRange: boolean;
  excludeHiddenVideos: boolean;
  theaterBrightness: number;
  playbackSaveIntervalSeconds: number;
  resumePlaybackPosition: boolean;
  restartNearEndSeconds: number;
  watchedMinPercent: number;
  watchedMaxPercent: number;
}

export interface SavedQueue {
  id: string;
  name: string;
  videoIds: string[];
  // 旧形式の保存キューをクラウド同期やバックアップで保持するための項目。
  resumeVideoId?: string | null;
  playbackPositions?: Record<string, number>;
}

export interface SavedState {
  queue: string[];
  resumeVideoId: string | null;
  playbackPositions: Record<string, number>;
  playbackPositionRecordedAt: Record<string, number>;
  savedQueues: SavedQueue[];
  hidden: string[];
  hiddenAt: Record<string, number>;
  watchedChannelAt: Record<string, number>;
  settings: Settings;
}

export const storageKey = "youtubekit.prototype.v1";
export const playbackSaveIntervals = [0, 1, 2, 3, 5, 10, 36, 60] as const;
export const catalogAutoRefreshIntervals = [0, 1, 5, 15, 30, 60, 120] as const;
export const durationOptions = [1, 2, 3, 5, 10, 30, 60, 120, 180, 300].map((minutes) => minutes * 60);
export const watchedPercentOptions = Array.from({ length: 21 }, (_, index) => index * 5);
export const defaultSettings: Settings = {
  densityPercent: 100,
  initialCount: 30,
  catalogAutoRefreshMinutes: 30,
  channelSort: "name",
  additionalCount: 30,
  excludeShort: true,
  shortThreshold: 180,
  durationMaxSeconds: -1,
  excludeByWatchedRange: true,
  excludeHiddenVideos: true,
  theaterBrightness: 20,
  playbackSaveIntervalSeconds: 5,
  resumePlaybackPosition: true,
  restartNearEndSeconds: 10,
  watchedMinPercent: 0,
  watchedMaxPercent: 100,
};

// 保存データが旧形式や破損状態でも、利用できる項目だけを復元する。
export function restoreState(raw: string | null): SavedState {
  const empty = {
    queue: [],
    resumeVideoId: null,
    playbackPositions: {},
    playbackPositionRecordedAt: {},
    savedQueues: [],
    hidden: [],
    hiddenAt: {},
    watchedChannelAt: {},
    settings: { ...defaultSettings },
  };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return empty;
    const videoId = (input: unknown): string | null =>
      typeof input === "string" && /^[\w-]{11}$/.test(input) ? input : null;
    const playbackPosition = (input: unknown): number =>
      typeof input === "number" &&
      Number.isFinite(input) &&
      input >= 0
        ? Math.floor(input)
        : 0;
    const playbackPositions = (input: unknown): Record<string, number> => {
      if (!input || typeof input !== "object" || Array.isArray(input))
        return {};
      return Object.fromEntries(
        Object.entries(input).flatMap(([id, seconds]) => {
          const position = playbackPosition(seconds);
          return videoId(id) && position > 0 ? [[id, position]] : [];
        }),
      );
    };
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
    const number0 = (input: unknown, fallback: number, max: number) =>
      typeof input === "number" &&
      Number.isInteger(input) &&
      input >= 0 &&
      input <= max
        ? input
        : fallback;
    const settings = value.settings ?? {};
    const percent = (input: unknown, fallback: number) =>
      typeof input === "number" && Number.isInteger(input) && input >= 0 && input <= 100
        ? input : fallback;
    const watchedMinPercent = percent(settings.watchedMinPercent, 0);
    const watchedMaxPercent = Math.max(watchedMinPercent, percent(settings.watchedMaxPercent, 100));
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
          if (
            !Object.hasOwn(candidate, "resumeVideoId") &&
            !Object.hasOwn(candidate, "playbackPositions") &&
            !Object.hasOwn(candidate, "resumePositionSeconds")
          ) return [{ id, name, videoIds }];
          // 旧形式の値は復元データに残すが、キューを適用するときには参照しない。
          const resumeVideoId = videoId(candidate.resumeVideoId);
          const positions = playbackPositions(candidate.playbackPositions);
          const legacyPosition = playbackPosition(
            candidate.resumePositionSeconds,
          );
          if (resumeVideoId && legacyPosition > 0 && !positions[resumeVideoId])
            positions[resumeVideoId] = legacyPosition;
          return [
            {
              id,
              name,
              videoIds,
              resumeVideoId,
              playbackPositions: Object.fromEntries(
                videoIds.flatMap((video) =>
                  positions[video] > 0 ? [[video, positions[video]]] : [],
                ),
              ),
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
    const resumeVideoId = videoId(value.resumeVideoId);
    const positions = playbackPositions(value.playbackPositions);
    const legacyPosition = playbackPosition(value.resumePositionSeconds);
    if (resumeVideoId && legacyPosition > 0 && !positions[resumeVideoId])
      positions[resumeVideoId] = legacyPosition;
    const recordedAt = Object.fromEntries(
      Object.entries(value.playbackPositionRecordedAt ?? {}).flatMap(([id, time]) =>
        videoId(id) && typeof time === "number" && Number.isSafeInteger(time) && time > 0 &&
        Object.hasOwn(value.playbackPositions ?? {}, id)
          ? [[id, time] as const]
          : [],
      ),
    );
    // 記録時刻付きの0秒は、巻き戻しやバックアップ復元で確定した再生位置。
    for (const id of Object.keys(recordedAt)) positions[id] ??= 0;
    const hidden = ids(value.hidden);
    return {
      queue: ids(value.queue),
      resumeVideoId,
      playbackPositions: positions,
      playbackPositionRecordedAt: recordedAt,
      savedQueues,
      hidden,
      hiddenAt: Object.fromEntries(hidden.flatMap((id) => {
        const time = value.hiddenAt?.[id];
        return Number.isSafeInteger(time) && time > 0 ? [[id, time]] : [];
      })),
      watchedChannelAt: Object.fromEntries(
        Object.entries(value.watchedChannelAt ?? {}).flatMap(([id, time]) =>
          /^[\w-]{1,40}$/.test(id) && typeof time === "number" && Number.isSafeInteger(time) && time > 0
            ? [[id, time] as const]
            : [],
        ),
      ),
      settings: {
        watchedMinPercent,
        watchedMaxPercent,
        densityPercent,
        initialCount: number(settings.initialCount, 30, 100),
        catalogAutoRefreshMinutes: catalogAutoRefreshIntervals.find(
          (minutes) => minutes === settings.catalogAutoRefreshMinutes,
        ) ?? defaultSettings.catalogAutoRefreshMinutes,
        additionalCount: number(settings.additionalCount, 30, 100),
        channelSort: settings.channelSort === "latest" || settings.channelSort === "watched" ? settings.channelSort : "name",
        excludeShort:
          typeof settings.excludeShort === "boolean"
            ? settings.excludeShort
            : true,
        // 旧設定の「指定秒以下を除外」は保存値と境界を維持する。
        shortThreshold: settings.shortThreshold === -1 ? -1 : number(settings.shortThreshold, 180, 17999),
        durationMaxSeconds: durationOptions.includes(settings.durationMaxSeconds) ? settings.durationMaxSeconds : -1,
        excludeByWatchedRange: settings.excludeByWatchedRange !== false,
        excludeHiddenVideos: settings.excludeHiddenVideos !== false,
        theaterBrightness: number0(settings.theaterBrightness, 20, 100),
        playbackSaveIntervalSeconds:
          typeof settings.playbackSaveIntervalSeconds === "number" &&
          playbackSaveIntervals.includes(
            settings.playbackSaveIntervalSeconds as (typeof playbackSaveIntervals)[number],
          )
            ? settings.playbackSaveIntervalSeconds
            : 5,
        resumePlaybackPosition:
          typeof settings.resumePlaybackPosition === "boolean"
            ? settings.resumePlaybackPosition
            : true,
        restartNearEndSeconds: [0, 5, 10, 15, 30].includes(settings.restartNearEndSeconds)
          ? settings.restartNearEndSeconds
          : 10,
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

// 保存順は変えず、一覧だけを後から保存した順に並べる。
export function newestSavedQueuesFirst(
  savedQueues: SavedQueue[],
): SavedQueue[] {
  return [...savedQueues].reverse();
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

// 追加は一覧から選ぶときと同じ扱いにし、置き換えでは開始点だけを先頭へ戻す。
export function loadSavedQueue(state: SavedState, savedQueue: SavedQueue, replace: boolean): SavedState {
  if (replace) {
    return { ...state, queue: [...savedQueue.videoIds], resumeVideoId: null };
  }
  return { ...state, queue: appendQueue(state.queue, savedQueue.videoIds) };
}

// 開始する動画だけを選び、実際の再生が始まってからPlayerが保存位置を読む。
export function getQueueStart(queue: string[], videoId: string | null, fromBeginning = false): {
  index: number;
  positionSeconds?: number;
  restartQueue?: boolean;
} {
  if (fromBeginning) return { index: 0, positionSeconds: 0, restartQueue: true };
  return { index: Math.max(0, videoId === null ? -1 : queue.indexOf(videoId)) };
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

export interface VideoFilters {
  minDuration: number;
  maxDuration: number;
  hidden: string[];
  watchedMinPercent: number;
  watchedMaxPercent: number;
}

// 一覧・チャンネル順位では同じ有効条件を使う。無効時も設定値は保存する。
export function getVideoFilters(settings: Settings, hidden: string[]): VideoFilters {
  return {
    minDuration: settings.excludeShort ? settings.shortThreshold : -1,
    maxDuration: settings.excludeShort && settings.durationMaxSeconds >= 0
      ? Math.max(settings.durationMaxSeconds, settings.shortThreshold + 1)
      : -1,
    hidden: settings.excludeHiddenVideos ? hidden : [],
    watchedMinPercent: settings.excludeByWatchedRange ? settings.watchedMinPercent : 0,
    watchedMaxPercent: settings.excludeByWatchedRange ? settings.watchedMaxPercent : 100,
  };
}

export function createVideoFilter(
  filters: VideoFilters,
  positions: Record<string, number> = {},
): (video: Pick<Video, "id" | "durationSeconds">) => boolean {
  const hidden = new Set(filters.hidden);
  return (video) =>
    !hidden.has(video.id) &&
    video.durationSeconds > filters.minDuration &&
    (filters.maxDuration < 0 || video.durationSeconds <= filters.maxDuration) &&
    isWithinWatchedRange(video, positions[video.id], filters.watchedMinPercent, filters.watchedMaxPercent);
}

// 未視聴・長さ不明は0%とし、保存位置が動画時間を超えた場合も100%までに収める。
export function isWithinWatchedRange(video: Pick<Video, "durationSeconds">, positionSeconds = 0, minPercent = 0, maxPercent = 100): boolean {
  if (video.durationSeconds <= 0) return minPercent === 0;
  const position = Number.isFinite(positionSeconds)
    ? Math.min(video.durationSeconds, Math.max(0, positionSeconds)) : 0;
  // 割り算の丸めで境界の動画が範囲外にならないよう、秒と割合の積で比較する。
  return position * 100 >= video.durationSeconds * minPercent &&
    position * 100 <= video.durationSeconds * maxPercent;
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
