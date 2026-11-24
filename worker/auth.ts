import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import * as oauth from "oauth4webapi";
import { createRemoteJWKSet, jwtVerify, customFetch } from "jose";
import { AppError, requireCondition } from "./errors";
import { getOrigin, requireConfiguration } from "./config";
import {
  decryptSecret,
  encryptSecret,
  randomToken,
  sameSecret,
  sha256,
} from "./security";

export type WorkerContext = Context<{ Bindings: Env }>;
export const youtubeScope = "https://www.googleapis.com/auth/youtube.readonly";
export const youtubeWriteScope = "https://www.googleapis.com/auth/youtube.force-ssl";
export const googleServer: oauth.AuthorizationServer = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
};

export interface Session {
  token_hash: string;
  sub: string;
  csrf_token: string;
  email: string;
  expires_at: number;
  refresh_token_cipher: string | null;
  last_synced_at: number | null;
  grant_id: string;
  youtube_write: number;
  interaction_policy: number;
  youtube_channel_id: string | null;
  youtube_channel_title: string | null;
  youtube_checked_at: number | null;
}

export const now = () => Math.floor(Date.now() / 1000);
const sessionLifetime = 30 * 24 * 60 * 60;

// 公式の固定エンドポイントだけに対して、応答待ち時間を制限する。
export const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(15000) });

function cookieName(env: Env, kind: "session" | "oauth"): string {
  return `${getOrigin(env).startsWith("https:") ? "__Host-" : ""}yk_${kind}`;
}

function cookieOptions(env: Env, maxAge: number) {
  return {
    httpOnly: true,
    secure: getOrigin(env).startsWith("https:"),
    sameSite: "Lax" as const,
    path: "/",
    maxAge,
  };
}

// 初回は指定メールの検証済みIDだけを登録し、以後は不変のsubで所有者を固定する。
export async function acceptOwner(
  env: Env,
  sub: string,
  email: string,
  emailVerified: boolean,
): Promise<boolean> {
  if (env.ALLOWED_GOOGLE_SUB) return sub === env.ALLOWED_GOOGLE_SUB;
  if (
    !emailVerified ||
    email.toLowerCase() !==
      (env.ALLOWED_GOOGLE_EMAIL ?? "").trim().toLowerCase()
  )
    return false;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO owner_binding(id, sub) VALUES (1, ?)",
  )
    .bind(sub)
    .run();
  const owner = await env.DB.prepare(
    "SELECT sub FROM owner_binding WHERE id = 1",
  ).first<{ sub: string }>();
  return owner?.sub === sub;
}

// Cookieの実値はDBへ保存せず、固定長ハッシュで照合する。
export async function getSession(c: WorkerContext): Promise<Session | null> {
  requireConfiguration(c.env);
  const cookie = getCookie(c, cookieName(c.env, "session"));
  if (!cookie || !/^[\w-]{43}$/.test(cookie)) return null;
  const session = await c.env.DB.prepare(
    `SELECT s.*, a.email, a.refresh_token_cipher, a.last_synced_at, a.grant_id, a.youtube_write, a.interaction_policy, a.youtube_channel_id, a.youtube_channel_title, a.youtube_checked_at
    FROM sessions s JOIN accounts a ON a.sub = s.sub WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256(cookie), now())
    .first<Session>();
  if (!session) return null;
  const owner =
    c.env.ALLOWED_GOOGLE_SUB ||
    (
      await c.env.DB.prepare(
        "SELECT sub FROM owner_binding WHERE id = 1",
      ).first<{ sub: string }>()
    )?.sub;
  return owner === session.sub ? session : null;
}

export async function requireSession(
  c: WorkerContext,
  mutation = false,
): Promise<Session> {
  const session = await getSession(c);
  requireCondition(
    session,
    "LOGIN_REQUIRED",
    "Googleアカウントへ接続してください。",
    401,
  );
  if (mutation) {
    requireCondition(
      c.req.header("Origin") === getOrigin(c.env),
      "INVALID_ORIGIN",
      "別のサイトからの操作は許可されていません。",
      403,
    );
    const csrf = c.req.header("X-CSRF-Token") ?? "";
    requireCondition(
      await sameSecret(csrf, session.csrf_token),
      "INVALID_CSRF",
      "接続状態が変わりました。画面を再読み込みしてください。",
      403,
    );
  }
  return session;
}

export async function beginLogin(c: WorkerContext): Promise<Response> {
  return startLogin(c);
}

export const interactionPolicyVersion = 1;

export async function requireInteractionSession(c: WorkerContext, mutation = false) {
  const session = await requireSession(c, mutation);
  requireCondition(session.interaction_policy >= interactionPolicyVersion,
    "PRIVACY_CONSENT_REQUIRED", "更新したプライバシーポリシーを確認し、同意してください。", 403);
  return session;
}

export async function acceptInteractionPolicy(c: WorkerContext) {
  const session = await requireSession(c, true);
  await c.env.DB.prepare("UPDATE accounts SET interaction_policy = ? WHERE sub = ?")
    .bind(interactionPolicyVersion, session.sub).run();
  return c.json({ accepted: true });
}

export async function beginYouTubeConsent(c: WorkerContext): Promise<Response> {
  return startLogin(c, await requireInteractionSession(c, true));
}

async function startLogin(c: WorkerContext, upgrade?: Session): Promise<Response> {
  requireConfiguration(c.env);
  const state = oauth.generateRandomState();
  const verifier = oauth.generateRandomCodeVerifier();
  const nonce = oauth.generateRandomNonce();
  const hash = await sha256(state);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_attempts WHERE expires_at < ?").bind(
      now(),
    ),
    c.env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()),
    c.env.DB.prepare(
      "INSERT INTO oauth_attempts(state_hash, verifier_cipher, nonce, expires_at, upgrade_session, upgrade_grant) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      hash,
      await encryptSecret(
        verifier,
        c.env.TOKEN_ENCRYPTION_KEY,
        `oauth:${hash}`,
      ),
      nonce,
      now() + 600,
      upgrade?.token_hash ?? null,
      upgrade?.grant_id ?? null,
    ),
  ]);
  setCookie(c, cookieName(c.env, "oauth"), state, cookieOptions(c.env, 600));
  const url = new URL(googleServer.authorization_endpoint!);
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${getOrigin(c.env)}/auth/callback`,
    response_type: "code",
    scope: `openid email ${youtubeScope}${upgrade ? ` ${youtubeWriteScope}` : ""}`,
    ...(upgrade && { include_granted_scopes: "true", login_hint: upgrade.email }),
    state,
    nonce,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent select_account",
  }).toString();
  return upgrade ? c.json({ url: url.toString() }) : c.redirect(url.toString());
}

// state・PKCE・nonce・署名・issuer・audienceを検証した後だけセッションを発行する。
export async function finishLogin(c: WorkerContext): Promise<Response> {
  requireConfiguration(c.env);
  const stateCookie = getCookie(c, cookieName(c.env, "oauth")) ?? "";
  deleteCookie(c, cookieName(c.env, "oauth"), cookieOptions(c.env, 0));
  const state = c.req.query("state") ?? "";
  requireCondition(
    stateCookie && state && (await sameSecret(stateCookie, state)),
    "OAUTH_STATE",
    "ログインの有効期限が切れたか、別のブラウザで開始されています。もう一度接続してください。",
  );
  const hash = await sha256(state);
  const attempt = await c.env.DB.prepare(
    "DELETE FROM oauth_attempts WHERE state_hash = ? AND expires_at > ? RETURNING verifier_cipher, nonce, upgrade_session, upgrade_grant",
  )
    .bind(hash, now())
    .first<{ verifier_cipher: string; nonce: string; upgrade_session: string | null; upgrade_grant: string | null }>();
  requireCondition(
    attempt,
    "OAUTH_EXPIRED",
    "ログインの有効期限が切れました。もう一度接続してください。",
  );
  const upgrade = attempt.upgrade_session ? await getSession(c) : null;
  const consentFailure = () => c.redirect(`${getOrigin(c.env)}/?auth_error=youtube_write`);
  if (attempt.upgrade_session && (upgrade?.token_hash !== attempt.upgrade_session || upgrade.grant_id !== attempt.upgrade_grant))
    return consentFailure();
  if (c.req.query("error"))
    return upgrade ? consentFailure() : c.redirect(`${getOrigin(c.env)}/?auth_error=denied`);
  const client: oauth.Client = { client_id: c.env.GOOGLE_CLIENT_ID };
  try {
    const parameters = oauth.validateAuthResponse(
      googleServer,
      client,
      new URL(c.req.url),
      state,
    );
    const response = await oauth.authorizationCodeGrantRequest(
      googleServer,
      client,
      oauth.ClientSecretPost(c.env.GOOGLE_CLIENT_SECRET),
      parameters,
      `${getOrigin(c.env)}/auth/callback`,
      await decryptSecret(
        attempt.verifier_cipher,
        c.env.TOKEN_ENCRYPTION_KEY,
        `oauth:${hash}`,
      ),
      { [oauth.customFetch]: timedFetch },
    );
    const tokens = await oauth.processAuthorizationCodeResponse(
      googleServer,
      client,
      response,
      { expectedNonce: attempt.nonce, requireIdToken: true },
    );
    requireCondition(
      tokens.id_token,
      "OAUTH_TOKEN",
      "Googleの本人確認情報を取得できませんでした。",
    );
    const jwks = createRemoteJWKSet(
      new URL("https://www.googleapis.com/oauth2/v3/certs"),
      { [customFetch]: timedFetch },
    );
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: c.env.GOOGLE_CLIENT_ID,
      algorithms: ["RS256"],
    });
    requireCondition(
      payload.nonce === attempt.nonce &&
        typeof payload.sub === "string" &&
        payload.sub.length <= 255,
      "OAUTH_IDENTITY",
      "Googleの本人確認に失敗しました。",
    );
    requireCondition(
      typeof payload.email === "string",
      "OAUTH_EMAIL",
      "Googleメールアドレスを確認できませんでした。",
    );
    requireCondition(
      await acceptOwner(
        c.env,
        payload.sub,
        payload.email,
        payload.email_verified === true,
      ),
      "ACCOUNT_NOT_ALLOWED",
      "このGoogleアカウントは利用を許可されていません。",
      403,
    );
    const grantedScopes = tokens.scope?.split(" ") ?? [];
    requireCondition(
      grantedScopes.includes(youtubeScope),
      "YOUTUBE_SCOPE_REQUIRED",
      "登録チャンネルを取得する読み取り権限を許可してください。",
      403,
    );
    if (upgrade) {
      if (payload.sub !== upgrade.sub || !grantedScopes.includes(youtubeWriteScope) || !upgrade.refresh_token_cipher)
        return consentFailure();

      // 新規トークンが省略された場合は、既存トークンの更新応答で書き込み権限を確認する。
      const cipher = tokens.refresh_token
        ? await encryptSecret(tokens.refresh_token, c.env.TOKEN_ENCRYPTION_KEY, `refresh:${upgrade.sub}`)
        : upgrade.refresh_token_cipher;
      const refreshed = await refreshGoogle(c.env, upgrade.sub, cipher);
      const scopes = refreshed.scope?.split(" ") ?? (tokens.refresh_token ? grantedScopes : []);
      if (!scopes.includes(youtubeWriteScope) || !scopes.includes(youtubeScope))
        return consentFailure();
      const storedCipher = refreshed.refresh_token
        ? await encryptSecret(refreshed.refresh_token, c.env.TOKEN_ENCRYPTION_KEY, `refresh:${upgrade.sub}`)
        : cipher;
      const changed = await c.env.DB.prepare(
        `UPDATE accounts SET refresh_token_cipher = ?, grant_id = ?, youtube_write = 1,
          youtube_channel_id = NULL, youtube_channel_title = NULL, youtube_checked_at = NULL
         WHERE sub = ? AND grant_id = ? AND refresh_token_cipher = ?`,
      ).bind(storedCipher, randomToken(), upgrade.sub, upgrade.grant_id, upgrade.refresh_token_cipher).run();
      return changed.meta.changes ? c.redirect(`${getOrigin(c.env)}/`) : consentFailure();
    }
    const existing = await c.env.DB.prepare(
      "SELECT refresh_token_cipher FROM accounts WHERE sub = ?",
    )
      .bind(payload.sub)
      .first<{ refresh_token_cipher: string | null }>();
    const refreshCipher = tokens.refresh_token
      ? await encryptSecret(
          tokens.refresh_token,
          c.env.TOKEN_ENCRYPTION_KEY,
          `refresh:${payload.sub}`,
        )
      : existing?.refresh_token_cipher;
    requireCondition(
      refreshCipher,
      "REFRESH_TOKEN_REQUIRED",
      "長期接続用の権限を取得できませんでした。もう一度接続してください。",
    );
    const sessionToken = randomToken();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO accounts(sub, email, refresh_token_cipher, created_at, last_login_at, grant_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sub) DO UPDATE SET email = excluded.email, last_login_at = excluded.last_login_at${tokens.refresh_token
           ? ", refresh_token_cipher = excluded.refresh_token_cipher, grant_id = excluded.grant_id, youtube_write = 0, youtube_channel_id = NULL, youtube_channel_title = NULL, youtube_checked_at = NULL"
           : ""}`,
      ).bind(payload.sub, payload.email, refreshCipher, now(), now(), randomToken()),
      c.env.DB.prepare("DELETE FROM sync_jobs WHERE sub = ?").bind(payload.sub),
      c.env.DB.prepare(
        "INSERT INTO sessions(token_hash, sub, csrf_token, expires_at) VALUES (?, ?, ?, ?)",
      ).bind(
        await sha256(sessionToken),
        payload.sub,
        randomToken(),
        now() + sessionLifetime,
      ),
    ]);
    setCookie(
      c,
      cookieName(c.env, "session"),
      sessionToken,
      cookieOptions(c.env, sessionLifetime),
    );
    return c.redirect(`${getOrigin(c.env)}/`);
  } catch (error) {
    if (upgrade) return consentFailure();
    if (error instanceof AppError) throw error;
    throw new AppError(
      "OAUTH_FAILED",
      "Googleへの接続に失敗しました。OAuth設定を確認して再試行してください。",
      401,
    );
  }
}

async function refreshGoogle(env: Env, sub: string, cipher: string) {
  const client: oauth.Client = { client_id: env.GOOGLE_CLIENT_ID };
  const refresh = await decryptSecret(cipher, env.TOKEN_ENCRYPTION_KEY, `refresh:${sub}`);
  const response = await oauth.refreshTokenGrantRequest(
    googleServer, client, oauth.ClientSecretPost(env.GOOGLE_CLIENT_SECRET),
    refresh, { [oauth.customFetch]: timedFetch },
  );
  return oauth.processRefreshTokenResponse(googleServer, client, response);
}

export type YouTubeGrant = Pick<Session, "sub" | "refresh_token_cipher" | "grant_id" | "youtube_write">;

export async function accessToken(env: Env, session: YouTubeGrant): Promise<string> {
  return (await youtubeAccess(env, session)).token;
}

// トークンの更新・失効は、読み出した認可世代と暗号文が現在も一致する場合に限る。
export async function youtubeAccess(env: Env, session: YouTubeGrant) {
  requireCondition(
    session.refresh_token_cipher,
    "RECONNECT_REQUIRED",
    "Googleへの再接続が必要です。",
    401,
  );
  try {
    const tokens = await refreshGoogle(env, session.sub, session.refresh_token_cipher);
    const canWrite = !!session.youtube_write &&
      (tokens.scope === undefined || tokens.scope.split(" ").includes(youtubeWriteScope));
    if (tokens.refresh_token || canWrite !== !!session.youtube_write)
      await env.DB.prepare(
        "UPDATE accounts SET refresh_token_cipher = ?, youtube_write = ? WHERE sub = ? AND grant_id = ? AND refresh_token_cipher = ?",
      ).bind(
        tokens.refresh_token
          ? await encryptSecret(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY, `refresh:${session.sub}`)
          : session.refresh_token_cipher,
        Number(canWrite), session.sub, session.grant_id, session.refresh_token_cipher,
      ).run();
    return { token: tokens.access_token, canWrite };
  } catch (error) {
    if (
      error instanceof oauth.ResponseBodyError &&
      error.error === "invalid_grant"
    ) {
      await env.DB.prepare(
        `UPDATE accounts SET refresh_token_cipher = NULL, youtube_write = 0,
          youtube_channel_id = NULL, youtube_channel_title = NULL, youtube_checked_at = NULL
         WHERE sub = ? AND grant_id = ? AND refresh_token_cipher = ?`,
      )
        .bind(session.sub, session.grant_id, session.refresh_token_cipher)
        .run();
      throw new AppError(
        "RECONNECT_REQUIRED",
        "Googleの接続期限が切れました。再接続してください。",
        401,
      );
    }
    if (error instanceof AppError) throw error;
    throw new AppError(
      "GOOGLE_UNAVAILABLE",
      "Googleへ接続できません。時間をおいて再試行してください。",
      502,
    );
  }
}

export async function logout(c: WorkerContext): Promise<Response> {
  const session = await requireSession(c, true);
  await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(session.token_hash)
    .run();
  deleteCookie(c, cookieName(c.env, "session"), cookieOptions(c.env, 0));
  return c.json({ ok: true });
}

// 接続解除ではGoogle権限の失効を試み、サーバー内の個人データも削除する。
export async function disconnect(c: WorkerContext): Promise<Response> {
  const session = await requireSession(c, true);
  let revoked = !session.refresh_token_cipher;
  if (session.refresh_token_cipher) {
    try {
      const token = await decryptSecret(
        session.refresh_token_cipher,
        c.env.TOKEN_ENCRYPTION_KEY,
        `refresh:${session.sub}`,
      );
      const response = await timedFetch(
        "https://oauth2.googleapis.com/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
        },
      );
      revoked = response.ok;
      await response.body?.cancel();
    } catch {
      revoked = false;
    }
  }
  await c.env.DB.prepare("DELETE FROM accounts WHERE sub = ?")
    .bind(session.sub)
    .run();
  deleteCookie(c, cookieName(c.env, "session"), cookieOptions(c.env, 0));
  return c.json({ ok: true, revoked });
}
