import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  beginLogin,
  disconnect,
  finishLogin,
  getSession,
  logout,
} from "./auth";
import { missingConfiguration } from "./config";
import { AppError } from "./errors";
import { getCatalog, startSync, stepSync } from "./sync";
import { cleanup } from "./cleanup";

const app = new Hono<{ Bindings: Env }>();

// 認証コードをURLログへ残さず、API・認証応答を共有キャッシュに保存させない。
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  await next();
});
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 1024,
    onError: (c) =>
      c.json(
        { error: "リクエストが大きすぎます。", code: "REQUEST_TOO_LARGE" },
        413,
      ),
  }),
);
app.get("/api/status", async (c) => {
  const missing = missingConfiguration(c.env);
  if (missing.length)
    return c.json({
      configured: false,
      authenticated: false,
      allowDemo: c.env.ALLOW_DEMO === "true",
      missing,
    });
  const session = await getSession(c);
  return c.json({
    configured: true,
    authenticated: !!session,
    allowDemo: c.env.ALLOW_DEMO === "true",
    missing: [],
    ...(session && {
      account: { sub: session.sub, email: session.email },
      csrfToken: session.csrf_token,
      connected: !!session.refresh_token_cipher,
    }),
  });
});
app.get("/auth/login", beginLogin);
app.get("/auth/callback", finishLogin);
app.post("/api/logout", logout);
app.post("/api/disconnect", disconnect);
app.get("/api/catalog", getCatalog);
app.post("/api/sync/start", startSync);
app.post("/api/sync/step", stepSync);
app.all("/api/*", (c) =>
  c.json({ error: "指定されたAPIはありません。", code: "NOT_FOUND" }, 404),
);
app.all("/auth/*", (c) => c.text("指定された認証処理はありません。", 404));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  const known = error instanceof AppError;
  const code = known ? error.code : "INTERNAL_ERROR";
  const message = known
    ? error.message
    : "処理に失敗しました。設定とデータベースを確認してください。";
  if (!known)
    console.error(
      JSON.stringify({
        event: "request_failed",
        requestId: crypto.randomUUID(),
        code,
      }),
    );
  if (c.req.path.startsWith("/auth/"))
    return c.text(
      `${message}\n\nアプリへ戻り、設定から再接続してください。`,
      known ? error.status : 500,
    );
  return c.json({ error: message, code }, known ? error.status : 500);
});

export default {
  fetch: app.fetch,
  scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
