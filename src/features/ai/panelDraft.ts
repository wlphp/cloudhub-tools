import type { AiFields } from "../../platform/clients/ai";

export function panelAiFields(fields: AiFields): Partial<Record<"name" | "panel_url" | "remark", string>> {
  const result: Partial<Record<"name" | "panel_url" | "remark", string>> = {};
  for (const key of ["name", "panel_url", "remark"] as const) {
    const value = fields[key];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (key === "panel_url" && text) {
      let url: URL;
      try { url = new URL(text); } catch { throw new Error("识别的面板地址无效，请核对后再应用"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("面板地址只能包含HTTP或HTTPS地址，不能包含凭据、查询参数或片段");
      }
    }
    result[key] = text;
  }
  return result;
}
