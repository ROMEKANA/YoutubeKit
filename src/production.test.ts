import { expect, it } from "vitest";
// 配備スクリプトもダミー値だけで検証し、Cloudflareへは接続しない。
// @ts-expect-error ビルド用のJavaScriptモジュールを直接検証する。
import * as production from "../scripts/production.mjs";
const { productionConfig, productionSecrets, parseConfig } = production;

const base = {
  name: "local",
  vars: { APP_ORIGIN: "http://127.0.0.1:5173" },
  env: {
    production: {
      name: "youtube-kit",
      vars: {
        ALLOW_DEMO: "false",
        ALLOWED_GOOGLE_EMAIL: "",
        ALLOWED_GOOGLE_SUB: "",
      },
      d1_databases: [{ binding: "DB", database_id: "" }],
    },
  },
};
it("配備設定のコメント・末尾カンマを扱い、不正なJSONCを拒否する", () => {
  expect(
    parseConfig('{ /* comment */ "origin": "https://app.example.net", }'),
  ).toEqual({ origin: "https://app.example.net" });
  expect(() => parseConfig('{"broken":')).toThrow();
});
it("本番設定はHTTPS・実DBを必須にし、ローカルのURL・デモ設定を持ち込まない", () => {
  const config = productionConfig(
    base,
    "https://app.example.net",
    "12345678-1234-1234-1234-123456789abc",
  );
  expect(config.vars.APP_ORIGIN).toBe("https://app.example.net");
  expect(config.vars.ALLOW_DEMO).toBe("false");
  expect(config.env).toBeUndefined();
  expect(config.vars.ALLOWED_GOOGLE_EMAIL).toBeUndefined();
  expect(() =>
    productionConfig(
      base,
      "http://app.example.net",
      "12345678-1234-1234-1234-123456789abc",
    ),
  ).toThrow();
  expect(() =>
    productionConfig(
      base,
      "https://replace.invalid",
      "00000000-0000-0000-0000-000000000000",
    ),
  ).toThrow();
});
it("公開用には許可した項目だけ渡し、既に指定した所有者をローカル設定で置き換えない", () => {
  const values = {
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    ALLOWED_GOOGLE_EMAIL: "owner@example.net",
    UNRELATED_TOKEN: "must-not-export",
  };
  expect(
    productionSecrets(values, { vars: {} }).UNRELATED_TOKEN,
  ).toBeUndefined();
  expect(
    productionSecrets(values, { vars: { ALLOWED_GOOGLE_SUB: "fixed-owner" } })
      .ALLOWED_GOOGLE_EMAIL,
  ).toBeUndefined();
  expect(() =>
    productionSecrets(
      { ...values, ALLOWED_GOOGLE_EMAIL: "your-account@example.com" },
      { vars: {} },
    ),
  ).toThrow();
});
