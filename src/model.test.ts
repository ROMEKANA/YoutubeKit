import { describe, expect, it } from "vitest";
import {
  addToQueue,
  defaultSettings,
  formatDuration,
  moveItem,
  parseVideos,
  restoreState,
  toggleQueueItem,
  isExcludedByDuration,
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
      settings: { ...defaultSettings, densityPercent: 150 },
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
  it("サムネイルの再タップで対象だけ削除し、残りの再生順が詰まる", () => {
    let queue = toggleQueueItem([], "aqz-KE-bpKQ");
    queue = toggleQueueItem(queue, "eRsGyueVLvQ");
    queue = toggleQueueItem(queue, "R6MlUcmOul8");
    expect(queue.indexOf("R6MlUcmOul8") + 1).toBe(3);
    queue = toggleQueueItem(queue, "eRsGyueVLvQ");
    expect(queue).toEqual(["aqz-KE-bpKQ", "R6MlUcmOul8"]);
    expect(queue.indexOf("R6MlUcmOul8") + 1).toBe(2);
    expect(toggleQueueItem(queue, "eRsGyueVLvQ")).toEqual([
      "aqz-KE-bpKQ",
      "R6MlUcmOul8",
      "eRsGyueVLvQ",
    ]);
  });
  it("旧表示密度を移行してもキューと除外秒数を失わない", () => {
    const state = restoreState(
      JSON.stringify({
        queue: ["aqz-KE-bpKQ"],
        hidden: ["eRsGyueVLvQ"],
        settings: { density: "large", shortThreshold: 90 },
      }),
    );
    expect(state.settings.densityPercent).toBe(130);
    expect(state.settings.shortThreshold / 60).toBe(1.5);
    expect(state.queue).toEqual(["aqz-KE-bpKQ"]);
    expect(state.hidden).toEqual(["eRsGyueVLvQ"]);
  });
  it("10%刻みの10〜200%を保存でき、不正な倍率は標準へ戻す", () => {
    for (let percent = 10; percent <= 200; percent += 10) {
      expect(
        restoreState(JSON.stringify({ settings: { densityPercent: percent } }))
          .settings.densityPercent,
      ).toBe(percent);
    }
    for (const percent of [0, 15, 210, "200", null]) {
      expect(
        restoreState(JSON.stringify({ settings: { densityPercent: percent } }))
          .settings.densityPercent,
      ).toBe(100);
    }
  });
  it("標準の3分以下を除外し、オフなら短い動画も表示する", () => {
    expect(defaultSettings.shortThreshold / 60).toBe(3);
    expect(isExcludedByDuration(180, defaultSettings)).toBe(true);
    expect(isExcludedByDuration(181, defaultSettings)).toBe(false);
    expect(
      isExcludedByDuration(19, { ...defaultSettings, excludeShort: false }),
    ).toBe(false);
  });
});
