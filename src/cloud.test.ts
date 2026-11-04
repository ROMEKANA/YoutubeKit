import { describe, expect, it } from "vitest";
import { applyCloud, cloudValues, validCloudValue } from "../shared/cloud";
import { restoreState } from "./model";

describe("クラウド状態の統合", () => {
  it("同じIDを重複させず、別IDを追加し、削除済みだけを除く", () => {
    const queue = {
      id: "12345678-1234-4123-8123-123456789abc",
      name: "A",
      videoIds: ["aqz-KE-bpKQ"],
      resumeVideoId: null,
      playbackPositions: {},
    };
    const other = {
      ...queue,
      id: "22345678-1234-4123-8123-123456789abc",
      name: "B",
    };
    const state = restoreState(
      JSON.stringify({
        queue: queue.videoIds,
        savedQueues: [queue],
        playbackPositions: { "aqz-KE-bpKQ": 10 },
      }),
    );
    const row = (key: string, value: unknown) => ({
      key,
      value: JSON.stringify(value),
      revision: 1,
      updatedAt: 1,
    });
    const merged = applyCloud(
      state,
      [
        row(`queue/${queue.id}`, queue),
        row(`queue/${other.id}`, other),
        row("position/aqz-KE-bpKQ", 90),
      ],
      true,
    );
    expect(merged.savedQueues).toHaveLength(2);
    expect(merged.queue).toEqual(state.queue);
    expect(merged.playbackPositions["aqz-KE-bpKQ"]).toBe(10);
    expect(
      applyCloud(merged, [row(`queue/${queue.id}`, null)], false).savedQueues,
    ).toEqual([other]);
  });
  it("端末用の表示設定を送らず、非表示解除と再生位置ゼロを受け入れる", () => {
    const state = restoreState(null);
    const values = cloudValues(state, "12345678-1234-4123-8123-123456789abc");
    expect(values["setting/densityPercent"]).toBeUndefined();
    expect(values["setting/theaterBrightness"]).toBeUndefined();
    expect(validCloudValue("position/aqz-KE-bpKQ", "0")).toBe(true);
    expect(validCloudValue("hidden/aqz-KE-bpKQ", "false")).toBe(true);
    expect(validCloudValue("position/aqz-KE-bpKQ", "-1")).toBe(false);
    expect(validCloudValue("setting/resumePlaybackPosition", '"true"')).toBe(
      false,
    );
  });
});
