import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function harness(failInstall = false, redirectedShell = false) {
  const listeners = new Map<string, (event: any) => void>();
  const deleted: string[] = [];
  const stored: string[] = [];
  let activated = false;
  const cache = {
    addAll: async (urls: Request[]) => {
      if (failInstall) throw new Error("offline");
      stored.push(...urls.map((r) => new URL(r.url).pathname));
    },
    match: async (key: string) => {
      const response = new Response(`cached:${key}`, {
        headers: { "Content-Type": "text/html" },
      });
      if (redirectedShell && key === "/index.html")
        Object.defineProperty(response, "redirected", { value: true });
      return response;
    },
  };
  const source = (await readFile("pwa/sw.js", "utf8"))
    .replace('"__CACHE_NAME__"', '"youtubekit-shell-current"')
    .replace(
      "__PRECACHE_URLS__",
      JSON.stringify([
        "/index.html",
        "/assets/app.js",
        "/manifest.webmanifest",
      ]),
    );
  class LocalRequest extends Request {
    constructor(url: string, options: RequestInit) {
      super(new URL(url, "https://app.example.net"), options);
    }
  }
  vm.runInNewContext(source, {
    self: {
      location: { origin: "https://app.example.net" },
      clients: { claim: async () => {} },
      skipWaiting: async () => {
        activated = true;
      },
      addEventListener: (name: string, fn: (event: any) => void) =>
        listeners.set(name, fn),
    },
    caches: {
      open: async () => cache,
      delete: async (name: string) => {
        deleted.push(name);
      },
      keys: async () => [
        "other-app",
        "youtubekit-shell-old",
        "youtubekit-shell-previous",
        "youtubekit-shell-current",
      ],
    },
    Request: LocalRequest,
    Response,
    URL,
    fetch: async () => new Response("network"),
  });
  const lifecycle = async (name: string, extra = {}) => {
    let work: Promise<unknown> = Promise.resolve();
    listeners.get(name)!({
      waitUntil: (promise: Promise<unknown>) => {
        work = promise;
      },
      ...extra,
    });
    await work;
  };
  const fetchResponse = async (path: string, method = "GET", mode = "cors") => {
    let result: Promise<Response> | undefined;
    listeners.get("fetch")!({
      request: {
        url: new URL(path, "https://app.example.net").href,
        method,
        mode,
        redirect: "manual",
      },
      respondWith: (response: Promise<Response>) => {
        result = response;
      },
    });
    return result ? await result : null;
  };
  const fetchEvent = async (path: string, method = "GET", mode = "cors") =>
    (await fetchResponse(path, method, mode))?.text() ?? null;
  return {
    lifecycle,
    fetchEvent,
    fetchResponse,
    deleted,
    stored,
    isActivated: () => activated,
  };
}

describe("アプリ本体だけのService Worker", () => {
  it("転送を経たHTMLも認証後のmanual画面遷移に返せる応答へ変換する", async () => {
    const sw = await harness(false, true);
    for (const path of ["/", "/index.html", "/?auth_error=denied"]) {
      const response = await sw.fetchResponse(path, "GET", "navigate");
      expect(response?.redirected).toBe(false);
      expect(response?.status).toBe(200);
      expect(response?.headers.get("Content-Type")).toBe("text/html");
      expect(await response?.text()).toBe("cached:/index.html");
    }
    expect(await sw.fetchResponse("/auth/callback?code=private")).toBeNull();
  });
  it("静的ファイルだけ保存し、自動で新版を適用しない", async () => {
    const sw = await harness();
    await sw.lifecycle("install");
    expect(sw.stored).toEqual([
      "/index.html",
      "/assets/app.js",
      "/manifest.webmanifest",
    ]);
    expect(sw.isActivated()).toBe(false);
  });
  it("インストール失敗では新版だけ削除し、旧版を壊さない", async () => {
    const sw = await harness(true);
    await expect(sw.lifecycle("install")).rejects.toThrow("offline");
    expect(sw.deleted).toEqual(["youtubekit-shell-current"]);
  });
  it("更新は明示操作だけで行い、直前の版と他アプリのキャッシュを残す", async () => {
    const sw = await harness();
    await sw.lifecycle("message", { data: { type: "APPLY_UPDATE" } });
    expect(sw.isActivated()).toBe(true);
    await sw.lifecycle("activate");
    expect(sw.deleted).toEqual(["youtubekit-shell-old"]);
  });
  it("オフラインでもシェルを返し、API・認証・外部動画・画像へ介入しない", async () => {
    const sw = await harness();
    expect(await sw.fetchEvent("/", "GET", "navigate")).toBe(
      "cached:/index.html",
    );
    expect(await sw.fetchEvent("/assets/app.js")).toBe("cached:/assets/app.js");
    for (const path of [
      "/api/catalog",
      "/api/status",
      "/auth/callback?code=private",
      "https://www.youtube.com/embed/example",
      "https://i.ytimg.com/example.png",
      "/unknown.png",
    ])
      expect(await sw.fetchEvent(path)).toBeNull();
    expect(await sw.fetchEvent("/api/sync/start", "POST")).toBeNull();
  });
});
