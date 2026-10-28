import { AppError } from "./errors";
import { validEncryptionKey } from "./security";

export function getOrigin(env: Env): string {
  try {
    const url = new URL(env.APP_ORIGIN);
    const local =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname);
    if (
      (!local && url.protocol !== "https:") ||
      url.hostname.endsWith(".invalid") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new AppError(
      "SETUP_REQUIRED",
      "APP_ORIGINにアプリの正しいURLを設定してください。",
      503,
    );
  }
}

export function missingConfiguration(env: Env): string[] {
  const missing: string[] = [];
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const) {
    if (!env[name] || env[name].startsWith("replace-")) missing.push(name);
  }
  if (!validEncryptionKey(env.TOKEN_ENCRYPTION_KEY))
    missing.push("TOKEN_ENCRYPTION_KEY");
  if (
    !env.ALLOWED_GOOGLE_SUB &&
    (!env.ALLOWED_GOOGLE_EMAIL ||
      env.ALLOWED_GOOGLE_EMAIL.endsWith("@example.com"))
  )
    missing.push("ALLOWED_GOOGLE_EMAIL または ALLOWED_GOOGLE_SUB");
  try {
    getOrigin(env);
  } catch {
    missing.push("APP_ORIGIN");
  }
  return missing;
}

export function requireConfiguration(env: Env): void {
  if (missingConfiguration(env).length)
    throw new AppError(
      "SETUP_REQUIRED",
      "Google接続の設定が必要です。設定手順を確認してください。",
      503,
    );
}

export function boundedInteger(
  value: string,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum
    ? parsed
    : fallback;
}
