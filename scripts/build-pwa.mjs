import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";

const dist = new URL("../dist/", import.meta.url);
const template = await readFile(
  new URL("../pwa/sw.js", import.meta.url),
  "utf8",
);
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const source = await readFile(
  new URL("../public/icon.svg", import.meta.url),
  "utf8",
);
await mkdir(new URL("icons/", dist), { recursive: true });
// デザインの正本は既存SVG。iPhoneと通常・maskableアイコンを同じ図形から生成する。
for (const size of [180, 192, 512]) {
  const background = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" fill="#244b41"/>${source.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "")}</svg>`;
  await writeFile(
    new URL(`icons/icon-${size}.png`, dist),
    new Resvg(background).render().asPng(),
  );
}
const assets = (await readdir(new URL("assets/", dist)))
  .filter((name) => /\.(js|css)$/.test(name))
  .map((name) => `/assets/${name}`)
  .sort();
const urls = [
  "/index.html",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  ...assets,
];
const hash = createHash("sha256").update(template);
for (const url of urls)
  hash.update(url).update(await readFile(new URL(url.slice(1), dist)));
const cacheName = `youtubekit-shell-${version}-${hash.digest("hex").slice(0, 12)}`;
await writeFile(
  new URL("sw.js", dist),
  template
    .replace('"__CACHE_NAME__"', JSON.stringify(cacheName))
    .replace("__PRECACHE_URLS__", JSON.stringify(urls)),
);
console.log(`PWA生成完了: v${version} / 静的ファイル${urls.length}件`);
