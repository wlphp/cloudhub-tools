import { preferencesClient } from "../platform/clients/preferences";

/** 读取本机存储的列表自定义顺序；损坏数据按空顺序处理。 */
export function readStoredOrder(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(item => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 保存自定义顺序：本机始终写入 localStorage，原生环境再同步到加密偏好库（失败仅提示不阻断）。 */
export function persistStoredOrder(key: string, order: string[], runningInTauri: boolean): void {
  const value = JSON.stringify(order);
  try { localStorage.setItem(key, value); } catch { /* 存储不可用时仅本次会话生效 */ }
  if (runningInTauri) void preferencesClient.save(key, value).catch(() => {});
}

/** 按已保存顺序重排；未出现在顺序中的行按原相对次序排在末尾。 */
export function applyStoredOrder<T>(rows: T[], order: string[], keyOf: (row: T) => string): T[] {
  if (!order.length) return rows;
  const positions = new Map(order.map((key, index) => [key, index]));
  return [...rows].sort((left, right) => {
    const leftAt = positions.get(keyOf(left));
    const rightAt = positions.get(keyOf(right));
    if (leftAt === undefined && rightAt === undefined) return 0;
    if (leftAt === undefined) return 1;
    if (rightAt === undefined) return -1;
    return leftAt - rightAt;
  });
}

/**
 * 拖拽/键盘移动后的完整顺序：先并入全量键位，再把当前可见子序列按桌面端
 * moveAccountBefore 的语义（移除源后插入到目标当前位置之前）重排。
 * 返回 null 表示 source/target 不在可见序列中或位置无效。
 */
export function moveStoredKeys(visibleKeys: string[], source: string, target: string, completeKeys: string[], currentOrder: string[]): string[] | null {
  const sourceIndex = visibleKeys.indexOf(source);
  const targetIndex = visibleKeys.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return null;
  const reordered = [...visibleKeys];
  reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, source);
  const visibleSet = new Set(reordered);
  const complete = [...new Set([...currentOrder, ...completeKeys])];
  let next = 0;
  return complete.map(key => visibleSet.has(key) ? reordered[next++] : key);
}
