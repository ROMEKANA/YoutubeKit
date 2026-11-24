export interface DescriptionPart {
  text: string;
  seconds?: number;
  offset: number;
}

// 数字とコロンがつながる範囲をまとめて読み、元の表記は表示用に保持する。
export function descriptionParts(description: string): DescriptionPart[] {
  const parts: DescriptionPart[] = [];
  let previous = 0;
  for (const match of description.matchAll(
    /[0-9０-９]+(?:[:：][0-9０-９]+)+/gu,
  )) {
    const value = match[0].normalize("NFKC");
    const units = value.split(":");
    const right = units.slice(1);
    if (
      units.length > 3 ||
      right.some((unit) => unit.length > 2 || Number(unit) >= 60)
    )
      continue;
    const seconds = units.reduce((total, unit) => total * 60 + Number(unit), 0);
    if (!Number.isSafeInteger(seconds)) continue;
    if (previous < match.index)
      parts.push({
        text: description.slice(previous, match.index),
        offset: previous,
      });
    parts.push({ text: match[0], seconds, offset: match.index });
    previous = match.index + match[0].length;
  }
  if (previous < description.length)
    parts.push({ text: description.slice(previous), offset: previous });
  return parts;
}

// 公式IFrame APIの動画URLから、現在読み込まれているIDだけを照合する。
export function loadedVideoId(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("v");
  } catch {
    return null;
  }
}

export function observedTimestampPosition(
  actual: number,
  before: number,
  target: number,
) {
  if (!Number.isFinite(actual) || actual < 0) return null;
  const seconds = Math.floor(actual);
  if (
    seconds === Math.floor(target) ||
    (target > 0 &&
      Math.abs(actual - target) <= 10 &&
      Math.abs(actual - target) + 0.75 < Math.abs(before - target))
  )
    return seconds;
  return null;
}

export function canSeekToTimestamp(seconds: number, duration: number) {
  return (
    Number.isFinite(seconds) &&
    seconds >= 0 &&
    Number.isFinite(duration) &&
    duration > 0 &&
    seconds <= duration
  );
}
