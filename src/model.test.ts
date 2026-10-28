import { describe, expect, it } from "vitest";
import {
  addToQueue,
  defaultSettings,
  formatDuration,
  moveItem,
  parseVideos,
  restoreState,
} from "./model";

describe("キューと保存データ", () => {
  it("連打しても重複追加しない", () => {
    expect(addToQueue(addToQueue([], "aqz-KE-bpKQ"), "aqz-KE-bpKQ")).toEqual([
      "aqz-KE-bpKQ",
    ]);
  });
  it("並べ替えても他の動画を欠落させない", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
  it("キュー・非表示・設定を保存形式から復元する", () => {
    const data = {
      queue: ["aqz-KE-bpKQ"],
      hidden: ["aqz-KE-bpKQ"],
      settings: { ...defaultSettings, density: "large" },
    };
    expect(restoreState(JSON.stringify(data))).toEqual(data);
  });
  it("破損・不正な保存データから復帰する", () => {
    expect(restoreState("{broken").settings).toEqual(defaultSettings);
    expect(restoreState("null").queue).toEqual([]);
    expect(
      restoreState(
        '{"queue":["aqz-KE-bpKQ","aqz-KE-bpKQ",null],"settings":{"initialCount":-3}}',
      ).queue,
    ).toEqual(["aqz-KE-bpKQ"]);
    expect(
      restoreState('{"settings":{"initialCount":-3}}').settings.initialCount,
    ).toBe(30);
  });
  it("合計時間を秒切り捨てせず表示する", () => {
    expect(formatDuration(3661, true)).toBe("1時間2分");
    expect(formatDuration(596)).toBe("9:56");
  });
  it("壊れた一覧データを拒否する", () => {
    expect(() => parseVideos([{ id: "broken" }])).toThrow();
  });
});
