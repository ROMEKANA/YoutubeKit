import { describe, expect, it } from "vitest";
import {
  addToQueue,
  appendQueue,
  createSavedQueueId,
  defaultSettings,
  formatDuration,
  getQueueStart,
  moveItem,
  mergeSavedQueue,
  newestSavedQueuesFirst,
  playbackSaveIntervals,
  parseVideos,
  restoreState,
  selectPlaybackPositions,
  toggleQueueItem,
  isExcludedByDuration,
  formatPublishedAt,
  readWarningDismissal,
} from "./model";

describe("キューと保存データ", () => {
  it("シアター明るさ1〜100%を復元し、旧データと範囲外は初期値へ戻す", () => {
    for (const theaterBrightness of [1, 20, 100])
      expect(
        restoreState(JSON.stringify({ settings: { theaterBrightness } }))
          .settings.theaterBrightness,
      ).toBe(theaterBrightness);
    for (const theaterBrightness of [0, 101, 1.5, "10", null])
      expect(
        restoreState(JSON.stringify({ settings: { theaterBrightness } }))
          .settings.theaterBrightness,
      ).toBe(20);
    expect(restoreState('{"queue":["aqz-KE-bpKQ"]}').queue).toEqual([
      "aqz-KE-bpKQ",
    ]);
    expect(
      restoreState('{"queue":["aqz-KE-bpKQ"]}').settings.theaterBrightness,
    ).toBe(20);
  });
  it("投稿日時は日付と時分を表示し、秒は省く", () => {
    expect(formatPublishedAt("2026-10-29T12:34:56")).toBe("2026/10/29 12:34");
    expect(formatPublishedAt("2026-10-29T00:05:59")).toBe("2026/10/29 00:05");
  });
  it("閉じた通知は同じ世代では保存され、過去分再取得の失敗で変わった世代では再表示できる", () => {
    const raw = JSON.stringify({ revision: "full-job-1" });
    expect(readWarningDismissal(raw)).toBe("full-job-1");
    expect(readWarningDismissal(raw)).not.toBe("full-job-2");
    expect(readWarningDismissal(null)).toBeNull();
    expect(readWarningDismissal("broken")).toBeNull();
  });
  it("連打しても重複追加しない", () => {
    expect(addToQueue(addToQueue([], "aqz-KE-bpKQ"), "aqz-KE-bpKQ")).toEqual([
      "aqz-KE-bpKQ",
    ]);
  });
  it("保存キューは現在のキュー末尾へ重複なしで追加する", () => {
    expect(
      appendQueue(
        ["aqz-KE-bpKQ", "eRsGyueVLvQ"],
        ["eRsGyueVLvQ", "R6MlUcmOul8"],
      ),
    ).toEqual(["aqz-KE-bpKQ", "eRsGyueVLvQ", "R6MlUcmOul8"]);
  });
  it("最後に再生した動画が現在のキューにある場合だけ、その位置から開始する", () => {
    const queue = ["aqz-KE-bpKQ", "eRsGyueVLvQ", "R6MlUcmOul8"];
    expect(getQueueStart(queue, "eRsGyueVLvQ", { eRsGyueVLvQ: 123 })).toEqual({
      index: 1,
      positionSeconds: 123,
    });
    expect(getQueueStart(queue, "9bZkp7q19f0", {})).toEqual({
      index: 0,
      positionSeconds: 0,
    });
    expect(getQueueStart(queue, null, { "aqz-KE-bpKQ": 123 })).toEqual({
      index: 0,
      positionSeconds: 0,
    });
  });
  it("保存キューの再開動画がある場合だけ、現在の履歴を上書きする", () => {
    const currentQueue = ["aqz-KE-bpKQ"];
    const base = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "保存キュー",
      videoIds: ["eRsGyueVLvQ"],
      playbackPositions: { eRsGyueVLvQ: 91 },
    };
    expect(
      mergeSavedQueue(
        currentQueue,
        "aqz-KE-bpKQ",
        { "aqz-KE-bpKQ": 45 },
        {
          ...base,
          resumeVideoId: "eRsGyueVLvQ",
        },
      ),
    ).toEqual({
      queue: ["aqz-KE-bpKQ", "eRsGyueVLvQ"],
      resumeVideoId: "eRsGyueVLvQ",
      playbackPositions: { "aqz-KE-bpKQ": 45, eRsGyueVLvQ: 91 },
    });
    expect(
      mergeSavedQueue(
        currentQueue,
        "aqz-KE-bpKQ",
        { "aqz-KE-bpKQ": 45 },
        {
          ...base,
          resumeVideoId: null,
        },
      ),
    ).toEqual({
      queue: ["aqz-KE-bpKQ", "eRsGyueVLvQ"],
      resumeVideoId: "aqz-KE-bpKQ",
      playbackPositions: { "aqz-KE-bpKQ": 45, eRsGyueVLvQ: 91 },
    });
  });
  it("保存キューに位置がない動画は保存時点の先頭位置で上書きする", () => {
    expect(
      mergeSavedQueue(
        ["aqz-KE-bpKQ"],
        "aqz-KE-bpKQ",
        { eRsGyueVLvQ: 91 },
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "保存キュー",
          videoIds: ["eRsGyueVLvQ"],
          resumeVideoId: "eRsGyueVLvQ",
          playbackPositions: {},
        },
      ).playbackPositions,
    ).toEqual({});
  });
  it("保存キュー用にUUIDを生成する", () => {
    expect(createSavedQueueId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
  it("保存キューの保存順を変えず、表示だけを新しい順にする", () => {
    const older = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "古いキュー",
      videoIds: ["aqz-KE-bpKQ"],
      resumeVideoId: null,
      playbackPositions: {},
    };
    const newer = {
      ...older,
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "新しいキュー",
    };
    const savedQueues = [older, newer];
    expect(newestSavedQueuesFirst(savedQueues)).toEqual([newer, older]);
    expect(savedQueues).toEqual([older, newer]);
  });
  it("並べ替えても他の動画を欠落させない", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
  it("キュー・非表示・設定を保存形式から復元する", () => {
    const data = {
      queue: ["aqz-KE-bpKQ"],
      resumeVideoId: "aqz-KE-bpKQ",
      playbackPositions: { "aqz-KE-bpKQ": 83 },
      savedQueues: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "あとで見る",
          videoIds: ["aqz-KE-bpKQ"],
          resumeVideoId: "aqz-KE-bpKQ",
          playbackPositions: { "aqz-KE-bpKQ": 83 },
        },
      ],
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
    expect(
      restoreState('{"playbackPositions":{"aqz-KE-bpKQ":12.9,"broken":20}}')
        .playbackPositions,
    ).toEqual({ "aqz-KE-bpKQ": 12 });
  });
  it("同名の保存キューを別IDで保持し、不正な保存キューは除外する", () => {
    const savedQueues = restoreState(
      JSON.stringify({
        savedQueues: [
          {
            id: "550e8400-e29b-41d4-a716-446655440000",
            name: "同じ名前",
            videoIds: ["aqz-KE-bpKQ"],
            resumeVideoId: "aqz-KE-bpKQ",
            playbackPositions: { "aqz-KE-bpKQ": 12 },
          },
          {
            id: "550e8400-e29b-41d4-a716-446655440001",
            name: "同じ名前",
            videoIds: ["eRsGyueVLvQ"],
          },
          { id: "broken", name: "不正", videoIds: ["R6MlUcmOul8"] },
        ],
      }),
    ).savedQueues;
    expect(savedQueues).toHaveLength(2);
    expect(savedQueues.map((queue) => queue.name)).toEqual([
      "同じ名前",
      "同じ名前",
    ]);
    expect(savedQueues.map((queue) => queue.resumeVideoId)).toEqual([
      "aqz-KE-bpKQ",
      null,
    ]);
    expect(savedQueues.map((queue) => queue.playbackPositions)).toEqual([
      { "aqz-KE-bpKQ": 12 },
      {},
    ]);
  });
  it("保存キューには対象動画の途中位置だけを取り込む", () => {
    expect(
      selectPlaybackPositions(
        { "aqz-KE-bpKQ": 12, eRsGyueVLvQ: 0, R6MlUcmOul8: 33 },
        ["aqz-KE-bpKQ", "eRsGyueVLvQ"],
      ),
    ).toEqual({ "aqz-KE-bpKQ": 12 });
  });
  it("再生位置の保存間隔は指定候補だけを復元する", () => {
    for (const seconds of playbackSaveIntervals)
      expect(
        restoreState(
          JSON.stringify({
            settings: { playbackSaveIntervalSeconds: seconds },
          }),
        ).settings.playbackSaveIntervalSeconds,
      ).toBe(seconds);
    expect(
      restoreState(
        JSON.stringify({ settings: { playbackSaveIntervalSeconds: 4 } }),
      ).settings.playbackSaveIntervalSeconds,
    ).toBe(5);
  });
  it("途中から再生する設定はオンとオフを保存する", () => {
    expect(
      restoreState(
        JSON.stringify({ settings: { resumePlaybackPosition: false } }),
      ).settings.resumePlaybackPosition,
    ).toBe(false);
    expect(restoreState("{}").settings.resumePlaybackPosition).toBe(true);
  });
  it("合計時間を秒切り捨てせず表示する", () => {
    expect(formatDuration(3661, true)).toBe("1時間2分");
    expect(formatDuration(596)).toBe("9:56");
  });
  it("壊れた一覧データを拒否する", () => {
    expect(() => parseVideos([{ id: "broken" }])).toThrow();
  });
  it("実APIの画像URLを引き継ぎ、重複IDと不正な画像URLを除外する", () => {
    const video = {
      id: "aqz-KE-bpKQ",
      title: "動画",
      channelId: "channel",
      channel: "チャンネル",
      publishedAt: "2026-10-29T00:00:00Z",
      durationSeconds: 200,
      thumbnailUrl: "https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg",
      channelThumbnailUrl: "javascript:invalid",
    };
    const result = parseVideos([video, video]);
    expect(result).toHaveLength(1);
    expect(result[0].thumbnailUrl).toBe(video.thumbnailUrl);
    expect(result[0].channelThumbnailUrl).toBeUndefined();
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
