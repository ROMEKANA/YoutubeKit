export interface SyncIssue {
  channelId: string;
  title: string;
  code: string;
  message: string;
}

// 古いジョブには警告がないため空配列として扱い、既存の同期を再開できるようにする。
export function parseSyncIssues(value: unknown): SyncIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const issue = item as Record<string, unknown>;
    if (
      typeof issue.channelId !== "string" ||
      typeof issue.title !== "string" ||
      typeof issue.code !== "string" ||
      typeof issue.message !== "string"
    )
      return [];
    return [
      {
        channelId: issue.channelId,
        title: issue.title,
        code: issue.code,
        message: issue.message,
      },
    ];
  });
}
