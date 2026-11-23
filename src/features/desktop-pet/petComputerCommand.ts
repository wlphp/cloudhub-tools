import type { PetComputerAction } from "../../platform/clients/desktopPet";

export type PetComputerCommand = { action: PetComputerAction } | { brightness: number | null } | { folders: number | null };

/** Detect an explicit request to create an HTML file on the desktop. */
export function requestsDesktopHtml(text: string): boolean {
  const normalized = text.normalize("NFKC").toLowerCase();
  return /(?:桌面|desktop)/.test(normalized)
    && /(?:新建|创建|写|保存|生成|create|write|save|make)/.test(normalized)
    && /(?:html|网页|网页文件|\.html?\b)/.test(normalized);
}

/** Detect a direct request to create an Excel workbook on the desktop. */
export function requestsDesktopWorkbook(text: string): boolean {
  const normalized = text.normalize("NFKC").toLowerCase();
  return /(?:桌面|desktop)/.test(normalized)
    && /(?:新建|创建|生成|做一个|create|make)/.test(normalized)
    && /(?:excel|\.xlsx?\b|工作簿|电子表格)/.test(normalized);
}

export function extractHtmlDocument(reply: string): string | null {
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(reply)?.[1]?.trim();
  const candidate = fenced ?? (/<\s*!doctype\s+html|<\s*html\b/i.test(reply) ? reply.trim() : null);
  return candidate && /<\s*(?:!doctype\s+html|html\b)/i.test(candidate) ? candidate : null;
}

const actions: Readonly<Record<string, PetComputerAction>> = {
  关机: "shutdown", 关闭电脑: "shutdown", 关闭计算机: "shutdown",
  重启: "restart", 重启电脑: "restart", 重新启动电脑: "restart",
  锁屏: "lock", 锁定电脑: "lock", 打开任务管理器: "taskManager",
  打开文件资源管理器: "explorer", 打开资源管理器: "explorer",
  "shutdown /s /t 0": "shutdown", "shutdown /r /t 0": "restart",
  "taskmgr": "taskManager", "explorer": "explorer",
};

function spokenPercent(value: string): number {
  if (value === "一百") return 100;
  const digits = "零一二三四五六七八九";
  if (!value.includes("十")) return digits.indexOf(value);
  const [tens, ones] = value.split("十");
  return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
}

export function petComputerCommand(text: string): PetComputerCommand | null {
  const command = text.normalize("NFKC").trim()
    .replace(/^小小驼[，,\s]*/, "").replace(/^请\s*/, "").replace(/^(?:你\s*)?帮我\s*/, "")
    .replace(/[。！!\s]+$/, "").replace(/吧$/, "").replace(/^[把将]\s*/, "");
  const folders = /^(?:在桌面(?:上)?\s*(?:创建|新建|建)|(?:创建|新建|建)\s*桌面(?:上)?的?)\s*(?:(\d+|[一二两三四五六七八九]|[一二三四五六七八九]?十[一二三四五六七八九]?)\s*个)?\s*(?:空\s*)?文件夹$/.exec(command);
  if (folders) {
    const amount = folders[1] ?? "1";
    const count = /^\d+$/.test(amount) ? Number(amount) : spokenPercent(amount.replace("两", "二"));
    return { folders: count >= 1 && count <= 20 ? count : null };
  }
  const key = command.replace(/^执行命令\s*:\s*/, "").toLowerCase().replace(/\.exe(?=\s|$)/, "");
  const action = Object.prototype.hasOwnProperty.call(actions, key) ? actions[key] : undefined;
  if (action) return { action };
  const match = /^(?:(?:屏幕|显示器)?亮度\s*(?:调节?|调整|设为|设置为|设置|调到)?|(?:调节?|调整|设置)\s*(?:屏幕|显示器)?亮度)\s*(?:到|至|为)?\s*(最低|最暗|最高|最亮|(?:百分之\s*)?(?:\d+\s*%?|[零一二三四五六七八九]?十[一二三四五六七八九]?|[零一二三四五六七八九]|一百))$/.exec(command);
  if (!match) return null;
  const value = match[1];
  if (value === "最低" || value === "最暗") return { brightness: 0 };
  if (value === "最高" || value === "最亮") return { brightness: 100 };
  const normalized = value.replace(/百分之|%|\s/g, "");
  const brightness = /^\d+$/.test(normalized) ? Number(normalized) : spokenPercent(normalized);
  return { brightness: brightness <= 100 ? brightness : null };
}
