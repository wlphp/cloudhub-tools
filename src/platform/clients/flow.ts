import { nativeOnly } from "./base";
import type { FlowConnection, FlowConnectionInput, FlowGroup, FlowLogPage, FlowPipeline, FlowRun, FlowRunDetail, FlowStep } from "../../shared/types";

export const flowClient = {
  connections(): Promise<FlowConnection[]> { return nativeOnly("list_flow_connections"); },
  saveConnection(input: FlowConnectionInput): Promise<FlowConnection> { return nativeOnly("save_flow_connection", { input }); },
  deleteConnection(id: number): Promise<void> { return nativeOnly("delete_flow_connection", { id }); },
  testConnection(id: number): Promise<void> { return nativeOnly("test_flow_connection", { id }); },
  groups(connectionId: number): Promise<FlowGroup[]> { return nativeOnly("list_flow_groups", { connectionId }); },
  pipelines(connectionId: number, page: number, perPage: number, keyword: string, groupId: string | null): Promise<FlowPipeline[]> { return nativeOnly("list_flow_pipelines", { connectionId, page, perPage, keyword: keyword || null, groupId }); },
  runs(connectionId: number, pipelineId: string, page: number, perPage: number): Promise<FlowRun[]> { return nativeOnly("list_flow_runs", { connectionId, pipelineId, page, perPage }); },
  run(connectionId: number, pipelineId: string, runId: string): Promise<FlowRunDetail> { return nativeOnly("get_flow_run", { connectionId, pipelineId, runId }); },
  latestRun(connectionId: number, pipelineId: string): Promise<FlowRunDetail> { return nativeOnly("get_flow_latest_run", { connectionId, pipelineId }); },
  start(connectionId: number, pipelineId: string, paramsJson: string): Promise<string> { return nativeOnly("run_flow_pipeline", { connectionId, pipelineId, paramsJson: paramsJson || null }); },
  steps(connectionId: number, pipelineId: string, runId: string, jobId: string): Promise<FlowStep[]> { return nativeOnly("get_flow_job_steps", { connectionId, pipelineId, runId, jobId }); },
  log(connectionId: number, pipelineId: string, runId: string, jobId: string, stepIndex: number, buildId: number, offset: number, limit: number): Promise<FlowLogPage> { return nativeOnly("get_flow_job_log", { connectionId, pipelineId, runId, jobId, stepIndex, buildId, offset, limit }); },
};
