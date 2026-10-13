import { AiAssistButton } from "./AiAssistButton";
import { selectedAiContext } from "./context";

export function AiLogAnalysis({ scope, title = "AI 分析选中日志", secrets = [] }: { scope: string; title?: string; secrets?: readonly string[] }) {
  return <div className="ai-log-analysis"><AiAssistButton task="diagnose" title={title} text={() => selectedAiContext(scope, secrets)} /><small>先选中本区域的日志片段（最多32KB），也可在分析面板手动粘贴。发送前需检查内容。</small></div>;
}
