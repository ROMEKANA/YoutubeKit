import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 生成物とログをプロジェクト内へ閉じ込め、ユーザー全体の設定は変更しない。
const root = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(new URL("../.wrangler/types/", import.meta.url), { recursive: true });
mkdirSync(new URL("../.wrangler/logs/", import.meta.url), { recursive: true });
const cli = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: fileURLToPath(
      new URL("../.wrangler/logs/", import.meta.url),
    ),
    WRANGLER_SEND_METRICS: "false",
  },
});
process.exitCode = result.status ?? 1;
