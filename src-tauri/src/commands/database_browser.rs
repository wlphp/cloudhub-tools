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
            let plan=prepared.plan.as_ref().ok_or("请先预览恢复影响")?;
            let _=request.force_restore;
            let result=restore_selection_bound(&prepared.database_path, &prepared.key, request.tables, request.mode.as_deref().unwrap_or("merge"),plan.include_trash,Some(&plan.revision))?;
            serde_json::to_value(format!("{result}；{}",plan.summary)).map_err(|_| "生成恢复结果失败".into())
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
            Err(error) => json!({"error": if error.contains("密码") { "备份密码错误或缺失，请填写正确密码后重新下载" } else { "备份恢复操作失败，请检查备份格式、恢复范围或重新下载备份" }}),
        };
        if writeln!(stdout, "{response}").and_then(|_| stdout.flush()).is_err() { break; }
    }
}
