import { describe, expect, it } from "vitest";
import {
  canSeekToTimestamp,
  descriptionParts,
  loadedVideoId,
  observedTimestampPosition,
} from "./timestamps";

describe("概要欄のタイムスタンプ", () => {
  it("全角・1桁の秒・長い分・時と複数の隣接表記を認識し、本文を保持する", () => {
    const text =
      "00:00オープニング\n\nイントロ5:17〜8:30 【５：１７】 (1:02:30) 125:30🎵0:9";
    const parts = descriptionParts(text);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(parts.flatMap(({ seconds }) => seconds ?? [])).toEqual([
      0, 317, 510, 317, 3750, 7530, 9,
    ]);
  });

  it("公式プレーヤーのURLを照合し、シーク前の位置を捨てて実測の0秒を受け入れる", () => {
    expect(
      loadedVideoId(
        "https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=playlist",
      ),
    ).toBe("aqz-KE-bpKQ");
    expect(loadedVideoId("")).toBeNull();
    expect(observedTimestampPosition(24.5, 24.5, 0)).toBeNull();
    expect(observedTimestampPosition(0.4, 24.5, 0)).toBe(0);
    expect(observedTimestampPosition(94.1, 25, 100)).toBe(94);
    expect(observedTimestampPosition(22, 21, 100)).toBeNull();
  });

  it("不正な時刻の一部を切り出さず、動画長を超えるシークを拒否する", () => {
    expect(
      descriptionParts("0:65 1:65:10 1:2:3:4 999999999999999999999:59").some(
        (part) => part.seconds !== undefined,
      ),
    ).toBe(false);
    expect(canSeekToTimestamp(61, 60)).toBe(false);
    expect(canSeekToTimestamp(0, 0)).toBe(false);
    expect(canSeekToTimestamp(-1, 60)).toBe(false);
    expect(canSeekToTimestamp(0, 60)).toBe(true);
    expect(canSeekToTimestamp(60, 60)).toBe(true);
  });
});
