import type { AiFields } from "../../platform/clients/ai";

const labels = { name: "名称", type: "类型", url: "网址", expires_at: "到期日期", tags: "标签", remark: "备注" };
export function assetNoteCandidate(fields: AiFields): string {
  return Object.entries(labels).flatMap(([key, label]) => {
    const value = fields[key];
    return typeof value === "string" && value.trim() ? [`${label}：${value.trim()}`] : [];
  }).join("\n");
}
