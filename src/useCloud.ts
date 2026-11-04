import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { createSavedQueueId, restoreState, type SavedState } from "./model";
import {
  absentValue,
  applyCloud,
  cloudValues,
  equal,
  type CloudChange,
  type CloudEntry,
} from "../shared/cloud";

interface Options {
  enabled: boolean;
  positionSeconds: number;
  pollSeconds: number;
}
interface BackupJob {
  event: string;
  state: SavedState;
}
interface Metadata {
  device: string;
  rows: Record<string, CloudEntry>;
  pending: Record<string, CloudChange>;
  backups: BackupJob[];
  initialized: boolean;
}
interface Backup {
  id: string;
  device: string;
  createdAt: number;
}
const defaults: Options = {
  enabled: true,
  positionSeconds: 30,
  pollSeconds: 60,
};
const isPosition = (key: string) => key.startsWith("position/");

function readOptions(key: string): Options {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    const interval = (n: unknown, fallback: number) =>
      typeof n === "number" && [0, 15, 30, 60, 120, 300, 600].includes(n)
        ? n
        : fallback;
    return {
      enabled: value?.enabled !== false,
      positionSeconds: interval(value?.positionSeconds, 30),
      pollSeconds: interval(value?.pollSeconds, 60),
    };
  } catch {
    return defaults;
  }
}

// 未送信操作と受信済み版番号も保存し、再起動後の再送で古い値を上書きしない。
function readMetadata(key: string, state: SavedState): Metadata {
  const raw = localStorage.getItem(key);
  if (raw) {
    const value = JSON.parse(raw) as Metadata;
    if (
      !value.device ||
      !value.rows ||
      !value.pending ||
      !Array.isArray(value.backups)
    )
      throw new Error("同期用の保存データを読み込めません。");
    return value;
  }
  return {
    device: createSavedQueueId(),
    rows: {},
    pending: {},
    backups: [{ event: createSavedQueueId(), state }],
    initialized: false,
  };
}

export function useCloud(
  stateKey: string,
  state: SavedState,
  setState: Dispatch<SetStateAction<SavedState>>,
  csrf: string | undefined,
  playing: boolean,
) {
  const [options, setOptions] = useState(() =>
    readOptions(`${stateKey}.cloud-options`),
  );
  const [status, setStatus] = useState("未同期");
  const [backups, setBackups] = useState<Backup[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState(0);
  const runtime = useRef<{
    meta: Metadata;
    seen: Record<string, string>;
  } | null>(null);
  const latest = useRef({ state, csrf, playing, options });
  latest.current = { state, csrf, playing, options };
  const active = useRef(true);
  const running = useRef(false);
  const syncing = useRef<(positions: boolean) => Promise<void>>(async () => {});
  const [dirty, setDirty] = useState(0);
  const urgent = useRef(false);
  const backupDay = useRef("");
  const initialState = useRef(state);

  function persist() {
    if (!runtime.current) return;
    localStorage.setItem(
      `${stateKey}.cloud-meta`,
      JSON.stringify(runtime.current.meta),
    );
  }

  useEffect(() => {
    active.current = true;
    if (!csrf) return;
    try {
      const meta = readMetadata(`${stateKey}.cloud-meta`, latest.current.state);
      runtime.current = {
        meta,
        seen: cloudValues(latest.current.state, meta.device),
      };
      // 新規ブラウザの空の初期値は、既存クラウド設定を上書きする変更として送らない。
      if (!meta.initialized) {
        const hasLocal = !!localStorage.getItem(stateKey);
        for (const [key, value] of Object.entries(runtime.current.seen)) {
          if (
            hasLocal ||
            key.startsWith("queue/") ||
            key.startsWith("position/") ||
            key.startsWith("hidden/")
          )
            meta.pending[key] = { key, value, base: 0 };
        }
        meta.initialized = true;
      }
      persist();
      setReady(true);
    } catch {
      setStatus(
        "同期用データを保存・読込できません。ブラウザの保存領域を確認してください。",
      );
    }
    return () => {
      active.current = false;
    };
  }, [stateKey, csrf]);

  function capture(current: SavedState): boolean {
    if (!runtime.current) return false;
    const { meta, seen } = runtime.current;
    const values = cloudValues(current, meta.device);
    let changed = false;
    for (const key of new Set([...Object.keys(seen), ...Object.keys(values)])) {
      const before = seen[key] ?? absentValue(key);
      const value = values[key] ?? absentValue(key);
      if (before === value) continue;
      if (key.startsWith("queue/") && value === "null") {
        const old = restoreState(JSON.stringify(current));
        old.savedQueues = [...old.savedQueues, JSON.parse(before)];
        meta.backups.push({ event: createSavedQueueId(), state: old });
      }
      meta.pending[key] = {
        key,
        value,
        base: meta.pending[key]?.base ?? meta.rows[key]?.revision ?? 0,
      };
      if (!isPosition(key)) urgent.current = true;
      changed = true;
    }
    runtime.current.seen = values;
    return changed;
  }

  useEffect(() => {
    if (!ready) return;
    const changed = capture(state);
    if (changed) {
      try {
        persist();
        setStatus("未送信あり");
        if (urgent.current) setDirty((n) => n + 1);
      } catch {
        setStatus(
          "未送信データを保存できません。画面を閉じる前に保存領域を確認してください。",
        );
      }
    }
  }, [state, ready]);

  // 受信結果を反映する直前にローカル変更を再確認し、通信中の操作を維持する。
  function receive(
    entries: CloudEntry[],
    sent: Record<string, CloudChange> = {},
  ) {
    if (!active.current || !runtime.current) return;
    capture(latest.current.state);
    const { meta } = runtime.current;
    const applicable: CloudEntry[] = [];
    for (const row of entries) {
      const pending = meta.pending[row.key];
      const submitted = sent[row.key];
      if (pending && submitted && equal(pending, submitted)) {
        if (row.value !== submitted.value) {
          localStorage.setItem(
            `${stateKey}.cloud-conflict.${row.key}`,
            JSON.stringify({ local: submitted, remote: row }),
          );
          meta.backups.push({
            event: createSavedQueueId(),
            state: latest.current.state,
          });
          setConflicts((n) => n + 1);
        }
        delete meta.pending[row.key];
      } else if (pending && submitted && row.value === submitted.value) {
        pending.base = row.revision;
      }
      meta.rows[row.key] = row;
      if (
        !meta.pending[row.key] &&
        !(isPosition(row.key) && latest.current.playing)
      )
        applicable.push(row);
    }
    persist();
    setState((current) => {
      if (!runtime.current) return current;
      // Reactが受信反映を処理するまでに入った操作も、ここで再び保護する。
      capture(current);
      const safe = applicable.filter((row) => !meta.pending[row.key]);
      const next = applyCloud(current, safe, latest.current.playing);
      // サーバーへ保存された順を全ブラウザで共有し、一覧では従来どおり逆順表示する。
      next.savedQueues.sort(
        (a, b) =>
          (meta.rows[`queue/${a.id}`]?.ordinal ?? Number.MAX_SAFE_INTEGER) -
          (meta.rows[`queue/${b.id}`]?.ordinal ?? Number.MAX_SAFE_INTEGER),
      );
      runtime.current.seen = cloudValues(next, meta.device);
      latest.current.state = next;
      persist();
      return equal(current, next) ? current : next;
    });
  }

  async function request(path: string, body?: unknown) {
    const response = await fetch(`/api/cloud/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers:
        body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "X-CSRF-Token": latest.current.csrf ?? "",
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "同期に失敗しました。");
    return data;
  }

  async function sync(includePositions: boolean) {
    if (
      !ready ||
      !runtime.current ||
      !latest.current.csrf ||
      running.current ||
      !navigator.onLine
    )
      return;
    running.current = true;
    setBusy(true);
    setStatus("同期中");
    try {
      const { meta } = runtime.current;
      capture(latest.current.state);
      persist();
      // 削除前や初回移行の退避が成功するまで、変更の送信を始めない。
      while (meta.backups.length) {
        const job = meta.backups[0];
        await request("backups", { device: meta.device, ...job });
        meta.backups.shift();
        persist();
      }
      const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      if (backupDay.current !== day) {
        await request("backups", {
          device: meta.device,
          state: latest.current.state,
        });
        backupDay.current = day;
      }
      capture(latest.current.state);
      persist();
      while (meta.backups.length) {
        const job = meta.backups[0];
        await request("backups", { device: meta.device, ...job });
        meta.backups.shift();
        persist();
      }
      const pending = Object.values(meta.pending).filter(
        (change) => includePositions || !isPosition(change.key),
      );
      for (let start = 0; start < pending.length;) {
        const changes: CloudChange[] = [];
        let size = 0;
        while (start < pending.length && changes.length < 20) {
          const change = pending[start];
          const bytes = new TextEncoder().encode(JSON.stringify(change)).length;
          if (changes.length && size + bytes > 700000) break;
          changes.push(change);
          size += bytes;
          start++;
        }
        const data = await request("state", { changes });
        if (!active.current) return;
        receive(
          data.entries,
          Object.fromEntries(changes.map((change) => [change.key, change])),
        );
      }
      const all: CloudEntry[] = [];
      let after = "";
      do {
        const data = await request(`state?after=${encodeURIComponent(after)}`);
        if (!active.current) return;
        all.push(...data.entries);
        after = data.next ?? "";
      } while (after);
      receive(all);
      // 別ブラウザのキューは既存キューを置換せず、空の新規ブラウザだけへ復元する。
      const deviceRows = all
        .filter(
          (row) =>
            row.key.startsWith("device/") &&
            row.key !== `device/${meta.device}`,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const own = meta.rows[`device/${meta.device}`];
      if (!own && deviceRows.length && !initialState.current.queue.length) {
        const value = JSON.parse(deviceRows[0].value);
        setState((current) =>
          current.queue.length ? current : { ...current, ...value },
        );
      }
      urgent.current =
        meta.backups.length > 0 ||
        Object.keys(meta.pending).some((key) => !isPosition(key));
      if (urgent.current) setDirty((n) => n + 1);
      setStatus(
        Object.keys(meta.pending).length || meta.backups.length
          ? "未送信あり"
          : "同期済み",
      );
    } catch (error) {
      if (active.current)
        setStatus(
          error instanceof Error
            ? `同期失敗：${error.message}`
            : "同期失敗。次の同期で再試行します。",
        );
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  syncing.current = sync;

  useEffect(() => {
    if (!ready || !options.enabled || !csrf) return;
    void syncing.current(options.positionSeconds > 0);
    const wake = () => {
      if (document.visibilityState === "visible")
        void syncing.current(latest.current.options.positionSeconds > 0);
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [ready, options.enabled, csrf]);

  useEffect(() => {
    if (!ready || !options.enabled || !urgent.current) return;
    const timer = window.setTimeout(() => {
      void syncing.current(false);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [dirty, ready, options.enabled]);

  useEffect(() => {
    if (!ready || !options.enabled) return;
    const timers: number[] = [];
    if (options.positionSeconds)
      timers.push(
        window.setInterval(() => {
          if (
            document.visibilityState === "visible" &&
            Object.keys(runtime.current?.meta.pending ?? {}).some(isPosition)
          )
            void syncing.current(true);
        }, options.positionSeconds * 1000),
      );
    if (options.pollSeconds)
      timers.push(
        window.setInterval(() => {
          if (document.visibilityState === "visible")
            void syncing.current(false);
        }, options.pollSeconds * 1000),
      );
    return () => timers.forEach(window.clearInterval);
  }, [ready, options.enabled, options.positionSeconds, options.pollSeconds]);

  function updateOptions(patch: Partial<Options>) {
    const next = { ...options, ...patch };
    try {
      localStorage.setItem(`${stateKey}.cloud-options`, JSON.stringify(next));
      setOptions(next);
    } catch {
      setStatus("同期設定を保存できません。");
    }
  }

  async function listBackups() {
    try {
      setBackups((await request("backups")).backups);
    } catch {
      setStatus("バックアップ一覧を取得できません。");
    }
  }

  async function restoreBackup(id: string) {
    if (
      !runtime.current ||
      running.current ||
      !window.confirm(
        "このバックアップを復元しますか？現在の状態も復元前にクラウドへ退避します。",
      )
    )
      return;
    running.current = true;
    setBusy(true);
    try {
      const { meta } = runtime.current;
      await request("backups", {
        device: meta.device,
        event: createSavedQueueId(),
        state: latest.current.state,
      });
      const restored = restoreState(
        JSON.stringify(
          (await request(`backups?id=${encodeURIComponent(id)}`)).state,
        ),
      );
      let after = "";
      do {
        const data = await request(`state?after=${encodeURIComponent(after)}`);
        for (const row of data.entries as CloudEntry[])
          meta.rows[row.key] = row;
        after = data.next ?? "";
      } while (after);
      restored.savedQueues = restored.savedQueues.map((queue) =>
        meta.rows[`queue/${queue.id}`]?.value === "null"
          ? { ...queue, id: createSavedQueueId() }
          : queue,
      );
      const values = cloudValues(restored, meta.device);
      meta.pending = {};
      for (const key of new Set([
        ...Object.keys(meta.rows),
        ...Object.keys(values),
      ])) {
        if (key.startsWith("device/") && key !== `device/${meta.device}`)
          continue;
        const value = values[key] ?? absentValue(key);
        if (value !== (meta.rows[key]?.value ?? absentValue(key)))
          meta.pending[key] = {
            key,
            value,
            base: meta.rows[key]?.revision ?? 0,
          };
      }
      runtime.current.seen = values;
      persist();
      urgent.current = true;
      setState(restored);
      setDirty((n) => n + 1);
      setStatus("バックアップを復元しました。変更は次の同期で送信します。");
    } catch {
      setStatus("バックアップを復元できませんでした。");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function inheritQueue() {
    const rows = Object.values(runtime.current?.meta.rows ?? {})
      .filter(
        (row) =>
          row.key.startsWith("device/") &&
          row.key !== `device/${runtime.current?.meta.device}`,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (!rows.length) {
      setStatus("別ブラウザのキューはまだありません。");
      return;
    }
    if (!window.confirm("別ブラウザの最新キューへ切り替えますか？")) return;
    setState((current) => ({ ...current, ...JSON.parse(rows[0].value) }));
  }

  const detail = conflicts
    ? `${status}。競合${conflicts}件はクラウドを優先し、ローカル値を退避しました。`
    : status;
  return {
    options,
    updateOptions,
    status: options.enabled ? detail : `自動同期オフ（${detail}）`,
    busy,
    ready,
    sync: () => sync(true),
    backups,
    listBackups,
    restoreBackup,
    inheritQueue,
  };
}
