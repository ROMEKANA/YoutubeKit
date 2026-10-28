import { timedFetch } from "./auth";
import { AppError, requireCondition } from "./errors";

export interface ChannelData {
  id: string;
  title: string;
  thumbnailUrl: string;
  uploadsPlaylistId: string;
}
export interface VideoData {
  id: string;
  channelId: string;
  title: string;
  thumbnailUrl: string;
  publishedAt: string;
  durationSeconds: number;
  embeddable: boolean;
  availability: string;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, 2048) : fallback;
}

// 画像URLを外部APIが返したHTTPS URLに限定する。画像本体の解析や代理取得は行わない。
export function imageUrl(value: unknown): string {
  const url = text(value);
  try {
    return new URL(url).protocol === "https:" ? url : "";
  } catch {
    return "";
  }
}

function thumbnail(value: unknown): string {
  const images = record(value);
  return imageUrl(record(images.medium).url ?? record(images.default).url);
}

// APIが返すISO 8601の期間を秒に直す。ライブ予定など不明な長さは0秒として扱う。
export function durationSeconds(value: unknown): number {
  if (typeof value !== "string") return 0;
  const match =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (!match) return 0;
  return Math.round(
    Number(match[1] ?? 0) * 86400 +
      Number(match[2] ?? 0) * 3600 +
      Number(match[3] ?? 0) * 60 +
      Number(match[4] ?? 0),
  );
}

// API応答はストリームの読み込み量も制限し、大きすぎる応答をメモリへ蓄積しない。
async function limitedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  requireCondition(
    reader,
    "YOUTUBE_RESPONSE",
    "YouTubeから空の応答が返りました。",
    502,
  );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      requireCondition(
        size <= 2 * 1024 * 1024,
        "YOUTUBE_RESPONSE",
        "YouTubeの応答が大きすぎます。",
        502,
      );
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError(
      "YOUTUBE_RESPONSE",
      "YouTubeの応答を読み込めませんでした。",
      502,
    );
  }
}

// 認証付き公式APIの必要な項目だけ取得する。search.listは使わない。
export class YouTubeClient {
  constructor(
    private readonly accessToken: string,
    private readonly request: typeof fetch = timedFetch,
  ) {}

  private async list(
    endpoint: "subscriptions" | "channels" | "playlistItems" | "videos",
    parameters: Record<string, string>,
  ) {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    url.search = new URLSearchParams(parameters).toString();
    let response: Response;
    try {
      response = await this.request(url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
    } catch {
      throw new AppError(
        "YOUTUBE_UNAVAILABLE",
        "YouTubeに接続できません。取得済み一覧は保持されています。",
        502,
      );
    }
    // JSONでない障害応答でも、認証切れや利用上限をチャンネル固有の失敗にしない。
    if (response.status === 401 || response.status === 429) {
      await response.body?.cancel();
      throw new AppError(
        response.status === 401 ? "RECONNECT_REQUIRED" : "YOUTUBE_QUOTA",
        response.status === 401
          ? "YouTubeの認証期限が切れました。Googleへ再接続してください。"
          : "YouTube APIの利用上限に達しました。時間をおいて再試行してください。",
        response.status,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = record(await limitedJson(response));
    } catch (error) {
      if (!response.ok && response.status < 500)
        throw new AppError(
          "YOUTUBE_REQUEST_FAILED",
          `YouTubeから情報を取得できませんでした（HTTP ${response.status}）。`,
          502,
        );
      throw error;
    }
    if (!response.ok) {
      const error = record(body.error);
      const reasons = Array.isArray(error.errors)
        ? error.errors.map((entry) => text(record(entry).reason))
        : [];
      if (
        reasons.includes("quotaExceeded") ||
        reasons.includes("dailyLimitExceeded") ||
        reasons.includes("rateLimitExceeded") ||
        reasons.includes("userRateLimitExceeded")
      )
        throw new AppError(
          "YOUTUBE_QUOTA",
          "YouTube APIの利用上限に達しました。時間をおいて再試行してください。",
          429,
        );
      if (reasons.includes("accessNotConfigured"))
        throw new AppError(
          "YOUTUBE_API_DISABLED",
          "Google CloudでYouTube Data API v3を有効にしてください。",
          503,
        );
      if (reasons.includes("insufficientPermissions"))
        throw new AppError(
          "YOUTUBE_PERMISSION",
          `登録チャンネルの読み取り権限が必要です。再接続してください。`,
          403,
        );
      // APIの生の本文は返さず、既知の理由とHTTP番号だけを診断に使う。
      const descriptions: Record<string, string> = {
        playlistNotFound: "投稿一覧が見つかりません",
        playlistItemsNotAccessible: "投稿一覧へのアクセスが許可されていません",
        playlistOperationUnsupported: "この投稿一覧はAPI取得に対応していません",
        channelClosed: "チャンネルが閉鎖されています",
        channelSuspended: "チャンネルが停止されています",
        channelNotFound: "チャンネルが見つかりません",
        videoNotFound: "動画が見つかりません",
        forbidden: "対象へのアクセスが拒否されました",
        invalidPageToken: "ページ情報の期限が切れています",
      };
      const reason = reasons.find((value) =>
        Object.hasOwn(descriptions, value),
      );
      if (reason || response.status === 404 || response.status >= 500)
        throw new AppError(
          reason === "invalidPageToken"
            ? "YOUTUBE_PAGE_EXPIRED"
            : "YOUTUBE_ITEM_FAILED",
          `${reason ? descriptions[reason] : "対象の取得に失敗しました"}（HTTP ${response.status}${reason ? ` / ${reason}` : ""}）。`,
          502,
        );
      throw new AppError(
        "YOUTUBE_REQUEST_FAILED",
        `YouTubeから情報を取得できませんでした（HTTP ${response.status}）。取得済み一覧は保持されています。`,
        502,
      );
    }
    requireCondition(
      Array.isArray(body.items),
      "YOUTUBE_RESPONSE",
      "YouTubeの応答形式が正しくありません。",
      502,
    );
    requireCondition(
      !body.nextPageToken || body.nextPageToken !== parameters.pageToken,
      "YOUTUBE_PAGING",
      "YouTubeのページ取得が進みませんでした。時間をおいて再試行してください。",
      502,
    );
    return {
      items: body.items as unknown[],
      nextPageToken: text(body.nextPageToken),
    };
  }

  async subscriptions(pageToken = "") {
    const page = await this.list("subscriptions", {
      part: "snippet",
      mine: "true",
      maxResults: "50",
      ...(pageToken && { pageToken }),
      fields:
        "nextPageToken,items(snippet(title,resourceId/channelId,thumbnails))",
    });
    const channels: ChannelData[] = page.items
      .map((item) => {
        const snippet = record(record(item).snippet);
        return {
          id: text(record(snippet.resourceId).channelId),
          title: text(snippet.title),
          thumbnailUrl: thumbnail(snippet.thumbnails),
          uploadsPlaylistId: "",
        };
      })
      .filter((channel) => /^UC[\w-]{22}$/.test(channel.id));
    return { channels, nextPageToken: page.nextPageToken };
  }

  async channels(ids: string[]): Promise<ChannelData[]> {
    if (!ids.length) return [];
    const page = await this.list("channels", {
      part: "snippet,contentDetails",
      id: ids.join(","),
      maxResults: "50",
      fields:
        "items(id,snippet(title,thumbnails),contentDetails/relatedPlaylists/uploads)",
    });
    return page.items
      .map((item) => {
        const value = record(item);
        const snippet = record(value.snippet);
        return {
          id: text(value.id),
          title: text(snippet.title),
          thumbnailUrl: thumbnail(snippet.thumbnails),
          uploadsPlaylistId: text(
            record(record(value.contentDetails).relatedPlaylists).uploads,
          ),
        };
      })
      .filter((channel) => ids.includes(channel.id));
  }

  async uploads(playlistId: string, pageToken = "") {
    const page = await this.list("playlistItems", {
      part: "contentDetails",
      playlistId,
      maxResults: "50",
      ...(pageToken && { pageToken }),
      fields: "nextPageToken,items(contentDetails(videoId,videoPublishedAt))",
    });
    const items = page.items
      .map((item) => {
        const details = record(record(item).contentDetails);
        return {
          id: text(details.videoId),
          publishedAt: text(details.videoPublishedAt),
        };
      })
      .filter((item) => /^[\w-]{11}$/.test(item.id));
    return { items, nextPageToken: page.nextPageToken };
  }

  async videos(ids: string[]): Promise<VideoData[]> {
    if (!ids.length) return [];
    const page = await this.list("videos", {
      part: "snippet,contentDetails,status",
      id: ids.join(","),
      maxResults: "50",
      fields:
        "items(id,snippet(channelId,title,publishedAt,thumbnails,liveBroadcastContent),contentDetails/duration,status(embeddable,privacyStatus))",
    });
    return page.items
      .map((item) => {
        const value = record(item);
        const snippet = record(value.snippet);
        const status = record(value.status);
        return {
          id: text(value.id),
          channelId: text(snippet.channelId),
          title: text(snippet.title),
          thumbnailUrl: thumbnail(snippet.thumbnails),
          publishedAt: text(snippet.publishedAt),
          durationSeconds: durationSeconds(
            record(value.contentDetails).duration,
          ),
          embeddable: status.embeddable === true,
          availability:
            snippet.liveBroadcastContent === "upcoming"
              ? "upcoming"
              : text(status.privacyStatus, "unavailable"),
        };
      })
      .filter(
        (video) =>
          ids.includes(video.id) &&
          Number.isFinite(Date.parse(video.publishedAt)),
      );
  }
}

// 通常の投稿順を前提に、前回成功した開始日時より古いページで取得を打ち切る。
// 境界の重複範囲は呼び出し側で差し引き、同じIDは保存時に更新する。
export function selectRecentUploads(
  items: { id: string; publishedAt: string }[],
  cutoff: number,
) {
  const selected: string[] = [];
  let reachedCutoff = false;
  for (const item of items) {
    const date = Date.parse(item.publishedAt) / 1000;
    if (!Number.isFinite(date)) continue;
    if (cutoff > 0 && date < cutoff) {
      reachedCutoff = true;
      break;
    }
    selected.push(item.id);
  }
  return { ids: [...new Set(selected)], reachedCutoff };
}
