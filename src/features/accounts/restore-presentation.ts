import type { DatabaseRestorePlan } from "../../platform/clients/database";

export type RestoreCounts = Pick<DatabaseRestorePlan["impacts"][number], "added" | "updated" | "skipped" | "deleted">;

export function restoreCountsText(counts: RestoreCounts): string {
  return ([['added', '新增'], ['updated', '更新'], ['skipped', '跳过'], ['deleted', '删除']] as const)
    .filter(([key]) => counts[key] > 0)
    .map(([key, label]) => `${label} ${counts[key]} 条`).join(" · ") || "无数据变化";
}

/** 原生命令的首段是实际执行结果，后续模块明细来自恢复预览，不能当作实际结果汇总。 */
export function restoreResultPresentation(message: string) {
  const [headline, ...parts] = message.split(/[；;]/);
  const compact = (text: string) => text
    .replace(/(?:新增|更新|跳过|删除)\s*0\s*条?\s*[、·，,]?\s*/g, "")
    .replace(/[、·，,]\s*$/, "").trim();
  const summary = compact(headline).replace(/[：:]\s*$/, "：无数据变化");
  const details = parts.filter(part => /(?:新增|更新|跳过|删除)\s*[1-9]\d*/.test(part)).map(compact);
  return { summary, details };
}
