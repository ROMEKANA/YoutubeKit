import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";

const root = new URL("../", import.meta.url);
const filename = "wrangler.production.jsonc";

// 個人の許可メールや秘密値をGitへ入れず、公開先だけをローカル設定に具体化する。
export function productionConfig(base, origin, databaseId) {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.hostname.endsWith(".invalid") ||
    url.username ||
    url.password
  )
    throw new Error(
      "公開先は末尾の / を付けないHTTPSのURLを指定してください。",
    );
  if (
    !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(databaseId) ||
    /^0{8}-/.test(databaseId)
  )
    throw new Error(
      "Cloudflareで作成した本番D1のdatabase_idを指定してください。",
    );
  const production = base.env?.production;
  if (!production) throw new Error("本番環境の設定が見つかりません。");
  const { env: _env, ...common } = base;
  const vars = { ...production.vars, APP_ORIGIN: origin, ALLOW_DEMO: "false" };
  for (const name of ["ALLOWED_GOOGLE_EMAIL", "ALLOWED_GOOGLE_SUB"])
    if (!vars[name]) delete vars[name];
  return {
    ...common,
    ...production,
    vars,
    d1_databases: production.d1_databases.map((db) => ({
      ...db,
      database_id: databaseId,
    })),
  };
}

// クライアント情報など必要な値だけ送信し、他のローカル環境変数は持ち出さない。
export function productionSecrets(local, config) {
  const result = {};
  for (const name of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "TOKEN_ENCRYPTION_KEY",
  ]) {
    if (!local[name] || local[name].startsWith("replace-"))
      throw new Error(`${name}をローカルで設定してください。`);
    result[name] = local[name];
  }
  if (Buffer.from(result.TOKEN_ENCRYPTION_KEY, "base64").byteLength !== 32)
    throw new Error(
      "TOKEN_ENCRYPTION_KEYは32バイトのBase64形式で設定してください。",
    );
  if (!config.vars?.ALLOWED_GOOGLE_EMAIL && !config.vars?.ALLOWED_GOOGLE_SUB)
    for (const name of ["ALLOWED_GOOGLE_EMAIL", "ALLOWED_GOOGLE_SUB"])
      if (local[name]) result[name] = local[name];
  if (
    !config.vars?.ALLOWED_GOOGLE_SUB &&
    !result.ALLOWED_GOOGLE_SUB &&
    (!(config.vars?.ALLOWED_GOOGLE_EMAIL || result.ALLOWED_GOOGLE_EMAIL) ||
      (
        config.vars?.ALLOWED_GOOGLE_EMAIL || result.ALLOWED_GOOGLE_EMAIL
      ).endsWith("@example.com"))
  )
    throw new Error(
      "許可するGoogleメールアドレスまたはsubを設定してください。",
    );
  return result;
}

export function parseConfig(text) {
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object")
    throw new Error("配備設定ファイルの形式を確認してください。");
  return config;
}

async function readConfig(name) {
  return parseConfig(await readFile(new URL(name, root), "utf8"));
}

function wrangler(args, input) {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("scripts/wrangler.mjs", root)),
      ...args,
      "--config",
      filename,
    ],
    {
      cwd: fileURLToPath(root),
      stdio: [input ? "pipe" : "inherit", "inherit", "inherit"],
      ...(input ? { input } : {}),
    },
  );
  if (result.status !== 0)
    throw new Error(
      "Cloudflareの処理が完了しませんでした。ログイン状態と直前の案内を確認してください。",
    );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "configure") {
    const value = (name) => {
      const i = args.indexOf(name);
      return i < 0 ? "" : args[i + 1];
    };
    const config = productionConfig(
      await readConfig("wrangler.jsonc"),
      value("--origin"),
      value("--database-id"),
    );
    await writeFile(
      new URL(filename, root),
      JSON.stringify(config, null, 2) + "\n",
      { flag: "wx" },
    );
    console.log(
      `${filename}を作成しました。GoogleのリダイレクトURIは ${config.vars.APP_ORIGIN}/auth/callback です。`,
    );
    return;
  }
  let config;
  try {
    config = await readConfig(filename);
  } catch {
    throw new Error(
      "先に deploy:configure で公開URLと本番D1を設定してください。既存ファイルがある場合は形式を確認してください。",
    );
  }
  productionConfig(
    { ...config, env: { production: config } },
    config.vars?.APP_ORIGIN,
    config.d1_databases?.[0]?.database_id,
  );
  if (config.vars?.ALLOW_DEMO !== "false")
    throw new Error("本番のALLOW_DEMOはfalseにしてください。");
  if (command === "secrets") {
    let local;
    try {
      local = parseEnv(await readFile(new URL(".dev.vars", root), "utf8"));
    } catch {
      throw new Error(
        ".dev.varsを読み込めません。ローカルで接続できる設定を用意してください。",
      );
    }
    wrangler(
      ["secret", "bulk"],
      JSON.stringify(productionSecrets(local, config)),
    );
  } else if (command === "migrate")
    wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
  else if (command === "deploy") wrangler(["deploy"]);
  else if (command === "check")
    console.log(
      "公開URL・本番D1の設定を確認しました。秘密値とGoogleの登録URIは公開前に確認してください。",
    );
  else
    throw new Error(
      "configure / secrets / migrate / deploy / checkを指定してください。",
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error?.code === "EEXIST"
        ? `${filename}は既に存在します。上書きしていません。変更する場合は手元のエディターで編集してください。`
        : error.message,
    );
    process.exitCode = 1;
  });
}
