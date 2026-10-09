export class FlowError extends Error {
  constructor(message, status = 400, code = "validation") { super(message); this.status = status; this.code = code; }
}
const fail = (message, status, code) => { throw new FlowError(message, status, code); };
const scalar = (value, key) => typeof value?.[key] === "string" || typeof value?.[key] === "number" ? String(value[key]) : null;
const integer = (value, key) => value?.[key] != null && value[key] !== "" && Number.isSafeInteger(Number(value[key])) ? Number(value[key]) : null;
const payload = (value) => value?.data ?? value?.result ?? value;
const array = (value, label) => {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  for (const key of ["items", "result", "data", "pipelines", "runs", "groups"]) if (Array.isArray(value[key])) return value[key];
  return fail(`云效${label}返回结构无效`, 502, "network");
};
export function flowId(value, label = "标识") {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) fail(`${label}格式无效`);
  return value;
}
export function flowInteger(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const result = Number(value);
  if (!["number", "string"].includes(typeof value) || (typeof value === "string" && !/^\d+$/.test(value)) || !Number.isSafeInteger(result) || result < min || result > max) fail(`${label}无效`);
  return result;
}
export function flowDomain(value) {
  if (typeof value !== "string" || value.length > 256) fail("云效接入点格式无效");
  let url;
  try { url = new URL(value.includes("://") ? value.trim() : `https://${value.trim()}`); } catch { fail("云效接入点格式无效"); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !/\.(aliyun\.com|aliyuncs\.com)$/.test(url.hostname)) fail("云效接入点必须使用阿里云官方 HTTPS 域名");
  return url.origin;
}
export function validateFlowConnection(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("云效连接格式无效");
  if (typeof input.name !== "string" || !input.name.trim() || Buffer.byteLength(input.name.trim()) > 100) fail("连接名称不能为空且不能超过 100 字节");
  if (!["central", "region"].includes(input.edition)) fail("请选择有效的云效组织类型");
  const organizationId = typeof input.organizationId === "string" ? input.organizationId.trim() : "";
  if (input.edition === "central" && !/^[a-zA-Z0-9_-]{1,128}$/.test(organizationId)) fail("中心版组织 ID 格式无效");
  if (input.edition === "region" && organizationId) fail("Region 版无需填写组织 ID");
  if (input.token != null && typeof input.token !== "string") fail("云效 PAT 格式无效");
  const token = input.token?.trim() || "";
  if (token && !/^[\x21-\x7e]{1,4096}$/.test(token)) fail("云效 PAT 格式无效");
  const id = input.id == null ? undefined : flowInteger(input.id, "云效连接 ID");
  if (!id && !token) fail("首次创建云效连接必须填写 PAT");
  return { id, name: input.name.trim(), edition: input.edition, organizationId: organizationId || null,
    domain: flowDomain(input.domain || (input.edition === "central" ? "openapi-rdc.aliyuncs.com" : "")), token };
}
export function flowPipelineQuery(args) {
  const connectionId = flowInteger(args.connectionId, "云效连接 ID");
  const page = flowInteger(args.page ?? 1, "页码");
  const perPage = flowInteger(args.perPage ?? 30, "每页条数", 1, 30);
  if (args.keyword != null && typeof args.keyword !== "string") fail("搜索内容格式无效");
  const keyword = args.keyword?.trim() || "";
  if (Buffer.byteLength(keyword) > 128) fail("搜索内容不能超过 128 字节");
  const groupId = args.groupId || "";
  if (groupId && (typeof groupId !== "string" || !/^\d{1,20}$/.test(groupId))) fail("流水线分组 ID 格式无效");
  return { connectionId, key: JSON.stringify([page, perPage, keyword, groupId]) };
}
function sanitize(value, token) {
  if (typeof value === "string") return value.split(token).join("[已隐藏]")
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[已隐藏私钥]")
    .replace(/((?:password|secret|token|authorization|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[已隐藏]");
  if (Array.isArray(value)) return value.map((item) => sanitize(item, token));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child, token)]));
  return value;
}
function statusError(status) {
  if (status === 401) fail("云效 PAT 无效或已过期", 401, "authentication");
  if (status === 403) fail("云效账号无权访问此组织或流水线", 403, "permission");
  if (status === 404) fail("云效流水线或运行记录不存在", 404, "not-found");
  if (status === 429) fail("云效请求过于频繁，请稍后重试", 429, "network");
  fail("云效服务暂时不可用，请稍后重试", 502, "network");
}
export function createFlowService(repository, fetchImpl = globalThis.fetch) {
  async function withConnection(id, action) {
    const saved = repository.load(flowInteger(id, "云效连接 ID"));
    if (!saved) fail("云效连接不存在", 404, "not-found");
    const { info, token } = saved;
    const origin = flowDomain(info.domain);
    if (!token || !/^[\x21-\x7e]{1,4096}$/.test(token)) fail("云效 PAT 格式无效", 401, "authentication");
    const base = info.edition === "central" ? `/oapi/v1/flow/organizations/${flowId(info.organizationId, "组织 ID")}/` : "/oapi/v1/flow/";
    async function request(path, query = {}, method = "GET", body) {
      const url = new URL(path.startsWith("/") ? path : `${base}${path}`, origin);
      for (const [key, value] of Object.entries(query)) if (value != null && value !== "") url.searchParams.set(key, String(value));
      let response;
      try { response = await fetchImpl(url, { method, redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { "x-yunxiao-token": token, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
      catch { fail("连接云效失败，请检查网络和接入点", 502, "network"); }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); statusError(response.status); }
      try {
        const chunks = []; let length = 0;
        for await (const chunk of response.body) { length += chunk.length; if (length > 4 * 1024 * 1024) { await response.body.cancel().catch(() => {}); fail("云效返回内容超出限制", 502, "network"); } chunks.push(chunk); }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (error) { if (error instanceof FlowError) throw error; fail("云效返回内容格式无效", 502, "network"); }
    }
    return sanitize(await action(request, info), token);
  }
  const pageQuery = (args) => ({ page: flowInteger(args.page ?? 1, "页码"), perPage: flowInteger(args.perPage ?? 30, "每页条数", 1, 30) });
  const pipeline = (args) => flowId(args.pipelineId, "流水线 ID");
  const run = (args) => flowId(args.runId, "运行 ID");
  const job = (args) => flowId(args.jobId, "任务 ID");
  function runDetail(value, fallback) {
    const data = value.pipelineRun ?? value;
    const pipelineRunId = scalar(data, "pipelineRunId") ?? fallback;
    if (!pipelineRunId) fail("云效未返回运行记录 ID", 502, "network");
    const stages = (data.stages ?? data.stageGroup ?? []).slice(0, 100).map((stage) => {
      const info = stage.stageInfo ?? stage;
      return { name: scalar(info, "name") ?? scalar(stage, "name"), status: scalar(info, "status"), startTime: integer(info, "startTime"), endTime: integer(info, "endTime"),
        jobs: (info.jobs ?? []).slice(0, 100).map((item) => ({ id: scalar(item, "id"), name: scalar(item, "name"), status: scalar(item, "status"), startTime: integer(item, "startTime"), endTime: integer(item, "endTime"), steps: [] })) };
    });
    const terminal = ["SUCCESS", "FAIL", "FAILED", "CANCELED", "CANCELLED"].includes(scalar(data, "status")?.toUpperCase());
    const ends = stages.flatMap((stage) => [stage.endTime, ...stage.jobs.map((item) => item.endTime)]).filter((time) => time != null);
    return { pipelineRunId, status: scalar(data, "status"), startTime: integer(data, "startTime") ?? integer(data, "createTime"),
      endTime: integer(data, "endTime") ?? (terminal ? (ends.length ? Math.max(...ends) : integer(data, "updateTime")) : null), triggerMode: integer(data, "triggerMode"), creatorAccountId: scalar(data, "creatorAccountId"), creatorEmail: null,
      stages, sources: (data.sources ?? []).slice(0, 50).map((source) => { const data = source.data ?? source; const commit = data.commint ?? data.commit ?? data.commitInfo; return { sourceType: scalar(source, "type"), repository: scalar(data, "repo") ?? scalar(data, "repository"), branch: scalar(data, "branch"), commitId: scalar(commit, "shortId") ?? scalar(commit, "commitId") ?? scalar(commit, "id") ?? scalar(commit, "hash"), commitMessage: scalar(commit, "message") ?? scalar(commit, "comment") }; }) };
  }
  function logPage(value, offset = 0) {
    const data = payload(value); const log = data.log ?? data;
    const logs = scalar(log, "logs") ?? scalar(log, "content");
    if (logs == null) fail("云效未返回任务日志", 502, "network");
    const last = integer(log, "last");
    return { logs, more: log.more === true, nextOffset: last != null && last >= offset ? last : offset + Buffer.byteLength(logs) };
  }
  async function detail(request, info, value, fallback) {
    const result = runDetail(value, fallback);
    if (result.creatorAccountId && /^[a-zA-Z0-9_-]{1,128}$/.test(result.creatorAccountId)) {
      try {
        const memberPath = info.edition === "central" ? `/oapi/v1/platform/organizations/${flowId(info.organizationId)}/members:readByUser` : "/oapi/v1/platform/members:readByUser";
        const member = payload(await request(memberPath, { userId: result.creatorAccountId }));
        result.creatorEmail = scalar(member, "email") ?? scalar(member?.member, "email");
      } catch { /* Member lookup is optional; preserve the accessible run details. */ }
    }
    return result;
  }
  function deploymentId(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 12) return null;
    for (const key of ["deployOrderId", "deploymentOrderId"]) {
      const id = scalar(value, key);
      if (id && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) return id;
    }
    for (const child of Object.values(value)) { const id = deploymentId(child, depth + 1); if (id) return id; }
    return null;
  }
  return {
    test: (id) => withConnection(id, async (request) => { await request("pipelines", { page: 1, perPage: 1 }); return null; }),
    groups: (args) => withConnection(args.connectionId, async (request) => array(await request("pipelineGroups", { page: 1, perPage: 30 }), "分组").map((item) => ({ groupId: flowId(scalar(item, "id"), "分组 ID"), groupName: scalar(item, "name") || "未命名分组" }))),
    pipelines: async (args) => {
      const queryKey = flowPipelineQuery(args);
      let version;
      const items = await withConnection(args.connectionId, async (request, info) => {
        version = info.updatedAt;
        const query = pageQuery(args);
        if (args.keyword) query.pipelineName = args.keyword.trim();
        if (args.groupId) query.groupId = args.groupId;
        return array(await request(args.groupId ? "pipelineGroups/pipelines" : "pipelines", query), "流水线列表").slice(0, query.perPage).map((item) => ({ pipelineId: flowId(scalar(item, "pipelineId"), "流水线 ID"), pipelineName: scalar(item, "pipelineName") || "未命名流水线", createTime: integer(item, "createTime") ?? integer(item, "gmtCreate"), latestStatus: scalar(item, "status") }));
      });
      repository.savePipelineCache(queryKey.connectionId, queryKey.key, items, version);
      return items;
    },
    runs: (args) => withConnection(args.connectionId, async (request) => array(await request(`pipelines/${pipeline(args)}/runs`, pageQuery(args)), "运行记录").map((item) => ({ pipelineRunId: flowId(scalar(item, "pipelineRunId"), "运行 ID"), status: scalar(item, "status"), startTime: integer(item, "startTime"), endTime: integer(item, "endTime"), triggerMode: integer(item, "triggerMode"), creatorAccountId: scalar(item, "creatorAccountId") }))),
    run: (args) => withConnection(args.connectionId, async (request, info) => detail(request, info, await request(`pipelines/${pipeline(args)}/runs/${run(args)}`), args.runId)),
    latest: (args) => withConnection(args.connectionId, async (request, info) => detail(request, info, await request(`pipelines/${pipeline(args)}/runs/latestPipelineRun`))),
    start: (args) => withConnection(args.connectionId, async (request) => {
      const id = pipeline(args);
      const text = args.paramsJson || "{}";
      if (typeof text !== "string" || Buffer.byteLength(text) > 16384) fail("运行参数不能超过 16 KB");
      let params; try { params = JSON.parse(text); } catch { fail("运行参数必须是有效 JSON 对象"); }
      if (!params || typeof params !== "object" || Array.isArray(params)) fail("运行参数必须是 JSON 对象");
      const value = await request(`pipelines/${id}/runs`, {}, "POST", { params: JSON.stringify(params) });
      return flowId(typeof value === "number" || typeof value === "string" ? String(value) : scalar(value, "pipelineRunId"), "运行 ID");
    }),
    steps: (args) => withConnection(args.connectionId, async (request) => {
      const value = await request(`pipelines/${pipeline(args)}/pipelineRuns/${run(args)}/jobs/${job(args)}/steps`);
      const data = payload(value); const buildId = integer(data, "buildId") ?? integer(value, "buildId");
      const items = Array.isArray(data) ? data : data.steps;
      if (!Array.isArray(items)) fail("云效任务步骤返回结构无效", 502, "network");
      return items.slice(0, 500).map((step) => ({ stepIndex: integer(step, "stepIndex") ?? integer(step, "nodeIndex") ?? integer(step, "index"), buildId: integer(step, "buildId") ?? buildId, name: scalar(step, "stepName") ?? scalar(step, "nodeName") ?? scalar(step, "name") ?? scalar(step, "displayName"), status: scalar(step, "status") }));
    }),
    log: (args) => withConnection(args.connectionId, async (request) => {
      const query = { stepIndex: flowInteger(args.stepIndex, "步骤编号", 0), buildId: flowInteger(args.buildId, "构建 ID", 0), offset: flowInteger(args.offset ?? 0, "日志偏移", 0), limit: flowInteger(args.limit ?? 10000, "日志条数", 1, 10000) };
      return logPage(await request(`pipelines/${pipeline(args)}/pipelineRuns/${run(args)}/jobs/${job(args)}/step/log`, query), query.offset);
    }),
    jobLog: (args) => withConnection(args.connectionId, async (request) => {
      const pipelineId = pipeline(args), runId = run(args), jobId = job(args);
      const value = await request(`pipelines/${pipelineId}/runs/${runId}`);
      const data = value.pipelineRun ?? value;
      const stages = data.stages ?? data.stageGroup ?? [];
      const jobs = Array.isArray(stages) ? stages.flatMap((stage) => { const items = (stage.stageInfo ?? stage).jobs; return Array.isArray(items) ? items : []; }) : [];
      const item = jobs.find((item) => scalar(item, "id") === jobId);
      let result;
      try { result = typeof item?.result === "string" ? JSON.parse(item.result) : item?.result; } catch { result = null; }
      const orderId = deploymentId(result) ?? deploymentId(item);
      if (orderId) {
        const orderValue = payload(await request(`pipelines/${pipelineId}/deploy/${orderId}`));
        const machines = (orderValue.deployOrder ?? orderValue).deployMachineInfo?.deployMachines;
        const entries = []; let length = 0;
        for (const machine of (Array.isArray(machines) ? machines.slice(0, 50) : [])) {
          const sn = scalar(machine, "machineSn");
          if (!sn || !/^[a-zA-Z0-9_-]{1,128}$/.test(sn)) continue;
          const value = payload(await request(`pipelines/${pipelineId}/deploy/${orderId}/machine/${sn}/log`));
          const text = scalar(value.deployMachineLog ?? value, "deployLog");
          if (text) {
            const entry = `主机 ${scalar(machine, "ip") ?? sn}\n${text}`;
            length += Buffer.byteLength(entry);
            if (length > 4 * 1024 * 1024) fail("云效返回内容超出限制", 502, "network");
            entries.push(entry);
          }
        }
        if (entries.length) { const logs = entries.join("\n\n"); return { logs, more: false, nextOffset: Buffer.byteLength(logs) }; }
      }
      return logPage(await request(`pipelines/${pipelineId}/runs/${runId}/job/${jobId}/log`));
    }),
  };
}
