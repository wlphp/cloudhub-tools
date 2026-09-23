use crate::core::{error::PlatformResult, repositories::flow_connections as repository, storage::open_db};
use crate::{decrypt_secret, encrypt_secret, FlowConnection, FlowConnectionInput, FlowGroup, FlowJob, FlowLogPage, FlowPipeline, FlowRun, FlowRunDetail, FlowSource, FlowStage, FlowStep};
use reqwest::{Client, Method, StatusCode, Url};
use serde_json::{json, Value};
use std::time::Duration;

const CENTRAL_DOMAIN: &str = "openapi-rdc.aliyuncs.com";

fn public_error(status: StatusCode) -> String {
    match status {
        StatusCode::UNAUTHORIZED => "云效 PAT 无效或已过期".into(),
        StatusCode::FORBIDDEN => "云效账号无权访问此组织或流水线".into(),
        StatusCode::NOT_FOUND => "云效流水线或运行记录不存在".into(),
        StatusCode::TOO_MANY_REQUESTS => "云效请求过于频繁，请稍后重试".into(),
        value if value.is_server_error() => "云效服务暂时不可用".into(),
        _ => format!("云效请求失败（HTTP {}）", status.as_u16()),
    }
}

fn validate_domain(domain: &str) -> Result<String, String> {
    let value = domain.trim();
    let normalized = if value.contains("://") { value.to_string() } else { format!("https://{value}") };
    let url = Url::parse(&normalized).map_err(|_| "云效接入点格式无效".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() || url.username() != "" || url.password().is_some() || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("云效接入点必须是 HTTPS 域名，且不能包含路径或凭据".into());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !host.ends_with(".aliyun.com") && !host.ends_with(".aliyuncs.com") { return Err("云效接入点必须使用阿里云官方域名".into()); }
    Ok(url.origin().ascii_serialization().trim_end_matches('/').to_string())
}

fn validate_connection(input: &FlowConnectionInput) -> Result<(String, String, Option<String>, String), String> {
    let name = input.name.trim();
    if name.is_empty() || name.len() > 100 { return Err("连接名称不能为空且不能超过 100 个字符".into()); }
    if !["central", "region"].contains(&input.edition.as_str()) { return Err("请选择有效的云效组织类型".into()); }
    let organization_id = input.organization_id.as_deref().map(str::trim).filter(|value| !value.is_empty());
    if input.edition == "central" && !organization_id.is_some_and(|value| value.len() <= 128 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
        return Err("中心版组织 ID 格式无效".into());
    }
    if input.edition == "region" && organization_id.is_some() { return Err("Region 版无需填写组织 ID".into()); }
    let domain = if input.edition == "central" { validate_domain(input.domain.as_deref().filter(|value| !value.trim().is_empty()).unwrap_or(CENTRAL_DOMAIN))? } else {
        validate_domain(input.domain.as_deref().ok_or("Region 版必须填写云效接入域名")?)?
    };
    Ok((name.to_string(), input.edition.clone(), organization_id.map(str::to_string), domain))
}

fn base_path(connection: &FlowConnection) -> String {
    if connection.edition == "central" { format!("/oapi/v1/flow/organizations/{}/", connection.organization_id.as_deref().unwrap_or_default()) } else { "/oapi/v1/flow/".to_string() }
}

async fn request(connection: &FlowConnection, token: &str, method: Method, path: &str, query: &[(&str, String)], body: Option<Value>) -> Result<Value, String> {
    let base = Url::parse(&connection.domain).map_err(|_| "云效接入点配置无效".to_string())?;
    let endpoint = if path.starts_with('/') { path.to_string() } else { format!("{}{}", base_path(connection), path.trim_start_matches('/')) };
    let url = base.join(&endpoint).map_err(|_| "云效 API 地址无效".to_string())?;
    let client = Client::builder().timeout(Duration::from_secs(30)).https_only(true).build().map_err(|_| "无法初始化云效安全连接".to_string())?;
    let mut req = client.request(method, url).header("x-yunxiao-token", token).header("accept", "application/json");
    for (key, value) in query { req = req.query(&[(key, value)]); }
    if let Some(body) = body { req = req.json(&body); }
    let response = req.send().await.map_err(|_| "连接云效失败，请检查网络和接入点".to_string())?;
    let status = response.status();
    if !status.is_success() { return Err(public_error(status)); }
    response.json::<Value>().await.map_err(|_| "云效返回内容格式无效".to_string())
}

fn load_connection(id: i64) -> Result<(FlowConnection, String), String> {
    let (connection, ciphertext) = repository::load_token(&open_db()?, id)?;
    Ok((connection, decrypt_secret(&ciphertext)?))
}

fn scalar_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(|item| item.as_str().map(str::to_string).or_else(|| item.as_i64().map(|n| n.to_string())))
}

fn as_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|item| item.as_i64().or_else(|| item.as_str().and_then(|text| text.parse().ok())))
}

fn as_step_index(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|item| item.as_i64()
        .or_else(|| item.as_str().and_then(|text| text.parse().ok()))
        .or_else(|| item.as_bool().map(i64::from)))
}

fn checked_array(value: Value, label: &str) -> Result<Vec<Value>, String> {
    if let Some(items) = value.as_array() { return Ok(items.clone()); }
    for key in ["items", "result", "data", "pipelines", "runs", "groups"] {
        if let Some(items) = value.get(key).and_then(Value::as_array) { return Ok(items.clone()); }
    }
    if value.is_null() { Ok(Vec::new()) } else { Err(format!("云效{label}返回结构无效")) }
}

#[tauri::command]
pub(crate) fn list_flow_connections() -> PlatformResult<Vec<FlowConnection>> { repository::list(&open_db()?).map_err(Into::into) }

#[tauri::command]
pub(crate) fn save_flow_connection(input: FlowConnectionInput) -> PlatformResult<FlowConnection> {
    let (name, edition, organization_id, domain) = validate_connection(&input)?;
    if input.id.is_some_and(|id| id <= 0) { return Err("云效连接 ID 无效".into()); }
    let conn = open_db()?;
    let token = match input.token.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) if value.len() <= 4096 => encrypt_secret(value)?,
        Some(_) => return Err("云效 PAT 长度无效".into()),
        None => match input.id { Some(id) => repository::existing_token(&conn, id)?.ok_or("云效连接不存在或未保存 PAT")?, None => return Err("首次创建云效连接必须填写 PAT".into()) },
    };
    repository::save(&conn, input.id, &name, &edition, organization_id.as_deref(), &domain, &token, chrono::Utc::now().timestamp_millis()).map_err(Into::into)
}

#[tauri::command]
pub(crate) fn delete_flow_connection(id: i64) -> PlatformResult<()> { if id <= 0 { return Err("云效连接 ID 无效".into()); } repository::delete(&open_db()?, id).map_err(Into::into) }

#[tauri::command]
pub(crate) async fn test_flow_connection(id: i64) -> PlatformResult<()> {
    let (connection, token) = load_connection(id)?;
    request(&connection, &token, Method::GET, "pipelines", &[("page", "1".into()), ("perPage", "1".into())], None).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_flow_groups(connection_id: i64) -> PlatformResult<Vec<FlowGroup>> {
    if connection_id <= 0 { return Err("云效连接 ID 无效".into()); }
    let (connection, token) = load_connection(connection_id)?;
    let value = request(&connection, &token, Method::GET, "pipelineGroups", &[("page", "1".into()), ("perPage", "30".into())], None).await?;
    checked_array(value, "流水线分组")?.iter().map(|item| Ok(FlowGroup {
        group_id: scalar_string(item, "id").ok_or("云效流水线分组缺少 ID")?,
        group_name: scalar_string(item, "name").ok_or("云效流水线分组缺少名称")?,
    })).collect::<Result<Vec<_>, String>>().map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn list_flow_pipelines(connection_id: i64, page: u32, per_page: u32, keyword: Option<String>, group_id: Option<String>) -> PlatformResult<Vec<FlowPipeline>> {
    if connection_id <= 0 || page == 0 || !(1..=30).contains(&per_page) { return Err("流水线分页参数无效".into()); }
    let (connection, token) = load_connection(connection_id)?;
    let mut query = vec![("page", page.to_string()), ("perPage", per_page.to_string())];
    if let Some(keyword) = keyword.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) { if keyword.len() > 128 { return Err("搜索内容不能超过 128 个字符".into()); } query.push(("pipelineName", keyword)); }
    let path = if let Some(group_id) = group_id.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        if group_id.len() > 20 || !group_id.chars().all(|c| c.is_ascii_digit()) { return Err("流水线分组 ID 格式无效".into()); }
        query.push(("groupId", group_id));
        "pipelineGroups/pipelines"
    } else { "pipelines" };
    let value = request(&connection, &token, Method::GET, path, &query, None).await?;
    checked_array(value, "流水线列表")?.iter().map(|item| {
        let pipeline_id = scalar_string(item, "pipelineId").ok_or("云效流水线缺少 ID")?;
        let pipeline_name = scalar_string(item, "pipelineName").ok_or("云效流水线缺少名称")?;
        Ok(FlowPipeline { pipeline_id, pipeline_name, create_time: as_i64(item, "createTime").or_else(|| as_i64(item, "gmtCreate")), latest_status: scalar_string(item, "status") })
    }).collect::<Result<Vec<_>, String>>().map_err(Into::into)
}

fn endpoint_id<'a>(value: &'a str, name: &str) -> Result<&'a str, String> {
    if value.is_empty() || value.len() > 128 || !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return Err(format!("{name}格式无效")); }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn list_flow_runs(connection_id: i64, pipeline_id: String, page: u32, per_page: u32) -> PlatformResult<Vec<FlowRun>> {
    if connection_id <= 0 || page == 0 || !(1..=30).contains(&per_page) { return Err("运行记录分页参数无效".into()); }
    endpoint_id(&pipeline_id, "流水线 ID")?;
    let (connection, token) = load_connection(connection_id)?;
    let value = request(&connection, &token, Method::GET, &format!("pipelines/{pipeline_id}/runs"), &[("page", page.to_string()), ("perPage", per_page.to_string())], None).await?;
    checked_array(value, "运行记录")?.iter().map(|item| Ok(FlowRun {
        pipeline_run_id: scalar_string(item, "pipelineRunId").ok_or("云效运行记录缺少 ID")?, start_time: as_i64(item, "startTime"), end_time: as_i64(item, "endTime"), status: scalar_string(item, "status"), trigger_mode: as_i64(item, "triggerMode"), creator_account_id: scalar_string(item, "creatorAccountId"),
    })).collect::<Result<Vec<_>, String>>().map_err(Into::into)
}

fn stage_from_value(value: &Value) -> FlowStage {
    let info = value.get("stageInfo").unwrap_or(value);
    let jobs = info.get("jobs").and_then(Value::as_array).cloned().unwrap_or_default().iter().map(|job| FlowJob {
        id: scalar_string(job, "id"), name: scalar_string(job, "name"), status: scalar_string(job, "status"), start_time: as_i64(job, "startTime"), end_time: as_i64(job, "endTime"), steps: Vec::new(),
    }).collect();
    FlowStage { name: scalar_string(info, "name").or_else(|| scalar_string(value, "name")), status: scalar_string(info, "status"), start_time: as_i64(info, "startTime"), end_time: as_i64(info, "endTime"), jobs }
}

fn source_from_value(value: &Value) -> FlowSource {
    let data = value.get("data").unwrap_or(value);
    let commit = data.get("commint").or_else(|| data.get("commit")).or_else(|| data.get("commitInfo"));
    FlowSource {
        source_type: scalar_string(value, "type"),
        repository: scalar_string(data, "repo").or_else(|| scalar_string(data, "repository")),
        branch: scalar_string(data, "branch"),
        commit_id: commit.and_then(|item| scalar_string(item, "shortId").or_else(|| scalar_string(item, "commitId")).or_else(|| scalar_string(item, "id")).or_else(|| scalar_string(item, "hash"))),
        commit_message: commit.and_then(|item| scalar_string(item, "message").or_else(|| scalar_string(item, "comment"))),
    }
}

fn run_detail_from_value(value: Value, fallback_run_id: Option<String>) -> Result<FlowRunDetail, String> {
    let run = value.get("pipelineRun").unwrap_or(&value);
    let run_id = scalar_string(run, "pipelineRunId").or(fallback_run_id).ok_or("云效未返回运行记录 ID")?;
    let stages_value = run.get("stages").or_else(|| run.get("stageGroup")).and_then(Value::as_array).cloned().unwrap_or_default();
    let stages: Vec<FlowStage> = stages_value.iter().map(stage_from_value).collect();
    let sources = run.get("sources").and_then(Value::as_array).map(|items| items.iter().map(source_from_value).collect()).unwrap_or_default();
    let status = scalar_string(run, "status");
    let terminal = status.as_deref().is_some_and(|value| matches!(value.to_ascii_uppercase().as_str(), "SUCCESS" | "FAIL" | "FAILED" | "CANCELED" | "CANCELLED"));
    let stage_end_time = stages.iter().flat_map(|stage| {
        std::iter::once(stage.end_time).chain(stage.jobs.iter().map(|job| job.end_time))
    }).flatten().max();
    let end_time = as_i64(run, "endTime").or_else(|| terminal.then_some(stage_end_time).flatten()).or_else(|| terminal.then(|| as_i64(run, "updateTime")).flatten());
    Ok(FlowRunDetail { pipeline_run_id: run_id, status, start_time: as_i64(run, "startTime").or_else(|| as_i64(run, "createTime")), end_time, trigger_mode: as_i64(run, "triggerMode"), creator_account_id: scalar_string(run, "creatorAccountId"), creator_email: None, sources, stages })
}

async fn resolve_creator_email(connection: &FlowConnection, token: &str, user_id: Option<&str>) -> Option<String> {
    let user_id = user_id.filter(|id| !id.is_empty() && id.len() <= 128)?;
    let path = if connection.edition == "central" {
        format!("/oapi/v1/platform/organizations/{}/members:readByUser", connection.organization_id.as_deref()?)
    } else {
        "/oapi/v1/platform/members:readByUser".to_string()
    };
    let value = request(connection, token, Method::GET, &path, &[("userId", user_id.to_string())], None).await.ok()?;
    value.get("email").or_else(|| value.pointer("/member/email")).and_then(Value::as_str).map(str::to_string).filter(|email| email.contains('@'))
}

#[tauri::command]
pub(crate) async fn get_flow_run(connection_id: i64, pipeline_id: String, run_id: String) -> PlatformResult<FlowRunDetail> {
    if connection_id <= 0 { return Err("云效连接 ID 无效".into()); }
    endpoint_id(&pipeline_id, "流水线 ID")?; endpoint_id(&run_id, "运行记录 ID")?;
    let (connection, token) = load_connection(connection_id)?;
    let value = request(&connection, &token, Method::GET, &format!("pipelines/{pipeline_id}/runs/{run_id}"), &[], None).await?;
    let mut detail = run_detail_from_value(value, Some(run_id))?;
    detail.creator_email = resolve_creator_email(&connection, &token, detail.creator_account_id.as_deref()).await;
    Ok(detail)
}

#[tauri::command]
pub(crate) async fn get_flow_latest_run(connection_id: i64, pipeline_id: String) -> PlatformResult<FlowRunDetail> {
    if connection_id <= 0 { return Err("云效连接 ID 无效".into()); }
    endpoint_id(&pipeline_id, "流水线 ID")?;
    let (connection, token) = load_connection(connection_id)?;
    let value = request(&connection, &token, Method::GET, &format!("pipelines/{pipeline_id}/runs/latestPipelineRun"), &[], None).await?;
    let mut detail = run_detail_from_value(value, None)?;
    detail.creator_email = resolve_creator_email(&connection, &token, detail.creator_account_id.as_deref()).await;
    Ok(detail)
}

#[tauri::command]
pub(crate) async fn run_flow_pipeline(connection_id: i64, pipeline_id: String, params_json: Option<String>) -> PlatformResult<String> {
    if connection_id <= 0 { return Err("云效连接 ID 无效".into()); }
    endpoint_id(&pipeline_id, "流水线 ID")?;
    let params_value = match params_json.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) if value.len() <= 16384 => { let parsed: Value = serde_json::from_str(value).map_err(|_| "运行参数必须是有效 JSON".to_string())?; if !parsed.is_object() { return Err("运行参数必须是 JSON 对象".into()); } parsed },
        Some(_) => return Err("运行参数不能超过 16 KB".into()),
        None => json!({}),
    };
    let body = json!({ "params": params_value.to_string() });
    let (connection, token) = load_connection(connection_id)?;
    let value = request(&connection, &token, Method::POST, &format!("pipelines/{pipeline_id}/runs"), &[], Some(body)).await?;
    if let Some(id) = value.as_i64().or_else(|| value.as_str().and_then(|v| v.parse().ok())).or_else(|| value.get("pipelineRunId").and_then(Value::as_i64)) { return Ok(id.to_string()); }
    Err("云效未返回运行记录 ID".into())
}

#[tauri::command]
pub(crate) async fn get_flow_job_steps(connection_id: i64, pipeline_id: String, run_id: String, job_id: String) -> PlatformResult<Vec<FlowStep>> {
    if connection_id <= 0 { return Err("云效连接 ID 无效".into()); }
    endpoint_id(&pipeline_id, "流水线 ID")?; endpoint_id(&run_id, "运行记录 ID")?; endpoint_id(&job_id, "任务 ID")?;
    let (connection, token) = load_connection(connection_id)?;
    let value = request(&connection, &token, Method::GET, &format!("pipelines/{pipeline_id}/pipelineRuns/{run_id}/jobs/{job_id}/steps"), &[], None).await?;
    let payload = value.get("data").or_else(|| value.get("result")).unwrap_or(&value);
    let build_id = as_i64(payload, "buildId").or_else(|| as_i64(&value, "buildId"));
    let steps = payload.get("steps").and_then(Value::as_array).cloned().or_else(|| payload.as_array().cloned()).ok_or("云效任务步骤返回结构无效")?;
    steps.iter().map(|step| Ok(FlowStep { step_index: as_step_index(step, "stepIndex").or_else(|| as_step_index(step, "nodeIndex")).or_else(|| as_step_index(step, "index")), build_id: as_i64(step, "buildId").or(build_id), name: scalar_string(step, "stepName").or_else(|| scalar_string(step, "nodeName")).or_else(|| scalar_string(step, "name")).or_else(|| scalar_string(step, "displayName")), status: scalar_string(step, "status") })).collect::<Result<Vec<_>, String>>().map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn get_flow_job_log(connection_id: i64, pipeline_id: String, run_id: String, job_id: String, step_index: i64, build_id: i64, offset: i64, limit: i64) -> PlatformResult<FlowLogPage> {
    if connection_id <= 0 || step_index < 0 || build_id < 0 || offset < 0 || !(1..=10000).contains(&limit) { return Err("任务日志分页参数无效".into()); }
    endpoint_id(&pipeline_id, "流水线 ID")?; endpoint_id(&run_id, "运行记录 ID")?; endpoint_id(&job_id, "任务 ID")?;
    let (connection, token) = load_connection(connection_id)?;
    let value = request(&connection, &token, Method::GET, &format!("pipelines/{pipeline_id}/pipelineRuns/{run_id}/jobs/{job_id}/step/log"), &[("stepIndex",step_index.to_string()),("buildId",build_id.to_string()),("offset",offset.to_string()),("limit",limit.to_string())], None).await?;
    let payload = value.get("data").or_else(|| value.get("result")).unwrap_or(&value);
    let log = payload.get("log").unwrap_or(payload);
    let logs = log.get("logs").or_else(|| log.get("content")).and_then(Value::as_str).ok_or("云效未返回任务日志")?.to_string();
    let more = log.get("more").and_then(Value::as_bool).unwrap_or(false);
    let next_offset = as_i64(log, "last").unwrap_or_else(|| offset.saturating_add(logs.len() as i64));
    Ok(FlowLogPage { logs, more, next_offset })
}
