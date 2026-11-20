/** Claude Code 的模型角色。供应商编辑、路由矩阵和拓扑图共用同一定义，避免角色顺序漂移。 */
export const CLAUDE_MODEL_ROLES = [
  { key: "sonnet", label: "Sonnet" },
  { key: "opus", label: "Opus" },
  { key: "haiku", label: "Haiku" },
  { key: "fable", label: "Fable" },
  { key: "subagent", label: "Subagent" },
] as const;

export type ClaudeModelRole = typeof CLAUDE_MODEL_ROLES[number]["key"];
