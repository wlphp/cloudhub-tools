import { invokeOrWeb, jsonRequest, nativeOnly, queryPath } from "./base";
import type { FlowConnection, FlowConnectionInput, FlowGroup, FlowLogPage, FlowPipeline, FlowPipelineCache, FlowRun, FlowRunDetail, FlowStep } from "../../shared/types";

export const flowClient = {
  revealToken(id: number): Promise<string> { return nativeOnly("reveal_flow_token", { id }); },
  connections(): Promise<FlowConnection[]> { return invokeOrWeb("list_flow_connections", undefined, { path: "/api/flow-connections" }); },
  saveConnection(input: FlowConnectionInput): Promise<FlowConnection> { return invokeOrWeb("save_flow_connection", { input }, { path: "/api/flow-connections", init: jsonRequest("POST", input) }); },
  deleteConnection(id: number): Promise<void> { return invokeOrWeb("delete_flow_connection", { id }, { path: queryPath("/api/flow-connections", { id }), init: { method: "DELETE" } }); },
  testConnection(id: number): Promise<void> { return invokeOrWeb("test_flow_connection", { id }, { path: "/api/flow-test", init: jsonRequest("POST", { id }) }); },
  groups(connectionId: number): Promise<FlowGroup[]> { return invokeOrWeb("list_flow_groups", { connectionId }, { path: queryPath("/api/flow-groups", { connectionId }) }); },
  pipelines(connectionId: number, page: number, perPage: number, keyword: string, groupId: string | null): Promise<FlowPipeline[]> { return invokeOrWeb("list_flow_pipelines", { connectionId, page, perPage, keyword: keyword || null, groupId }, { path: queryPath("/api/flow-pipelines", { connectionId, page, perPage, keyword: keyword || null, groupId }) }); },
  cachedPipelines(connectionId: number, page: number, perPage: number, keyword: string, groupId: string | null): Promise<FlowPipelineCache> { return invokeOrWeb("get_flow_pipeline_cache", { connectionId, page, perPage, keyword: keyword || null, groupId }, { path: queryPath("/api/flow-pipeline-cache", { connectionId, page, perPage, keyword: keyword || null, groupId }) }); },
  runs(connectionId: number, pipelineId: string, page: number, perPage: number): Promise<FlowRun[]> { return invokeOrWeb("list_flow_runs", { connectionId, pipelineId, page, perPage }, { path: queryPath("/api/flow-runs", { connectionId, pipelineId, page, perPage }) }); },
  run(connectionId: number, pipelineId: string, runId: string): Promise<FlowRunDetail> { return invokeOrWeb("get_flow_run", { connectionId, pipelineId, runId }, { path: queryPath("/api/flow-run", { connectionId, pipelineId, runId }) }); },
  latestRun(connectionId: number, pipelineId: string): Promise<FlowRunDetail> { return invokeOrWeb("get_flow_latest_run", { connectionId, pipelineId }, { path: queryPath("/api/flow-latest-run", { connectionId, pipelineId }) }); },
  start(connectionId: number, pipelineId: string, paramsJson: string): Promise<string> { return invokeOrWeb("run_flow_pipeline", { connectionId, pipelineId, paramsJson: paramsJson || null }, { path: "/api/flow-run", init: jsonRequest("POST", { connectionId, pipelineId, paramsJson: paramsJson || null }) }); },
  steps(connectionId: number, pipelineId: string, runId: string, jobId: string): Promise<FlowStep[]> { return invokeOrWeb("get_flow_job_steps", { connectionId, pipelineId, runId, jobId }, { path: queryPath("/api/flow-steps", { connectionId, pipelineId, runId, jobId }) }); },
  log(connectionId: number, pipelineId: string, runId: string, jobId: string, stepIndex: number, buildId: number, offset: number, limit: number): Promise<FlowLogPage> { return invokeOrWeb("get_flow_job_log", { connectionId, pipelineId, runId, jobId, stepIndex, buildId, offset, limit }, { path: queryPath("/api/flow-log", { connectionId, pipelineId, runId, jobId, stepIndex, buildId, offset, limit }) }); },
  jobLog(connectionId: number, pipelineId: string, runId: string, jobId: string): Promise<FlowLogPage> { return invokeOrWeb("get_flow_job_run_log", { connectionId, pipelineId, runId, jobId }, { path: queryPath("/api/flow-job-log", { connectionId, pipelineId, runId, jobId }) }); },
};
