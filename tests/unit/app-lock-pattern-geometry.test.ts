import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectPathHits,
  dotCenter,
  pointSegmentDistance,
  withPassThroughDots,
} from "../../src/mobile/app-lock-pattern-geometry.ts";

// 252px 网格（cell=84）下的点中心：0..8 从左上到右下。
const CELL = 84;
const C = (index: number) => dotCenter(index, CELL);

describe("pointSegmentDistance", () => {
  it("点在线段上距离为 0", () => {
    assert.equal(pointSegmentDistance(C(4).x, C(4).y, C(0).x, C(0).y, C(8).x, C(8).y), 0);
  });

  it("点在线段延长线外取到端点距离", () => {
    const d = pointSegmentDistance(C(6).x, C(6).y, C(0).x, C(0).y, C(2).x, C(2).y);
    assert.ok(Math.abs(d - Math.hypot(0, 168)) < 1e-9);
  });

  it("零长度线段退化为两点距离", () => {
    assert.equal(pointSegmentDistance(0, 0, 3, 4, 3, 4), 5);
  });
});

describe("collectPathHits", () => {
  it("快速斜跨 0→8 命中两端与正穿的 4，不误伤主对角线旁的侧点", () => {
    assert.deepEqual(collectPathHits(C(0).x, C(0).y, C(8).x, C(8).y, CELL, []), [0, 4, 8]);
  });

  it("水平快划 0→2 命中两端与正穿的 1", () => {
    assert.deepEqual(collectPathHits(C(0).x, C(0).y, C(2).x, C(2).y, CELL, []), [0, 1, 2]);
  });

  it("已登记的点不再重复命中", () => {
    assert.deepEqual(collectPathHits(C(0).x, C(0).y, C(2).x, C(2).y, CELL, [0, 1, 2]), []);
  });

  it("一条长采样线段跨多点时按路径先后排序", () => {
    // 从网格外左上角划到右下角：正穿 0、4、8，旁点距离 ≈ 59.4 不命中。
    assert.deepEqual(collectPathHits(0, 0, 252, 252, CELL, []), [0, 4, 8]);
  });

  it("零长度线段（手指停留）命中附近的点", () => {
    assert.deepEqual(collectPathHits(C(4).x, C(4).y, C(4).x, C(4).y, CELL, []), [4]);
  });
});

describe("withPassThroughDots", () => {
  const cases: Array<[number[], number[]]> = [
    [[0, 8], [0, 4, 8]],
    [[0, 6], [0, 3, 6]],
    [[2, 6], [2, 4, 6]],
    [[1, 7], [1, 4, 7]],
    [[8, 0], [8, 4, 0]],
    [[0, 2], [0, 1, 2]],
    [[0, 4, 8], [0, 4, 8]],
    [[4, 0], [4, 0]],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(withPassThroughDots(input, CELL), expected);
    });
  }
});

describe("完整滑动语义：慢画与快划得到同一序列", () => {
  /** 沿一系列采样线段登记，复现组件的判定流程。 */
  const draw = (samples: Array<[number, number]>, sequence: number[] = []): number[] => {
    let current = sequence;
    for (let index = 1; index < samples.length; index += 1) {
      const [ax, ay] = samples[index - 1];
      const [bx, by] = samples[index];
      const hits = collectPathHits(ax, ay, bx, by, CELL, current);
      if (hits.length > 0) current = withPassThroughDots([...current, ...hits], CELL);
    }
    return current;
  };

  it("对角线：设置时慢画三段，解锁时快划一笔，都是 0-4-8", () => {
    const slow = draw([[C(0).x, C(0).y], [C(4).x, C(4).y], [C(8).x, C(8).y]]);
    const fast = draw([[C(0).x, C(0).y], [C(8).x, C(8).y]]);
    assert.deepEqual(slow, [0, 4, 8]);
    assert.deepEqual(fast, [0, 4, 8]);
  });

  it("Z 形一笔快速滑动补齐全部路径点", () => {
    const drawn = draw([[C(0).x, C(0).y], [C(2).x, C(2).y], [C(6).x, C(6).y], [C(8).x, C(8).y]]);
    assert.deepEqual(drawn, [0, 1, 2, 4, 6, 7, 8]);
  });

  it("稀疏采样（模拟快速滑动丢帧）不漏中间点", () => {
    // 0→8 之间只有一个采样点落在偏弧位置，线段判定仍覆盖 4。
    const drawn = draw([[C(0).x, C(0).y], [(C(0).x + C(8).x) / 2 + 20, (C(0).y + C(8).y) / 2], [C(8).x, C(8).y]]);
    assert.deepEqual(drawn, [0, 4, 8]);
  });
});
