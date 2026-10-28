import { useEffect, useRef, useState } from "react";
import { parseVideos, type Video } from "./model";
import { parseSyncIssues, type SyncIssue } from "../shared/sync";

export interface Channel {
  id: string;
  title: string;
  thumbnailUrl?: string;
}
export interface ServerStatus {
  configured: boolean;
  authenticated: boolean;
  allowDemo: boolean;
  missing: string[];
  account?: { sub: string; email: string };
  csrfToken?: string;
  connected?: boolean;
}
interface Catalog {
  videos: Video[];
  channels: Channel[];
  lastSyncedAt: number | null;
  watermark: number | null;
  issues: SyncIssue[];
}
interface Progress {
  jobId: string;
  phase: string;
  channels: number;
  processedChannels: number;
  videosUpdated: number;
  done: boolean;
}
const emptyCatalog: Catalog = {
  videos: [],
  channels: [],
  lastSyncedAt: null,
  watermark: null,
  issues: [],
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

// Cookieは同一オリジンに限定し、秘密情報をフロントエンドへ渡さない。
async function request(
  path: string,
  options: RequestInit = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      "バックエンドへ接続できません。起動状態を確認してください。",
      "BACKEND_UNAVAILABLE",
    );
  }
  if (!response.ok) {
    const error =
      data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    throw new ApiError(
      typeof error.error === "string" ? error.error : "通信に失敗しました。",
      typeof error.code === "string" ? error.code : "REQUEST_FAILED",
    );
  }
  return data;
}

function isStatus(value: unknown): value is ServerStatus {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.configured !== "boolean" ||
    typeof v.authenticated !== "boolean" ||
    typeof v.allowDemo !== "boolean" ||
    !Array.isArray(v.missing)
  )
    return false;
  const account =
    v.account && typeof v.account === "object"
      ? (v.account as Record<string, unknown>)
      : {};
  return (
    !v.authenticated ||
    (typeof account.sub === "string" &&
      typeof account.email === "string" &&
      typeof v.csrfToken === "string")
  );
}

function parseCatalog(value: unknown): Catalog {
  if (!value || typeof value !== "object")
    throw new Error("動画一覧の応答が正しくありません。");
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.channels))
    throw new Error("チャンネル一覧の応答が正しくありません。");
  const channels: Channel[] = data.channels.map((channel: unknown) => {
    if (!channel || typeof channel !== "object")
      throw new Error("チャンネル情報を読み込めません。");
    const c = channel as Record<string, unknown>;
    if (typeof c.id !== "string" || typeof c.title !== "string")
      throw new Error("チャンネル情報を読み込めません。");
    return {
      id: c.id,
      title: c.title,
      thumbnailUrl:
        typeof c.thumbnailUrl === "string" &&
        c.thumbnailUrl.startsWith("https://")
          ? c.thumbnailUrl
          : undefined,
    };
  });
  return {
    videos: parseVideos(data.videos),
    channels,
    lastSyncedAt:
      typeof data.lastSyncedAt === "number" ? data.lastSyncedAt : null,
    watermark: typeof data.watermark === "number" ? data.watermark : null,
    issues: parseSyncIssues(data.issues),
  };
}

function parseProgress(value: unknown): Progress {
  if (!value || typeof value !== "object")
    throw new Error("更新の応答が正しくありません。");
  const v = value as Record<string, unknown>;
  if (
    typeof v.jobId !== "string" ||
    typeof v.phase !== "string" ||
    typeof v.done !== "boolean" ||
    typeof v.channels !== "number" ||
    typeof v.processedChannels !== "number" ||
    typeof v.videosUpdated !== "number"
  )
    throw new Error("更新の応答が正しくありません。");
  return {
    jobId: v.jobId,
    phase: v.phase,
    done: v.done,
    channels: v.channels,
    processedChannels: v.processedChannels,
    videosUpdated: v.videosUpdated,
  };
}

export type CatalogController = ReturnType<typeof useCatalog>;

// 同期は小さなリクエストを順番に処理する。中断してもサーバーの保存位置から再開できる。
export function useCatalog() {
  const [auth, setAuth] = useState<ServerStatus | null>(null);
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [backendOffline, setBackendOffline] = useState(false);
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const isDemo =
    !!auth && !auth.authenticated && auth.allowDemo && !auth.configured;
  const sourceKey =
    auth?.authenticated && auth.account
      ? `account.${auth.account.sub}`
      : isDemo
        ? "prototype"
        : "locked";

  async function readCatalog(status: ServerStatus, signal: AbortSignal) {
    if (status.authenticated) {
      const next = parseCatalog(await request("/api/catalog", {}, signal));
      setCatalog(next);
      // 更新完了後にサーバーが確定した「開始日時」だけを端末にも控える。
      try {
        localStorage.setItem(
          `youtubekit.watermark.${status.account!.sub}`,
          JSON.stringify({
            watermark: next.watermark,
            lastSyncedAt: next.lastSyncedAt,
          }),
        );
      } catch {
        /* 一覧と認証はサーバー側の保存値で継続できる。 */
      }
    } else if (status.allowDemo && !status.configured) {
      const videos = parseVideos(
        await request("/demo-videos.json", {}, signal),
      );
      const channels = [
        ...new Map(
          videos.map((v) => [
            v.channelId,
            { id: v.channelId, title: v.channel },
          ]),
        ).values(),
      ].sort((a, b) => a.title.localeCompare(b.title, "ja"));
      setCatalog({
        videos,
        channels,
        watermark: null,
        lastSyncedAt: null,
        issues: [],
      });
    } else setCatalog(emptyCatalog);
  }

  async function checkConnection() {
    if (busy.current) return;
    busy.current = true;
    const nextController = new AbortController();
    controller.current = nextController;
    setChecking(true);
    setError("");
    try {
      let status: ServerStatus;
      try {
        const result = await request("/api/status", {}, nextController.signal);
        if (!isStatus(result))
          throw new Error("接続状態を読み込めませんでした。");
        status = result;
        setBackendOffline(false);
      } catch (reason) {
        if (nextController.signal.aborted) return;
        const unavailable =
          reason instanceof TypeError ||
          (reason instanceof ApiError && reason.code === "BACKEND_UNAVAILABLE");
        if (
          !unavailable ||
          !["localhost", "127.0.0.1"].includes(window.location.hostname)
        )
          throw reason;
        status = {
          configured: false,
          authenticated: false,
          allowDemo: true,
          missing: ["バックエンドを起動してください"],
        };
        setBackendOffline(true);
      }
      setAuth(status);
      await readCatalog(status, nextController.signal);
      if (
        new URLSearchParams(window.location.search).get("auth_error") ===
        "denied"
      )
        setError(
          "Googleへの接続がキャンセルされました。設定から再試行できます。",
        );
    } catch (reason) {
      if (!nextController.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "通信に失敗しました。",
        );
    } finally {
      busy.current = false;
      setChecking(false);
    }
  }

  useEffect(() => {
    void checkConnection();
    return () => controller.current?.abort();
  }, []);

  async function refresh(full = false) {
    if (busy.current || !auth) return;
    busy.current = true;
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setError("");
    try {
      if (auth.authenticated) {
        const post = (path: string, body: object) =>
          request(
            path,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": auth.csrfToken!,
              },
              body: JSON.stringify(body),
            },
            nextController.signal,
          );
        let state = parseProgress(await post("/api/sync/start", { full }));
        while (!state.done && !nextController.signal.aborted) {
          const labels: Record<string, string> = {
            subscriptions: "登録チャンネルを確認中",
            channels: "チャンネル情報を取得中",
            uploads: "新着動画を確認中",
            refresh: "保存済み動画の状態を確認中",
          };
          setProgress(
            `${labels[state.phase] ?? "更新中"}（${state.processedChannels}/${state.channels}チャンネル）`,
          );
          state = parseProgress(
            await post("/api/sync/step", { jobId: state.jobId }),
          );
        }
      }
      if (!nextController.signal.aborted)
        await readCatalog(auth, nextController.signal);
    } catch (reason) {
      // 全体が中断した場合も、その時点までに保存できた動画を一覧へ反映する。
      if (auth.authenticated && !nextController.signal.aborted) {
        try {
          await readCatalog(auth, nextController.signal);
        } catch {
          /* 最初の失敗理由を優先して表示する。 */
        }
      }
      if (!nextController.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "動画を更新できませんでした。",
        );
      if (
        reason instanceof ApiError &&
        ["RECONNECT_REQUIRED", "LOGIN_REQUIRED"].includes(reason.code)
      )
        setAuth((status) =>
          status ? { ...status, connected: false } : status,
        );
    } finally {
      busy.current = false;
      setLoading(false);
      setProgress("");
    }
  }

  async function endConnection(removeData = false) {
    if (busy.current || !auth?.authenticated) return;
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const result = await request(
        removeData ? "/api/disconnect" : "/api/logout",
        { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken! } },
      );
      setCatalog(emptyCatalog);
      setAuth({
        ...auth,
        authenticated: false,
        account: undefined,
        csrfToken: undefined,
        connected: false,
      });
      if (
        removeData &&
        result &&
        typeof result === "object" &&
        "revoked" in result &&
        result.revoked === false
      )
        setError(
          "サーバー内のデータは削除しました。Google側の権限解除はGoogleアカウントの「接続」で確認してください。",
        );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "接続の終了に失敗しました。",
      );
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }

  return {
    ...catalog,
    auth,
    checking,
    loading,
    error,
    progress,
    isDemo,
    sourceKey,
    backendOffline,
    refresh,
    checkConnection,
    endConnection,
  };
}
