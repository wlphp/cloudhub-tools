import type { AiFields } from "../../platform/clients/ai";
import { parseDnsPaste, type ParsedDnsRecord } from "./parseDnsPaste";

/** Validate every user-selected AI DNS candidate locally before placing it in the editor. */
export function parseAiDnsCandidates(items: AiFields[], domain: string): ParsedDnsRecord[] {
  const records = items.map((item, index) => {
    try {
      const record = parseDnsPaste(JSON.stringify(item), domain)[0];
      if (!record) throw new Error("缺少可识别的记录类型或记录值");
      return record;
    } catch (error) {
      throw new Error(`第 ${index + 1} 条 AI DNS 候选无效：${error instanceof Error ? error.message : "请检查记录字段"}`);
    }
  });
  if (!records.length) throw new Error("没有可填入的有效 DNS 记录。");

  const seen = new Map<string, number>();
  records.forEach((record, index) => {
    const key = [record.type, record.rr ?? "", record.value.trim(), record.priority ?? "", record.line ?? "default"].join("\u0000");
    const previous = seen.get(key);
    if (previous !== undefined) throw new Error(`第 ${index + 1} 条与第 ${previous + 1} 条候选重复，请先在候选列表中取消其中一条。`);
    seen.set(key, index);
  });
  return records;
}
