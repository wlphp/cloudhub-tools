import { readBody, send, sendError } from "../core/http.mjs";
import { createFlowRepository } from "../repositories/flow.mjs";
import { createFlowService, FlowError, flowInteger, flowPipelineQuery, validateFlowConnection } from "../providers/flow.mjs";

const repository = createFlowRepository();
const service = createFlowService(repository);
const readRoutes = [
  { method: "GET", path: "/api/flow-groups", operation: "groups" },
  { method: "GET", path: "/api/flow-pipelines", operation: "pipelines" },
  { method: "GET", path: "/api/flow-runs", operation: "runs" },
  { method: "GET", path: "/api/flow-run", operation: "run" },
  { method: "GET", path: "/api/flow-latest-run", operation: "latest" },
  { method: "GET", path: "/api/flow-steps", operation: "steps" },
  { method: "GET", path: "/api/flow-log", operation: "log" },
  { method: "GET", path: "/api/flow-job-log", operation: "jobLog" },
  { method: "GET", path: "/api/flow-pipeline-cache", operation: "cachedPipelines" },
];
async function input(req) {
  const value = JSON.parse(await readBody(req));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FlowError("请求必须是 JSON 对象");
  return value;
}
export async function handleFlowRoutes(req, res, url, repo = repository, provider = service) {
  const reads = Object.fromEntries(readRoutes.map((route) => [route.path, route.operation]));
  if (url.pathname !== "/api/flow-connections" && url.pathname !== "/api/flow-test" && !Object.hasOwn(reads, url.pathname)) return false;
  try {
    if (req.method === "GET" && url.pathname === "/api/flow-connections") send(res, 200, repo.list());
    else if (req.method === "POST" && url.pathname === "/api/flow-connections") {
      const saved = repo.save(validateFlowConnection(await input(req)));
      if (!saved) throw new FlowError("云效连接不存在或未保存 PAT", 404, "not-found");
      send(res, 200, saved);
    } else if (req.method === "DELETE" && url.pathname === "/api/flow-connections") {
      if (!repo.remove(flowInteger(url.searchParams.get("id"), "云效连接 ID"))) throw new FlowError("云效连接不存在", 404, "not-found");
      send(res, 200, null);
    } else if (req.method === "POST" && url.pathname === "/api/flow-test") send(res, 200, await provider.test((await input(req)).id));
    else if (req.method === "POST" && url.pathname === "/api/flow-run") send(res, 200, await provider.start(await input(req)));
    else if (req.method === "GET" && url.pathname === "/api/flow-pipeline-cache") {
      const query = flowPipelineQuery(Object.fromEntries(url.searchParams));
      if (!repo.get(query.connectionId)) throw new FlowError("云效连接不存在", 404, "not-found");
      send(res, 200, repo.pipelineCache(query.connectionId, query.key));
    } else if (req.method === "GET" && Object.hasOwn(reads, url.pathname)) send(res, 200, await provider[reads[url.pathname]](Object.fromEntries(url.searchParams)));
    else sendError(res, 405, "validation", "此云效接口不支持该请求方法");
  } catch (error) {
    if (error instanceof FlowError) sendError(res, error.status, error.code, error.message);
    else if (error instanceof SyntaxError) sendError(res, 400, "validation", "请求必须是有效 JSON");
    else sendError(res, error?.statusCode === 413 ? 413 : 500, "unknown", "云效操作失败，请检查配置后重试");
  }
  return true;
}
