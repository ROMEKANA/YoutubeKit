import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import {
  Miniflare,
  Response as MockResponse,
  type MiniflareOptions,
} from "miniflare";
import { readFile } from "node:fs/promises";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { encryptSecret } from "../worker/security";
import { cleanup } from "../worker/cleanup";
import {
  durationSeconds,
  selectRecentUploads,
  YouTubeClient,
} from "../worker/youtube";
import type { SyncIssue } from "../shared/sync";

const origin = "https://app.example.net";
const sub = "123456789012345678901";
const channelA = `UC${"a".repeat(22)}`;
const channelB = `UC${"b".repeat(22)}`;
const videoIds = ["aqz-KE-bpKQ", "eRsGyueVLvQ", "R6MlUcmOul8"];
const youtubeScope = "https://www.googleapis.com/auth/youtube.readonly";
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
  "base64",
);
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
let idToken = "";
let quotaFailure = false;
let seen: string[] = [];
let sessionCookie = "";
let csrf = "";
let corruptSignature = false;
let uploadFailure: {
  playlist: string;
  status: number;
  reason: string;
  page?: string;
} | null = null;
let extraUploadPage = false;

const seconds = () => Math.floor(Date.now() / 1000);
const published = (ago: number) =>
  new Date((seconds() - ago) * 1000).toISOString();
const json = (value: unknown, status = 200) =>
  new MockResponse(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// 外向き通信はこのハンドラーだけへ流す。Googleの実アカウントやネットワークを使わない。
async function upstream(request: Request) {
  const url = new URL(request.url);
  seen.push(`${url.pathname}${url.search}`);
  if (url.pathname === "/oauth2/v3/certs") return json({ keys: [jwk] });
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    const form = new URLSearchParams(await request.text());
    if (form.get("grant_type") === "authorization_code") {
      expect(form.get("code_verifier")).toBeTruthy();
      expect(form.get("redirect_uri")).toBe(`${origin}/auth/callback`);
      return json({
        access_token: "test-access",
        refresh_token: "test-refresh",
        id_token: corruptSignature
          ? `${idToken.slice(0, idToken.lastIndexOf(".") + 1)}invalid-signature`
          : idToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: `openid email ${youtubeScope}`,
      });
    }
    return json({
      access_token: "test-access",
      token_type: "Bearer",
      expires_in: 3600,
    });
  }
  if (url.pathname === "/revoke") return new MockResponse("", { status: 200 });
  if (quotaFailure)
    return json({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403);
  expect(request.headers.get("Authorization")).toBe("Bearer test-access");
  if (url.pathname === "/youtube/v3/subscriptions") {
    const id = url.searchParams.get("pageToken") ? channelB : channelA;
    return json({
      ...(id === channelA ? { nextPageToken: "subscriptions-2" } : {}),
      items: [
        {
          snippet: {
            title: id === channelA ? "チャンネルA" : "チャンネルB",
            resourceId: { channelId: id },
            thumbnails: { default: { url: "https://example.net/icon.png" } },
          },
        },
      ],
    });
  }
  if (url.pathname === "/youtube/v3/channels")
    return json({
      items: [channelA, channelB].map((id) => ({
        id,
        snippet: { title: id === channelA ? "チャンネルA" : "チャンネルB" },
        contentDetails: {
          relatedPlaylists: {
            uploads: id === channelA ? "uploads-A" : "uploads-B",
          },
        },
      })),
    });
  if (url.pathname === "/youtube/v3/playlistItems") {
    if (
      uploadFailure &&
      url.searchParams.get("playlistId") === uploadFailure.playlist &&
      (!uploadFailure.page ||
        url.searchParams.get("pageToken") === uploadFailure.page)
    )
      return json(
        {
          error: {
            message: "非表示にする上流の生メッセージ",
            errors: [{ reason: uploadFailure.reason }],
          },
        },
        uploadFailure.status,
      );
    if (url.searchParams.get("playlistId") === "uploads-B")
      return json({ items: [] });
    if (url.searchParams.get("pageToken"))
      return json({
        ...(extraUploadPage && url.searchParams.get("pageToken") === "uploads-2"
          ? { nextPageToken: "uploads-3" }
          : {}),
        items: [
          {
            contentDetails: {
              videoId: videoIds[2],
              videoPublishedAt: published(86400 * 7),
            },
          },
        ],
      });
    return json({
      nextPageToken: "uploads-2",
      items: [
        {
          contentDetails: {
            videoId: videoIds[0],
            videoPublishedAt: published(60),
          },
        },
        {
          contentDetails: {
            videoId: videoIds[1],
            videoPublishedAt: published(86400 * 2),
          },
        },
      ],
    });
  }
  if (url.pathname === "/youtube/v3/videos") {
    const ids = url.searchParams.get("id")!.split(",");
    return json({
      items: ids.map((id) => ({
        id,
        snippet: {
          channelId: channelA,
          title: `動画 ${id}`,
          publishedAt: published(
            id === videoIds[0]
              ? 60
              : id === videoIds[1]
                ? 86400 * 2
                : 86400 * 7,
          ),
          thumbnails: {
            medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` },
          },
        },
        contentDetails: { duration: "PT3M1S" },
        status: { embeddable: true, privacyStatus: "public" },
      })),
    });
  }
  throw new Error(`テストで許可していない通信: ${url.hostname}${url.pathname}`);
}

function options(script: string): MiniflareOptions {
  const vars = {
    APP_ORIGIN: origin,
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    TOKEN_ENCRYPTION_KEY: key,
    ALLOWED_GOOGLE_EMAIL: "owner@example.net",
    ALLOWED_GOOGLE_SUB: "",
    ALLOW_DEMO: "false",
    UPLOAD_PAGES_PER_CHANNEL: "2",
    SYNC_OVERLAP_SECONDS: "600",
  };
  return {
    cf: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "youtube-kit-tests",
          compatibilityDate: "2026-10-23",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.mjs",
            modules: { "worker.mjs": { type: "esm", contents: script } },
          },
          env: {
            ...Object.fromEntries(
              Object.entries(vars).map(([name, value]) => [
                name,
                { type: "text", value },
              ]),
            ),
            DB: { type: "d1", id: "youtube-kit-tests" },
          },
        },
        dev: { outboundService: { type: "fetcher", handler: upstream } },
      },
    ],
  };
}

async function post(
  path: string,
  body?: object,
  headers: Record<string, string> = {},
) {
  return mf.dispatchFetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      Origin: origin,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body && { body: JSON.stringify(body) }),
  });
}

function cookie(
  response: Awaited<ReturnType<Miniflare["dispatchFetch"]>>,
  name: string,
) {
  return (
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith(name))
      ?.split(";")[0] ?? ""
  );
}

async function login(
  claims: {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    nonce?: string;
  } = {},
) {
  const begin = await mf.dispatchFetch(`${origin}/auth/login`, {
    redirect: "manual",
  });
  expect(begin.status).toBe(302);
  const target = new URL(begin.headers.get("Location")!);
  expect(target.searchParams.get("code_challenge_method")).toBe("S256");
  expect(target.searchParams.get("scope")).toContain(youtubeScope);
  idToken = await new SignJWT({
    nonce: target.searchParams.get("nonce"),
    email: "owner@example.net",
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject(claims.sub ?? sub)
    .setAudience("test-client")
    .setIssuer("https://accounts.google.com")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(pair.privateKey);
  const callbackUrl = `${origin}/auth/callback?code=test-code&state=${target.searchParams.get("state")}`;
  const callback = await mf.dispatchFetch(callbackUrl, {
    redirect: "manual",
    headers: { Cookie: cookie(begin, "__Host-yk_oauth=") },
  });
  return { callback, begin, callbackUrl };
}

async function authenticated() {
  const { callback } = await login();
  expect(callback.status, await callback.clone().text()).toBe(302);
  sessionCookie = cookie(callback, "__Host-yk_session=");
  const status = await mf.dispatchFetch(`${origin}/api/status`, {
    headers: { Cookie: sessionCookie },
  });
  const data = await status.json<{ csrfToken: string }>();
  csrf = data.csrfToken;
}

async function runSync(full = false) {
  const started = await post("/api/sync/start", { full });
  expect(started.status, await started.clone().text()).toBe(200);
  let state = await started.json<{
    jobId: string;
    done: boolean;
    issues: SyncIssue[];
    processedChannels: number;
  }>();
  for (let steps = 0; !state.done && steps < 20; steps++) {
    const response = await post("/api/sync/step", { jobId: state.jobId });
    expect(response.status, await response.clone().text()).toBe(200);
    state = await response.json();
  }
  expect(state.done).toBe(true);
  return state;
}

beforeAll(async () => {
  pair = await generateKeyPair("RS256");
  jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test-key",
    use: "sig",
    alg: "RS256",
  };
  mf = new Miniflare(
    options(await readFile(".wrangler/test/worker.mjs", "utf8")),
  );
  db = await mf.getD1Database("DB");
  const schema =
    (await readFile("migrations/0001_accounts_catalog.sql", "utf8")) +
    "\n" +
    (await readFile("migrations/0002_channel_ranges.sql", "utf8"));
  // D1のexecは行単位で実行するため、CREATE文を一文ずつ渡す。
  for (const sql of schema
    .replace(/^--.*$/gm, "")
    .split(";")
    .filter((part) => part.trim()))
    await db.prepare(sql).run();
}, 30000);

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM accounts"),
    db.prepare("DELETE FROM owner_binding"),
    db.prepare("DELETE FROM oauth_attempts"),
  ]);
  idToken = "";
  quotaFailure = false;
  seen = [];
  sessionCookie = "";
  csrf = "";
  corruptSignature = false;
  uploadFailure = null;
  extraUploadPage = false;
});
afterAll(async () => {
  await mf?.dispose();
});

describe("認証とAPIアクセス（Workers + 実D1バインディング）", () => {
  it("未認証の一覧取得と更新を拒否する", async () => {
    expect((await mf.dispatchFetch(`${origin}/api/catalog`)).status).toBe(401);
    expect((await post("/api/sync/start", {})).status).toBe(401);
  });
  it("署名付きGoogle IDから所有者を固定し、安全なCookieとCSRFトークンを発行する", async () => {
    const result = await login();
    expect(result.callback.status).toBe(302);
    const header = result.callback.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-yk_session="))!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(await db.prepare("SELECT sub FROM owner_binding").first("sub")).toBe(
      sub,
    );
    const account = await db
      .prepare("SELECT refresh_token_cipher FROM accounts")
      .first<{ refresh_token_cipher: string }>();
    expect(account?.refresh_token_cipher).not.toContain("test-refresh");
    expect(
      (
        await mf.dispatchFetch(result.callbackUrl, {
          headers: { Cookie: cookie(result.begin, "__Host-yk_oauth=") },
          redirect: "manual",
        })
      ).status,
    ).toBe(400);
  });
  it("stateなしのコールバックはトークン交換前に拒否する", async () => {
    expect(
      (
        await mf.dispatchFetch(
          `${origin}/auth/callback?code=unknown&state=unknown`,
        )
      ).status,
    ).toBe(400);
    expect(seen).toHaveLength(0);
  });
  it("許可されないメールや未確認メールのGoogleアカウントを拒否する", async () => {
    expect((await login({ email: "other@example.net" })).callback.status).toBe(
      403,
    );
    expect((await login({ email_verified: false })).callback.status).toBe(403);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
    ).toBe(0);
  });
  it("初回と同じメールでも別subへの置き換えを拒否する", async () => {
    await authenticated();
    expect((await login({ sub: "other-sub" })).callback.status).toBe(403);
  });
  it("異なるnonceと不正なIDトークン署名を拒否する", async () => {
    expect((await login({ nonce: "wrong-nonce" })).callback.status).toBe(401);
    corruptSignature = true;
    expect((await login()).callback.status).toBe(401);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
    ).toBe(0);
  });
  it("期限切れのセッションで一覧を返さない", async () => {
    await authenticated();
    await db
      .prepare("UPDATE sessions SET expires_at = ?")
      .bind(seconds() - 1)
      .run();
    expect(
      (
        await mf.dispatchFetch(`${origin}/api/catalog`, {
          headers: { Cookie: sessionCookie },
        })
      ).status,
    ).toBe(401);
  });
  it("OriginとCSRFを検証し、認証情報を応答本文に含めない", async () => {
    await authenticated();
    expect(
      (
        await post(
          "/api/sync/start",
          {},
          { Origin: "https://evil.example.net" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post("/api/sync/start", {}, { "X-CSRF-Token": "wrong" })).status,
    ).toBe(403);
    const response = await mf.dispatchFetch(`${origin}/api/status`, {
      headers: { Cookie: sessionCookie },
    });
    const body = await response.text();
    expect(body).not.toMatch(
      /test-access|test-refresh|test-client-secret|refresh_token_cipher/,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("チャンネル別の表示範囲と履歴", () => {
  it("履歴取得と保存キュー取得も認証・CSRF・入力を検証する", async () => {
    expect(
      (await post("/api/channel/history", { channelId: channelA })).status,
    ).toBe(401);
    expect(
      (await mf.dispatchFetch(`${origin}/api/saved-videos?ids=${videoIds[0]}`))
        .status,
    ).toBe(401);
    await authenticated();
    await runSync();
    expect(
      (
        await post(
          "/api/channel/history",
          { channelId: channelA },
          { "X-CSRF-Token": "wrong" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post("/api/channel/history", { channelId: "invalid" })).status,
    ).toBe(400);
    expect(
      (
        await mf.dispatchFetch(`${origin}/api/catalog?channelId=invalid`, {
          headers: { Cookie: sessionCookie },
        })
      ).status,
    ).toBe(400);
  });
  it("履歴ページの取得失敗ではカーソルと保存済み動画を進めず、再試行できる", async () => {
    await authenticated();
    extraUploadPage = true;
    await runSync();
    uploadFailure = {
      playlist: "uploads-A",
      status: 500,
      reason: "backendError",
      page: "uploads-3",
    };
    expect(
      (await post("/api/channel/history", { channelId: channelA })).status,
    ).toBe(502);
    expect(
      await db
        .prepare("SELECT history_page_token FROM channels WHERE channel_id = ?")
        .bind(channelA)
        .first("history_page_token"),
    ).toBe("uploads-3");
    expect(
      await db
        .prepare(
          "SELECT history_lease_token FROM channels WHERE channel_id = ?",
        )
        .bind(channelA)
        .first("history_lease_token"),
    ).toBeNull();
    uploadFailure = null;
    expect(
      (await post("/api/channel/history", { channelId: channelA })).status,
    ).toBe(200);
  });
  it("中断中の過去分再取得と通常更新は、明示されたモードへ安全に切り替える", async () => {
    await authenticated();
    const normal = await (
      await post("/api/sync/start", {})
    ).json<{ jobId: string }>();
    const full = await (
      await post("/api/sync/start", { full: true })
    ).json<{ jobId: string }>();
    expect(full.jobId).not.toBe(normal.jobId);
    expect(
      JSON.parse(
        (await db
          .prepare("SELECT state_json FROM sync_jobs")
          .first("state_json")) as string,
      ).full,
    ).toBe(true);
    const latest = await (
      await post("/api/sync/start", {})
    ).json<{ jobId: string }>();
    expect(latest.jobId).not.toBe(full.jobId);
    expect(
      JSON.parse(
        (await db
          .prepare("SELECT state_json FROM sync_jobs")
          .first("state_json")) as string,
      ).full,
    ).toBe(false);
  });
  it("全体は最新30件、月1投稿のチャンネルもそのチャンネルだけの最新30件を返す", async () => {
    await authenticated();
    await runSync();
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1100)
      INSERT INTO videos(sub,video_id,channel_id,title,thumbnail_url,published_at,duration_seconds,embeddable,availability,last_fetched_at)
      SELECT ?,printf('%011d',70000000000+i),?,'高頻度動画','',strftime('%Y-%m-%dT%H:%M:%SZ','now','-'||i||' minutes'),200,1,'public',? FROM n`,
      )
      .bind(sub, channelA, seconds())
      .run();
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<35)
      INSERT INTO videos(sub,video_id,channel_id,title,thumbnail_url,published_at,duration_seconds,embeddable,availability,last_fetched_at)
      SELECT ?,printf('%011d',80000000000+i),?,'月1動画','',strftime('%Y-%m-%dT%H:%M:%SZ','now','-'||(i*30)||' days'),200,1,'public',? FROM n`,
      )
      .bind(sub, channelB, seconds())
      .run();
    const get = async (query: string) =>
      (
        await mf.dispatchFetch(`${origin}/api/catalog${query}`, {
          headers: { Cookie: sessionCookie },
        })
      ).json<{
        videos: { id: string; channelId: string }[];
        hasMore: boolean;
        cacheHasMore: boolean;
      }>();
    const all = await get("");
    expect(all.videos).toHaveLength(30);
    expect(all.videos.every((video) => video.channelId === channelA)).toBe(
      true,
    );
    const channel = await get(
      `?channelId=${channelB}&limit=30&minDuration=180`,
    );
    expect(channel.videos).toHaveLength(30);
    expect(channel.videos.every((video) => video.channelId === channelB)).toBe(
      true,
    );
    expect(channel.cacheHasMore).toBe(true);
    const more = await get(`?channelId=${channelB}&limit=60`);
    expect(more.videos).toHaveLength(35);
    expect(more.hasMore).toBe(false);
    const saved = await mf.dispatchFetch(
      `${origin}/api/saved-videos?ids=80000000035`,
      { headers: { Cookie: sessionCookie } },
    );
    expect(await saved.json()).toHaveLength(1);
  });
  it("チャンネルごとに取得範囲の両端と過去分の続きを保存し、さらに表示で続きだけ取得する", async () => {
    await authenticated();
    extraUploadPage = true;
    await runSync();
    const range = await db
      .prepare(
        "SELECT newest_published_at, oldest_published_at, history_page_token, history_complete FROM channels WHERE channel_id = ?",
      )
      .bind(channelA)
      .first<{
        newest_published_at: string;
        oldest_published_at: string;
        history_page_token: string;
        history_complete: number;
      }>();
    expect(Date.parse(range!.newest_published_at)).toBeGreaterThan(
      Date.parse(range!.oldest_published_at),
    );
    expect(range!.history_page_token).toBe("uploads-3");
    expect(range!.history_complete).toBe(0);
    seen = [];
    expect(
      (await post("/api/channel/history", { channelId: channelA })).status,
    ).toBe(200);
    expect(seen.some((url) => url.includes("pageToken=uploads-3"))).toBe(true);
    expect(
      await db
        .prepare("SELECT history_complete FROM channels WHERE channel_id = ?")
        .bind(channelA)
        .first("history_complete"),
    ).toBe(1);
    seen = [];
    expect(
      (await post("/api/channel/history", { channelId: channelA })).status,
    ).toBe(200);
    expect(seen).toEqual([]);
  });
  it("古い取得カーソルやAPIの無効ページ情報は先頭から再確認できる", async () => {
    await authenticated();
    extraUploadPage = true;
    await runSync();
    uploadFailure = {
      playlist: "uploads-A",
      status: 400,
      reason: "invalidPageToken",
      page: "uploads-3",
    };
    const reset = await post("/api/channel/history", { channelId: channelA });
    expect(await reset.json()).toMatchObject({ reset: true });
    uploadFailure = null;
    seen = [];
    expect(
      (await post("/api/channel/history", { channelId: channelA })).status,
    ).toBe(200);
    expect(seen.some((url) => url.includes("pageToken="))).toBe(false);
    await db
      .prepare(
        "UPDATE channels SET history_started_at = ? WHERE channel_id = ?",
      )
      .bind(seconds() - 28 * 86400, channelA)
      .run();
    seen = [];
    expect(
      (await post("/api/channel/history", { channelId: channelA })).status,
    ).toBe(200);
    expect(seen.some((url) => url.includes("pageToken="))).toBe(false);
  });
  it("全体更新と履歴取得のリースが競合した場合はデータを二重更新しない", async () => {
    await authenticated();
    await runSync();
    await db
      .prepare("UPDATE sync_jobs SET lease_until = ?")
      .bind(seconds() + 60)
      .run();
    expect(
      (await post("/api/channel/history", { channelId: channelA })).status,
    ).toBe(409);
    await db.prepare("UPDATE sync_jobs SET lease_until = 0").run();
    const started = await post("/api/sync/start", {});
    const state = await started.json<{ jobId: string }>();
    await db
      .prepare(
        "UPDATE channels SET history_lease_until = ? WHERE channel_id = ?",
      )
      .bind(seconds() + 60, channelA)
      .run();
    expect((await post("/api/sync/step", state)).status).toBe(409);
  });
  it("通常更新の失敗では通知の世代を変えず、過去分再取得の再失敗でだけ世代を変える", async () => {
    await authenticated();
    uploadFailure = {
      playlist: "uploads-B",
      status: 404,
      reason: "playlistNotFound",
    };
    await runSync();
    expect(
      await db
        .prepare("SELECT warning_revision FROM accounts")
        .first("warning_revision"),
    ).toBe("");
    await runSync(true);
    const first = await db
      .prepare("SELECT warning_revision FROM accounts")
      .first("warning_revision");
    expect(first).not.toBe("");
    await runSync();
    expect(
      await db
        .prepare("SELECT warning_revision FROM accounts")
        .first("warning_revision"),
    ).toBe(first);
    await runSync(true);
    expect(
      await db
        .prepare("SELECT warning_revision FROM accounts")
        .first("warning_revision"),
    ).not.toBe(first);
  });
  it("一部失敗しても成功したチャンネルの基準日時を使い、次回に過去分を繰り返し取得しない", async () => {
    await authenticated();
    uploadFailure = {
      playlist: "uploads-B",
      status: 404,
      reason: "playlistNotFound",
    };
    await runSync();
    expect(
      await db
        .prepare("SELECT video_watermark FROM channels WHERE channel_id = ?")
        .bind(channelA)
        .first("video_watermark"),
    ).toBeGreaterThan(0);
    expect(
      await db
        .prepare("SELECT video_watermark FROM channels WHERE channel_id = ?")
        .bind(channelB)
        .first("video_watermark"),
    ).toBeNull();
    seen = [];
    await runSync();
    expect(seen.some((url) => url.includes("pageToken=uploads-2"))).toBe(false);
  });
});

describe("チャンネル同期と日時による差分取得", () => {
  it("登録チャンネルの全ページを取得し、動画を重複なく保存する", async () => {
    await authenticated();
    await runSync();
    expect(seen.some((url) => url.includes("pageToken=subscriptions-2"))).toBe(
      true,
    );
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM channels WHERE subscribed = 1")
        .first("n"),
    ).toBe(2);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM videos").first("n"),
    ).toBe(3);
    const response = await mf.dispatchFetch(`${origin}/api/catalog`, {
      headers: { Cookie: sessionCookie },
    });
    const body = await response.json<{
      videos: unknown[];
      watermark: number;
    }>();
    expect(body.videos).toHaveLength(3);
    expect(body.watermark).toBeGreaterThan(0);
  });
  it("通常更新は古い日付で打ち切り、明示的な再取得では過去ページも取得する", async () => {
    await authenticated();
    await runSync();
    seen = [];
    await runSync();
    expect(seen.some((url) => url.includes("pageToken=uploads-2"))).toBe(false);
    const detailRequests = seen.filter((url) =>
      url.includes("/youtube/v3/videos"),
    );
    expect(detailRequests).toHaveLength(1);
    expect(detailRequests[0]).not.toContain(videoIds[1]);
    seen = [];
    await runSync(true);
    expect(seen.some((url) => url.includes("pageToken=uploads-2"))).toBe(true);
  });
  it("API失敗時に基準日時と保存済み一覧を失わず、同じジョブを再開できる", async () => {
    await authenticated();
    await runSync();
    await db
      .prepare("UPDATE accounts SET video_watermark = ?")
      .bind(seconds() - 7200)
      .run();
    const watermark = await db
      .prepare("SELECT video_watermark FROM accounts")
      .first("video_watermark");
    const started = await post("/api/sync/start", {});
    const state = await started.json<{ jobId: string }>();
    quotaFailure = true;
    expect((await post("/api/sync/step", state)).status).toBe(429);
    expect(
      await db
        .prepare("SELECT video_watermark FROM accounts")
        .first("video_watermark"),
    ).toBe(watermark);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM videos").first("n"),
    ).toBe(3);
    quotaFailure = false;
    await runSync();
  });
  it.each([
    [404, "playlistNotFound"],
    [403, "playlistItemsNotAccessible"],
    [500, "backendError"],
  ])(
    "チャンネルのHTTP %i失敗を記録し、後続を取得して部分結果を表示できる",
    async (status, reason) => {
      await authenticated();
      uploadFailure = { playlist: "uploads-B", status, reason };
      const result = await runSync();
      expect(result.processedChannels).toBe(2);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].title).toBe("チャンネルB");
      expect(result.issues[0].message).toContain(`HTTP ${status}`);
      const response = await mf.dispatchFetch(`${origin}/api/catalog`, {
        headers: { Cookie: sessionCookie },
      });
      const body = await response.json<{
        videos: unknown[];
        watermark: null;
        issues: SyncIssue[];
      }>();
      expect(body.videos).toHaveLength(3);
      expect(body.watermark).toBeNull();
      expect(body.issues).toEqual(result.issues);
      expect(JSON.stringify(body)).not.toContain(
        "非表示にする上流の生メッセージ",
      );
      expect(
        await db
          .prepare("SELECT last_synced_at FROM accounts")
          .first("last_synced_at"),
      ).toBeNull();
    },
  );
  it("途中ページの失敗でも取得済み動画を残し、後続チャンネルへ進み、次回は過去分も再試行する", async () => {
    await authenticated();
    await runSync();
    const previousWatermark = seconds() - 7200;
    await db
      .prepare("UPDATE accounts SET video_watermark = ?")
      .bind(previousWatermark)
      .run();
    uploadFailure = {
      playlist: "uploads-A",
      status: 404,
      reason: "playlistNotFound",
      page: "uploads-2",
    };
    seen = [];
    const result = await runSync(true);
    expect(result.issues[0].channelId).toBe(channelA);
    expect(seen.some((url) => url.includes("playlistId=uploads-B"))).toBe(true);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM videos").first("n"),
    ).toBe(3);
    expect(
      await db
        .prepare("SELECT video_watermark FROM accounts")
        .first("video_watermark"),
    ).toBe(previousWatermark);
    uploadFailure = null;
    seen = [];
    const retried = await runSync();
    expect(retried.issues).toEqual([]);
    expect(seen.some((url) => url.includes("pageToken=uploads-2"))).toBe(true);
    expect(
      await db
        .prepare("SELECT video_watermark FROM accounts")
        .first("video_watermark"),
    ).toBeGreaterThan(previousWatermark);
  });
  it.each([
    [401, "authError", 401],
    [403, "quotaExceeded", 429],
    [429, "unknown", 429],
    [403, "insufficientPermissions", 403],
  ])(
    "認証・利用上限のHTTP %iは飛ばさず全体を中断する",
    async (status, reason, expected) => {
      await authenticated();
      const started = await post("/api/sync/start", {});
      const state = await started.json<{ jobId: string }>();
      for (let step = 0; step < 3; step++)
        expect((await post("/api/sync/step", state)).status).toBe(200);
      uploadFailure = { playlist: "uploads-A", status, reason };
      seen = [];
      expect((await post("/api/sync/step", state)).status).toBe(expected);
      expect(seen.some((url) => url.includes("playlistId=uploads-B"))).toBe(
        false,
      );
      expect(
        await db
          .prepare("SELECT video_watermark FROM accounts")
          .first("video_watermark"),
      ).toBeNull();
    },
  );
  it("警告フィールドのない更新前のジョブも続きから再開する", async () => {
    await authenticated();
    const started = await post("/api/sync/start", {});
    const state = await started.json<{ jobId: string }>();
    await db
      .prepare(
        "UPDATE sync_jobs SET state_json = json_remove(state_json, '$.issues')",
      )
      .run();
    expect((await post("/api/sync/step", state)).status).toBe(200);
    expect((await runSync()).issues).toEqual([]);
  });
  it("通常更新の失敗を再試行しても初回用の2ページ上限へ切り替わらない", async () => {
    await authenticated();
    await runSync();
    await db
      .prepare("UPDATE accounts SET video_watermark = ?")
      .bind(seconds() - 20 * 86400)
      .run();
    await db
      .prepare("UPDATE channels SET video_watermark = ?")
      .bind(seconds() - 20 * 86400)
      .run();
    uploadFailure = {
      playlist: "uploads-A",
      status: 404,
      reason: "playlistNotFound",
    };
    expect((await runSync()).issues).toHaveLength(1);
    uploadFailure = null;
    extraUploadPage = true;
    seen = [];
    expect((await runSync()).issues).toEqual([]);
    expect(seen.some((url) => url.includes("pageToken=uploads-3"))).toBe(true);
  });
  it("同時開始は同じジョブへ合流し、別処理のリース中はステップを拒否する", async () => {
    await authenticated();
    const [a, b] = await Promise.all([
      post("/api/sync/start", {}),
      post("/api/sync/start", {}),
    ]);
    const one = await a.json<{ jobId: string }>();
    const two = await b.json<{ jobId: string }>();
    expect(one.jobId).toBe(two.jobId);
    await db
      .prepare("UPDATE sync_jobs SET lease_until = ?")
      .bind(seconds() + 60)
      .run();
    expect((await post("/api/sync/step", one)).status).toBe(409);
  });
  it("ログアウト後は同じCookieで一覧を取得できない", async () => {
    await authenticated();
    expect((await post("/api/logout")).status).toBe(200);
    expect(
      (
        await mf.dispatchFetch(`${origin}/api/catalog`, {
          headers: { Cookie: sessionCookie },
        })
      ).status,
    ).toBe(401);
  });
  it("期限整理は古い動画キャッシュを消し、現在のセッションと所有者設定を残す", async () => {
    await authenticated();
    await runSync();
    await db
      .prepare("UPDATE videos SET last_fetched_at = ?")
      .bind(seconds() - 31 * 86400)
      .run();
    await cleanup(await mf.getBindings<Env>());
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM videos").first("n"),
    ).toBe(0);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
    ).toBe(1);
    expect(await db.prepare("SELECT sub FROM owner_binding").first("sub")).toBe(
      sub,
    );
  });
  it("接続解除では個人データを消し、所有者の固定は保持する", async () => {
    await authenticated();
    await runSync();
    expect((await post("/api/disconnect")).status).toBe(200);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM accounts").first("n"),
    ).toBe(0);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM videos").first("n"),
    ).toBe(0);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM sessions").first("n"),
    ).toBe(0);
    expect(await db.prepare("SELECT sub FROM owner_binding").first("sub")).toBe(
      sub,
    );
  });
});

it.each([401, 429])(
  "JSON以外のHTTP %iも認証・利用上限として扱う",
  async (status) => {
    const api = new YouTubeClient(
      "test-access",
      async () => new Response("temporarily unavailable", { status }),
    );
    await expect(api.uploads("uploads-A")).rejects.toMatchObject({
      code: status === 401 ? "RECONNECT_REQUIRED" : "YOUTUBE_QUOTA",
    });
  },
);

it("動画の期間を秒に変換し、更新日時の境界を含めて抽出する", () => {
  expect(durationSeconds("P1DT2H3M4S")).toBe(93784);
  const items = [
    { id: "new", publishedAt: "2026-10-29T00:00:01Z" },
    { id: "boundary", publishedAt: "2026-10-29T00:00:00Z" },
    { id: "old", publishedAt: "2026-10-28T23:59:59Z" },
  ];
  expect(
    selectRecentUploads(items, Date.parse("2026-10-29T00:00:00Z") / 1000),
  ).toEqual({ ids: ["new", "boundary"], reachedCutoff: true });
});
