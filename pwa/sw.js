const CACHE_NAME = "__CACHE_NAME__";
const PRECACHE_URLS = __PRECACHE_URLS__;
const PREFIX = "youtubekit-shell-";

// 新版の静的ファイルが全部そろった場合だけインストールを成功させる。
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(
          PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" })),
        );
      } catch (error) {
        await caches.delete(CACHE_NAME);
        throw error;
      }
    })(),
  );
});

// 再生中の旧画面も静的ファイルを使えるよう、直前の世代は残す。
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = (await caches.keys()).filter((name) =>
        name.startsWith(PREFIX),
      );
      const previous = names.filter((name) => name !== CACHE_NAME).slice(-1)[0];
      await Promise.all(
        names
          .filter((name) => name !== CACHE_NAME && name !== previous)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// 利用者が再生終了後に「アプリを更新」を押すまで、既存版から切り替えない。
self.addEventListener("message", (event) => {
  if (event.data?.type === "APPLY_UPDATE") event.waitUntil(self.skipWaiting());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // 認証コード・Cookie付きAPI・YouTube・画像・フォントには一切介入しない。
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/")
  )
    return;
  const shellNavigation =
    request.mode === "navigate" &&
    (url.pathname === "/" || url.pathname === "/index.html");
  if (!shellNavigation && (!PRECACHE_URLS.includes(url.pathname) || url.search))
    return;
  // 同じ画面が新旧のJS/CSSを混在させないよう、インストール済みの版を返す。
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(
        shellNavigation ? "/index.html" : url.pathname,
      );
      // Cloudflareの /index.html → / を経た応答は、画面遷移へそのまま返すと拒否される。
      if (cached?.redirected)
        return new Response(cached.body, {
          status: cached.status,
          statusText: cached.statusText,
          headers: cached.headers,
        });
      return cached || fetch(request);
    })(),
  );
});
