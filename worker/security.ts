import { AppError } from "./errors";

// 鍵やセッションの実値をログへ出さず、標準Web Cryptoで扱う。
export function randomToken(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return toBase64(new Uint8Array(hash));
}

// 先に固定長へハッシュ化してから比較し、秘密値の比較時間を揃える。
export async function sameSecret(
  left: string,
  right: string,
): Promise<boolean> {
  const encode = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = await Promise.all([encode(left), encode(right)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export function validEncryptionKey(value: string | undefined): boolean {
  try {
    return !!value && fromBase64(value).length === 32;
  } catch {
    return false;
  }
}

// 用途と所有者を追加認証データへ含め、別レコードへの暗号文の差し替えを拒否する。
export async function encryptSecret(
  value: string,
  base64Key: string,
  purpose: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(base64Key),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
    key,
    new TextEncoder().encode(value),
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(body))}`;
}

export async function decryptSecret(
  value: string,
  base64Key: string,
  purpose: string,
): Promise<string> {
  try {
    const [iv, body] = value.split(".");
    const key = await crypto.subtle.importKey(
      "raw",
      fromBase64(base64Key),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const decoded = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(iv),
        additionalData: new TextEncoder().encode(purpose),
      },
      key,
      fromBase64(body),
    );
    return new TextDecoder().decode(decoded);
  } catch {
    throw new AppError(
      "TOKEN_UNREADABLE",
      "認証情報を読み込めません。暗号鍵の設定を確認し、再接続してください。",
      401,
    );
  }
}
