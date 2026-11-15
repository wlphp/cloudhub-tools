/** 3×3 滑动图案的几何判定：路径命中与直线补点。
 *
 * 判定与显示共用同一坐标系：点 index 的中心位于 ((index % 3) + 0.5) × cell、
 * (Math.floor(index / 3) + 0.5) × cell，与 AppLockPatternGrid 的 CSS 布局一致。
 *
 * 两条规则（对齐 Android 系统图案锁的语义）：
 * 1. 路径命中——手指轨迹按「采样线段」判定而非离散采样点，快速滑动不漏点；
 * 2. 直线补点——相邻登记点连线穿过的未登记点自动补入，同一形状永远得到同一序列，
 *   不受滑动快慢、路径弧度影响。
 */

/** 路径命中阈值（×cell）：点到采样线段的距离 ≤ 0.4 视为手指经过。
 * 直角穿行的中间点距离为 0 必命中；主对角线旁的侧点距离 ≈ 0.707 不误伤。 */
export const HIT_TOLERANCE = 0.4;

/** 直线补点阈值（×cell）：相邻登记点连线距点中心 ≤ 0.2 视为「直线经过」。 */
export const PASS_THROUGH_TOLERANCE = 0.2;

export interface PatternPoint {
  x: number;
  y: number;
}

export function dotCenter(index: number, cell: number): PatternPoint {
  return { x: ((index % 3) + 0.5) * cell, y: (Math.floor(index / 3) + 0.5) * cell };
}

/** 点 P 到线段 AB 的最近距离。 */
export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 采样线段 A→B 新命中的未登记点，按沿线段先后排序。 */
export function collectPathHits(ax: number, ay: number, bx: number, by: number, cell: number, sequence: number[]): number[] {
  const hits: Array<{ index: number; t: number }> = [];
  for (let index = 0; index < 9; index += 1) {
    if (sequence.includes(index)) continue;
    const center = dotCenter(index, cell);
    if (pointSegmentDistance(center.x, center.y, ax, ay, bx, by) > HIT_TOLERANCE * cell) continue;
    const dx = bx - ax;
    const dy = by - ay;
    const t = dx === 0 && dy === 0 ? 0 : ((center.x - ax) * dx + (center.y - ay) * dy) / (dx * dx + dy * dy);
    hits.push({ index, t });
  }
  hits.sort((left, right) => left.t - right.t);
  return hits.map((hit) => hit.index);
}

/** 相邻登记点连线穿过的未登记点自动补入，循环处理直到稳定（3×3 内每条连线最多穿过一个点）。 */
export function withPassThroughDots(sequence: number[], cell: number): number[] {
  const result = [...sequence];
  let changed = true;
  while (changed) {
    changed = false;
    for (let position = 0; position + 1 < result.length; position += 1) {
      const from = dotCenter(result[position], cell);
      const to = dotCenter(result[position + 1], cell);
      const between: number[] = [];
      for (let index = 0; index < 9; index += 1) {
        if (result.includes(index)) continue;
        const center = dotCenter(index, cell);
        if (pointSegmentDistance(center.x, center.y, from.x, from.y, to.x, to.y) <= PASS_THROUGH_TOLERANCE * cell) {
          between.push(index);
        }
      }
      if (between.length === 0) continue;
      result.splice(position + 1, 0, ...between);
      changed = true;
    }
  }
  return result;
}
