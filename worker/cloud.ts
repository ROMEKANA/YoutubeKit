import { requireSession, type WorkerContext } from "./auth";
import { AppError } from "./errors";
import {
  validCloudValue,
  type CloudChange,
  type CloudEntry,
} from "../shared/cloud";
import { restoreState } from "../src/model";

function invalid(): never {
  throw new AppError(
    "INVALID_CLOUD_DATA",
    "同期データの形式またはサイズが正しくありません。",
    400,
  );
}

// キー順でページを返し、保存件数が増えても一度に全件を転送しない。
export async function readCloud(c: WorkerContext): Promise<Response> {
  const session = await requireSession(c);
  const after = c.req.query("after") ?? "";
  const rows = await c.env.DB.prepare(
    "SELECT key, value, revision, updated_at AS updatedAt, rowid AS ordinal FROM cloud_entries WHERE sub = ? AND key > ? ORDER BY key LIMIT 201",
  )
    .bind(session.sub, after)
    .all<CloudEntry>();
  return c.json({
    entries: rows.results.slice(0, 200),
    next: rows.results.length > 200 ? rows.results[199].key : null,
  });
}

// 版番号をSQLの条件に含め、同時送信や古いブラウザによる上書きを防ぐ。
export async function writeCloud(c: WorkerContext): Promise<Response> {
  const session = await requireSession(c, true);
  const input = await c.req.json().catch(() => invalid());
  if (!Array.isArray(input?.changes) || input.changes.length > 50) invalid();
  const changes = input.changes as CloudChange[];
  const keys = new Set<string>();
  for (const change of changes) {
    if (
      !change ||
      typeof change.key !== "string" ||
      typeof change.value !== "string" ||
      !Number.isSafeInteger(change.base) ||
      change.base < 0 ||
      !validCloudValue(change.key, change.value) ||
      keys.has(change.key)
    )
      invalid();
    keys.add(change.key);
  }
  const time = Date.now();
  if (changes.length) {
    await c.env.DB.batch(
      changes.map((change) =>
        c.env.DB.prepare(
          `INSERT INTO cloud_entries(sub, key, value, revision, updated_at)
       SELECT ?, ?, ?, 1, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM cloud_entries WHERE sub = ? AND key = ?)
       ON CONFLICT(sub, key) DO UPDATE SET value = excluded.value, revision = cloud_entries.revision + 1, updated_at = excluded.updated_at
       WHERE cloud_entries.revision = ? AND cloud_entries.value != excluded.value
       AND (cloud_entries.key NOT LIKE 'queue/%' OR (cloud_entries.value != 'null' AND excluded.value = 'null'))`,
        ).bind(
          session.sub,
          change.key,
          change.value,
          time,
          change.base,
          session.sub,
          change.key,
          change.base,
        ),
      ),
    );
  }
  const results = keys.size
    ? await c.env.DB.batch<CloudEntry>(
        [...keys].map((key) =>
          c.env.DB.prepare(
            "SELECT key, value, revision, updated_at AS updatedAt, rowid AS ordinal FROM cloud_entries WHERE sub = ? AND key = ?",
          ).bind(session.sub, key),
        ),
      )
    : [];
  const entries = results.flatMap((result) => result.results);
  return c.json({ entries });
}

// 各ブラウザの同期前の状態を一日一世代保存し、直近30世代を保持する。
export async function saveBackup(c: WorkerContext): Promise<Response> {
  const session = await requireSession(c, true);
  const input = await c.req.json().catch(() => invalid());
  if (
    !/^[0-9a-f-]{36}$/i.test(input?.device ?? "") ||
    !input.state ||
    typeof input.state !== "object" ||
    !Array.isArray(input.state.savedQueues) ||
    !Array.isArray(input.state.queue)
  )
    invalid();
  const state = JSON.stringify(restoreState(JSON.stringify(input.state)));
  if (state.length > 500000) invalid();
  const time = Date.now();
  if (input.event !== undefined && !/^[0-9a-f-]{36}$/i.test(input.event))
    invalid();
  const day = input.event
    ? `event/${input.event}`
    : new Date(time + 9 * 3600000).toISOString().slice(0, 10);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO cloud_backups(id, sub, device, day, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), session.sub, input.device, day, state, time),
    c.env.DB.prepare(
      "DELETE FROM cloud_backups WHERE sub = ? AND device = ? AND id NOT IN (SELECT id FROM cloud_backups WHERE sub = ? AND device = ? ORDER BY created_at DESC LIMIT 30)",
    ).bind(session.sub, input.device, session.sub, input.device),
  ]);
  return c.json({ day });
}

export async function readBackups(c: WorkerContext): Promise<Response> {
  const session = await requireSession(c);
  const id = c.req.query("id");
  if (id) {
    const row = await c.env.DB.prepare(
      "SELECT state_json FROM cloud_backups WHERE sub = ? AND id = ?",
    )
      .bind(session.sub, id)
      .first<{ state_json: string }>();
    if (!row)
      throw new AppError(
        "BACKUP_NOT_FOUND",
        "バックアップが見つかりません。",
        404,
      );
    return c.json({ state: JSON.parse(row.state_json) });
  }
  const rows = await c.env.DB.prepare(
    "SELECT id, device, created_at AS createdAt FROM cloud_backups WHERE sub = ? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(session.sub)
    .all();
  return c.json({ backups: rows.results });
}
