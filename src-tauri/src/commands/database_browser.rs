//! Private local API pipe. Restore uses the same portable importer as the GUI.
use super::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    op: String,
    #[serde(default)] path: String,
    #[serde(default)] password: String,
    #[serde(default)] token: String,
    tables: Option<Vec<String>>,
    mode: Option<String>,
    #[serde(default)] include_trash: bool,
    #[serde(default)] force_restore: bool,
}

fn dispatch(state: &DatabaseImportStore, request: Request) -> Result<Value, String> {
    match request.op.as_str() {
        "backup" => {
            let path = PathBuf::from(&request.path);
            let name = path.file_name().and_then(|name| name.to_str()).ok_or("备份路径无效")?;
            let id = name.strip_prefix(".browser-upload-").and_then(|name| name.strip_suffix(".chdb")).ok_or("备份路径无效")?;
            if Uuid::parse_str(id).is_err() || path.parent().and_then(|parent| parent.canonicalize().ok()).as_deref() != Some(data_dir()?.as_path()) || path.exists() { return Err("备份路径无效".into()); }
            let bytes = Zeroizing::new(cloud_snapshot_scoped(None,request.tables)?);
            write_new_or_replace(&path, &bytes)?;
            Ok(Value::Null)
        }
        "preview" => {
            if state.sessions.lock().map_err(|_| "恢复状态不可用")?.len() >= 4 { return Err("请先关闭已有恢复预览".into()); }
            let path = PathBuf::from(&request.path).canonicalize().map_err(|_| "找不到临时备份")?;
            if path.parent() != Some(data_dir()?.as_path()) || !path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(".browser-backup-") && n.ends_with(".chdb")) { return Err("备份路径无效".into()); }
            if fs::metadata(&path).map_err(|_| "读取备份失败")?.len() > MAX_PACKAGE_BYTES { return Err("备份超过 256 MB 限制".into()); }
            let bytes = Zeroizing::new(fs::read(path).map_err(|_| "读取备份失败")?);
            serde_json::to_value(prepare_cloud_snapshot(&bytes, Some(request.password), state)?).map_err(|_| "生成预览失败".into())
        }
        "catalog" => serde_json::to_value(database_transfer_catalog().map_err(|_|"读取范围失败")?).map_err(|_|"读取范围失败".into()),
        "plan" => serde_json::to_value(plan_restore(state,&request.token,request.tables,request.mode,request.include_trash)?).map_err(|_|"生成恢复计划失败".into()),
        "confirm" => {
            let _transfer = lock_transfer()?;
            if !matches!(request.mode.as_deref(), Some("replace" | "merge" | "overwrite")) || request.tables.as_ref().is_none_or(|tables| tables.is_empty()) { return Err("请选择恢复范围和方式".into()); }
            sql::selected(request.tables.clone())?;
            {
                let sessions=state.sessions.lock().map_err(|_|"恢复状态不可用")?;
                validate_restore_binding(sessions.get(&request.token).ok_or("恢复预览已失效")?,request.tables.as_deref(),request.mode.as_deref())?;
            }
            let prepared = state.sessions.lock().map_err(|_| "恢复状态不可用")?.remove(&request.token).ok_or("恢复预览已失效")?;
            create_recovery_backup()?;
            // The private helper has no running GUI/runtime processes. Node drains
            // API requests and closes its SQLite connection before this call.
            let _=request.force_restore;
            // The impact preview is advisory here as well: a failed preview must
            // not block the restore, and the restore reports its own errors.
            let include_trash=prepared.plan.as_ref().map(|plan|plan.include_trash).unwrap_or(request.include_trash);
            let revision=prepared.plan.as_ref().map(|plan|plan.revision.as_str());
            let result=restore_selection_bound(&prepared.database_path, &prepared.key, request.tables, request.mode.as_deref().unwrap_or("merge"),include_trash,revision)?;
            let summary=prepared.plan.as_ref().map(|plan|plan.summary.as_str()).unwrap_or_default();
            serde_json::to_value(if summary.is_empty() { result } else { format!("{result}；{summary}") }).map_err(|_| "生成恢复结果失败".into())
        }
        "cancel" => {
            state.sessions.lock().map_err(|_| "恢复状态不可用")?.remove(&request.token);
            Ok(Value::Null)
        }
        _ => Err("恢复操作无效".into()),
    }
}

pub(crate) fn run() {
    // Match GUI startup migrations before reading previews against this database.
    if open_db().is_err() { return; }
    let state = DatabaseImportStore::default();
    let mut stdout = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let line = Zeroizing::new(line);
        let result = if line.len() > 32 * 1024 { Err("恢复参数过大".into()) } else {
            serde_json::from_str::<Request>(&line).map_err(|_| "恢复参数无效".to_string()).and_then(|request| dispatch(&state, request))
        };
        // Never expose SQLite/IO details, data values or package parser errors.
        let response = match result {
            Ok(value) => json!({"result": value}),
            Err(error) => {
                let (message, safe) = safe_restore_error(&error);
                json!({"error": message, "safe": safe})
            },
        };
        if writeln!(stdout, "{response}").and_then(|_| stdout.flush()).is_err() { break; }
    }
}

fn safe_restore_error(error: &str) -> (&'static str, bool) {
    const SAFE_ERRORS: &[&str] = &[
        "恢复预览已失效", "恢复范围或方式已变化，请重新预览", "本地数据已变化，请重新预览恢复影响",
        "所选模块不在备份范围中", "旧备份不支持验证器恢复，请取消选择验证器",
        "备份来自更新版本，请升级客户端", "备份来自更新版本，请升级客户端后恢复",
        "恢复方式无效", "请选择恢复范围", "请选择恢复范围和方式",
        "所选模块被未选择的模块引用；请同时选择关联模块，或使用合并恢复",
        "所选记录仍被 RDP 连接引用，请同时选择关联模块或使用追加恢复",
        "所选记录仍被资产自定义信息引用，请同时选择关联模块或使用追加恢复",
        "SQL 缺少关联的父记录，请同时导出云账号、主机或 FRP 服务端",
        "迁移包包含重复验证码种子", "同一验证码标识的种子已变化，已取消导入",
        "数据库正在使用，请重试", "恢复未提交，原有数据保持不变",
        "SQL 格式、数据或版本无效；仅支持 CloudHub 导出的 SQL，当前数据未修改",
        "备份密码错误或缺失，请填写正确密码后重新下载", "验证码格式无效", "验证码标识无效",
        "验证器本机密钥文件缺失，需从独立备份恢复", "无法读取验证器本机密钥",
        "云盘凭据转换失败", "云盘连接格式无效", "资产自定义信息格式无效",
    ];
    if let Some(message) = SAFE_ERRORS.iter().copied().find(|message| *message == error) { return (message, true); }
    if error.contains("密码") { return ("备份密码错误或缺失，请填写正确密码后重新下载", true); }
    ("备份恢复操作失败，请检查备份格式、恢复范围或重新下载备份", false)
}
