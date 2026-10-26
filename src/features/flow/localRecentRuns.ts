import type { FlowPipeline } from "../../shared/types";

type LocalRun = { pipeline: FlowPipeline; triggeredAt: number };
const storageKey = (connectionId: number) => `cloudhub-tools-flow-local-runs:${connectionId}`;

export function readLocalRuns(connectionId: number): LocalRun[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(connectionId)) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is LocalRun => item && typeof item.triggeredAt === "number" && Number.isFinite(item.triggeredAt) && item.triggeredAt > 0
      && item.pipeline && typeof item.pipeline.pipelineId === "string" && typeof item.pipeline.pipelineName === "string")
      .sort((a, b) => b.triggeredAt - a.triggeredAt).slice(0, 100);
  } catch { return []; }
}

export function rememberLocalRun(connectionId: number, pipeline: FlowPipeline) {
  const next = [{ pipeline: { pipelineId: pipeline.pipelineId, pipelineName: pipeline.pipelineName }, triggeredAt: Date.now() },
    ...readLocalRuns(connectionId).filter(item => item.pipeline.pipelineId !== pipeline.pipelineId)].slice(0, 100);
  try { localStorage.setItem(storageKey(connectionId), JSON.stringify(next)); } catch { /* A storage failure must not misreport an accepted cloud run as failed. */ }
}
