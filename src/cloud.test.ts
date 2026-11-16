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
      id: "22345678-1234-4123-8123-123456789abc",
      name: "B",
      videoIds: ["eRsGyueVLvQ"],
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
    expect(merged.savedQueues).toEqual([queue, other]);
    expect(merged.queue).toEqual(state.queue);
    expect(merged.playbackPositions["aqz-KE-bpKQ"]).toBe(10);
    expect(
      applyCloud(merged, [row(`queue/${queue.id}`, null)], false).savedQueues,
    ).toEqual([other]);
  });
  it("再生位置を記録時刻付きで同期し、古い受信や旧形式では上書きしない", () => {
    const id = "aqz-KE-bpKQ";
    const key = `position/${id}`;
    const device = "12345678-1234-4123-8123-123456789abc";
    const state = restoreState(JSON.stringify({
      playbackPositions: { [id]: 91 },
      playbackPositionRecordedAt: { [id]: 2000 },
    }));
    expect(JSON.parse(cloudValues(state, device)[key])).toEqual({ seconds: 91, recordedAt: 2000 });
    const row = (value: unknown) => ({ key, value: JSON.stringify(value), revision: 1, updatedAt: 9000 });
    expect(applyCloud(state, [row({ seconds: 300, recordedAt: 1000 }), row(400)], false).playbackPositions[id]).toBe(91);
    const next = applyCloud(state, [row({ seconds: 0, recordedAt: 3000 })], false);
    expect(next.playbackPositions[id]).toBe(0);
    expect(restoreState(JSON.stringify(next)).playbackPositionRecordedAt[id]).toBe(3000);
    expect(restoreState(JSON.stringify(next)).playbackPositions[id]).toBe(0);
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
