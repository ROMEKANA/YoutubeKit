import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

// 既存の秘密情報を上書きせず、生成した鍵も画面やログに出さない。
const template = await readFile(
  new URL("../.dev.vars.example", import.meta.url),
  "utf8",
);
const content = template.replace(
  '"replace-with-random-base64-key"',
  `"${randomBytes(32).toString("base64")}"`,
);
try {
  await writeFile(new URL("../.dev.vars", import.meta.url), content, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    ".dev.vars を作成しました。Google Client ID・Client Secret・許可するメールアドレスを手元のエディターで設定してください。",
  );
} catch (error) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST"
  )
    console.log(".dev.vars は既に存在します。内容は変更していません。");
  else throw error;
}
