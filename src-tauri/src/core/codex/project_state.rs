//! Preserve Codex's local project catalog when CloudHub changes the default
//! Codex identity. This deliberately touches only renderer project metadata.
use serde_json::{Map, Value};
use std::{fs, io::Write, path::Path};

const ACCOUNT_KEY: &str = "electron-account-renderer-state-v1";
const ATOM_KEY: &str = "electron-persisted-atom-state";
const MAX_STATE_BYTES: u64 = 32 * 1024 * 1024;
const DICTIONARIES: &[&str] = &[
    "local-projects",
    "thread-project-assignments",
    "thread-project-membership-host-ids",
    "thread-workspace-root-hints",
    "thread-projectless-output-directories",
    "sidebar-project-thread-orders",
    "queued-follow-ups",
    ATOM_KEY,
];
const LISTS: &[&str] = &["project-order", "pinned-project-ids", "pinned-thread-ids"];

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
        fn GetLastError() -> u32;
    }
    let replacement: Vec<u16> = OsStr::new(source).encode_wide().chain(Some(0)).collect();
    let replaced: Vec<u16> = OsStr::new(destination)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let ok = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            0x1,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        let code = unsafe { GetLastError() };
        return Err(format!(
            "替换 Codex 项目状态失败（Windows 错误 {code}），原始备份已保留"
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|_| "替换 Codex 项目状态失败，原始备份已保留".into())
}

/// Merge account-scoped project state back into the global renderer state.
/// Must only be called after the caller has confirmed that Codex is not running.
/// A no-op when the account-scoped key is absent.
pub fn preserve_before_identity_change(home: &Path) -> Result<(), String> {
    let path = home.join(".codex-global-state.json");
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("检查 Codex 项目状态文件失败".into()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_STATE_BYTES {
        return Err("Codex 项目状态文件类型或大小无效，已停止切换".into());
    }
    let original = fs::read(&path).map_err(|_| "读取 Codex 项目状态失败，已停止切换")?;
    let mut state: Value = serde_json::from_slice(&original)
        .map_err(|_| "Codex 项目状态格式异常，未修改文件并已停止切换")?;
    let root = state
        .as_object_mut()
        .ok_or("Codex 项目状态结构异常，已停止切换")?;
    let Some(account) = root.get(ACCOUNT_KEY) else {
        return Ok(());
    };
    let account = account
        .as_object()
        .ok_or("Codex 账户状态结构异常，已停止切换")?;
    match account.get("owner") {
        Some(Value::Null) => {}
        Some(_) => return Ok(()),
        None => return Err("Codex 账户状态缺少 owner，已停止切换".into()),
    }
    let inactive = match account.get("inactive") {
        Some(value) => Some(
            value
                .as_object()
                .ok_or("Codex 账户存档结构异常，未改动文件")?,
        ),
        None => None,
    };
    if inactive.is_none_or(|buckets| buckets.is_empty()) {
        return Err("Codex 账户存档为空，无法安全保全侧栏项目，已停止切换".into());
    }
    // Codex writes this file while running; do not race its renderer/app-server.
    super::profile::ensure_default_idle()?;
    let mut globals: Vec<Map<String, Value>> = Vec::new();
    let mut archived_atoms: Vec<Map<String, Value>> = Vec::new();
    for bucket in inactive.into_iter().flat_map(|buckets| buckets.values()) {
        let obj = bucket
            .as_object()
            .ok_or("Codex 项目存档结构异常，未改动文件")?;
        if let Some(value) = obj.get("globals") {
            globals.push(
                value
                    .as_object()
                    .ok_or("Codex 项目全局存档结构异常，未改动文件")?
                    .clone(),
            );
        }
        if let Some(value) = obj.get("atoms") {
            archived_atoms.push(
                value
                    .as_object()
                    .ok_or("Codex 项目偏好存档结构异常，未改动文件")?
                    .clone(),
            );
        }
    }
    if let Some(value) = account.get("globals") {
        globals.push(
            value
                .as_object()
                .ok_or("Codex 当前全局状态结构异常，未改动文件")?
                .clone(),
        );
    }
    if let Some(value) = account.get("atoms") {
        archived_atoms.push(
            value
                .as_object()
                .ok_or("Codex 当前偏好状态结构异常，未改动文件")?
                .clone(),
        );
    }

    for globals in globals.iter().chain(std::iter::once(&*root)) {
        for key in DICTIONARIES {
            if globals.get(*key).is_some_and(|value| !value.is_object()) {
                return Err(format!("Codex 项目状态字段 {key} 结构异常，未改动文件"));
            }
        }
        for key in LISTS
            .iter()
            .chain(std::iter::once(&"projectless-thread-ids"))
        {
            if globals.get(*key).is_some_and(|value| !value.is_array()) {
                return Err(format!("Codex 项目状态字段 {key} 结构异常，未改动文件"));
            }
        }
        for key in [
            "app-server-project-id-by-legacy-project-id-by-host",
            "app-server-projects-migration-by-host",
        ] {
            if globals.get(key).is_some_and(|value| !value.is_object()) {
                return Err(format!("Codex 项目迁移字段 {key} 结构异常，未改动文件"));
            }
        }
    }

    for key in DICTIONARIES {
        let mut merged = Map::new();
        for bucket in &globals {
            if let Some(values) = bucket.get(*key).and_then(Value::as_object) {
                merged.extend(values.clone());
            }
        }
        if let Some(top) = root.get(*key).and_then(Value::as_object) {
            merged.extend(top.clone());
        }
        if !merged.is_empty() {
            root.insert((*key).to_string(), Value::Object(merged));
        }
    }
    for key in LISTS {
        let mut merged = Vec::new();
        for value in std::iter::once(root.get(*key))
            .chain(globals.iter().map(|g| g.get(*key)))
            .flatten()
            .filter_map(Value::as_array)
            .flatten()
        {
            if !merged.contains(value) {
                merged.push(value.clone());
            }
        }
        if !merged.is_empty() {
            root.insert((*key).to_string(), Value::Array(merged));
        }
    }
    // Keep the current selection when present; otherwise use the newest
    // available archived selection without inventing an owner.
    if !root.contains_key("selected-project") {
        if let Some(value) = globals.iter().rev().find_map(|g| g.get("selected-project")) {
            root.insert("selected-project".into(), value.clone());
        }
    }
    // Migration maps are host-scoped; merge host records while preserving the
    // current top-level record on conflicts.
    for key in [
        "app-server-project-id-by-legacy-project-id-by-host",
        "app-server-projects-migration-by-host",
    ] {
        let mut merged = Map::new();
        for bucket in &globals {
            if let Some(hosts) = bucket.get(key).and_then(Value::as_object) {
                for (host, record) in hosts {
                    merged.entry(host.clone()).or_insert_with(|| record.clone());
                }
            }
        }
        if let Some(hosts) = root.get(key).and_then(Value::as_object) {
            merged.extend(hosts.clone());
        }
        if key == "app-server-projects-migration-by-host" {
            for bucket in &globals {
                if let Some(hosts) = bucket.get(key).and_then(Value::as_object) {
                    for (host, archived) in hosts {
                        let Some(ids) = archived
                            .get("pendingThreadAssignmentIds")
                            .and_then(Value::as_array)
                        else {
                            continue;
                        };
                        let current = merged
                            .entry(host.clone())
                            .or_insert_with(|| archived.clone());
                        if let Some(current) = current.as_object_mut() {
                            let pending = current
                                .entry("pendingThreadAssignmentIds")
                                .or_insert_with(|| Value::Array(Vec::new()));
                            if let Some(current_ids) = pending.as_array_mut() {
                                for id in ids {
                                    if !current_ids.contains(id) {
                                        current_ids.push(id.clone());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if !merged.is_empty() {
            root.insert(key.into(), Value::Object(merged));
        }
    }
    // Preserve projectless membership too; entries that have a project
    // assignment must not also remain in the projectless list.
    let assigned = root
        .get("thread-project-assignments")
        .and_then(Value::as_object)
        .map(|v| v.keys().cloned().collect::<std::collections::HashSet<_>>())
        .unwrap_or_default();
    let mut projectless = Vec::new();
    for value in std::iter::once(root.get("projectless-thread-ids"))
        .chain(globals.iter().map(|g| g.get("projectless-thread-ids")))
        .flatten()
        .filter_map(Value::as_array)
        .flatten()
    {
        if let Some(id) = value.as_str() {
            if !assigned.contains(id) && !projectless.contains(value) {
                projectless.push(value.clone());
            }
        }
    }
    if !projectless.is_empty() {
        root.insert("projectless-thread-ids".into(), Value::Array(projectless));
    }

    // Keep other renderer globals as well; this envelope can contain values
    // unknown to this version of CloudHub.
    for bucket in &globals {
        for (key, value) in bucket {
            if key != ACCOUNT_KEY {
                root.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
    }
    let mut atoms = Map::new();
    for archived in &archived_atoms {
        atoms.extend(archived.clone());
    }
    if let Some(current) = root.get(ATOM_KEY).and_then(Value::as_object) {
        atoms.extend(current.clone());
    }
    if !atoms.is_empty() {
        root.insert(ATOM_KEY.into(), Value::Object(atoms));
    }

    root.remove(ACCOUNT_KEY);
    let bytes = serde_json::to_vec(&state).map_err(|_| "序列化 Codex 项目状态失败，未修改文件")?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("合并后的 Codex 项目状态过大，已停止切换".into());
    }

    // Make and verify a private, recoverable backup before replacing anything.
    let backup = home.join(format!(
        ".codex-global-state.pre-cloudhub-{}.bak",
        uuid::Uuid::new_v4()
    ));
    fs::copy(&path, &backup).map_err(|_| "备份 Codex 项目状态失败，已停止切换")?;
    if fs::read(&backup).map_err(|_| "验证 Codex 项目状态备份失败")? != original {
        let _ = fs::remove_file(&backup);
        return Err("Codex 项目状态备份校验失败，已停止切换".into());
    }

    let temp = home.join(format!(".codex-global-state.{}.tmp", uuid::Uuid::new_v4()));
    let write_result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "创建 Codex 项目状态临时文件失败")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "写入 Codex 项目状态临时文件失败")?;
        drop(file);
        replace_file(&temp, &path)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result?;
    let verified: Value =
        serde_json::from_slice(&fs::read(&path).map_err(|_| "回读 Codex 项目状态失败")?)
            .map_err(|_| "回读 Codex 项目状态格式异常")?;
    if verified.get(ACCOUNT_KEY).is_some()
        || verified.get("local-projects") != state.get("local-projects")
    {
        return Err("Codex 项目状态写入校验失败；原始备份已保留".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture_home() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "cloudhub-codex-project-state-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn merges_project_catalogs_and_keeps_top_level_order_first() {
        let home = fixture_home();
        let path = home.join(".codex-global-state.json");
        let state = serde_json::json!({
            "project-order":["top"], "local-projects":{"top":{"name":"current"}},
            "thread-project-assignments":{"t2":{"projectId":"top"}},
            ACCOUNT_KEY: {
                "owner": null,
                "inactive": { "old": {
                    "globals": {
                        "project-order":["old","top"], "local-projects":{"old":{"name":"archived"}},
                        "thread-project-assignments":{"t1":{"projectId":"old"}},
                        "projectless-thread-ids":["t1","t3"], "extra-preserved-key":{"v":1}
                    },
                    "atoms":{"theme":{"value":"dark"}}
                }}
            }
        });
        let original = serde_json::to_vec(&state).unwrap();
        fs::write(&path, &original).unwrap();
        preserve_before_identity_change(&home).unwrap();
        let merged: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(merged.get(ACCOUNT_KEY).is_none());
        assert!(merged["local-projects"].get("old").is_some());
        assert!(merged["local-projects"].get("top").is_some());
        assert_eq!(merged["project-order"], serde_json::json!(["top", "old"]));
        assert!(merged["thread-project-assignments"].get("t1").is_some());
        assert_eq!(merged["projectless-thread-ids"], serde_json::json!(["t3"]));
        assert_eq!(merged["extra-preserved-key"]["v"], 1);
        assert_eq!(merged[ATOM_KEY]["theme"]["value"], "dark");
        let backups: Vec<_> = fs::read_dir(&home)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(backups[0].path()).unwrap(), original);
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn malformed_state_is_left_untouched() {
        let home = fixture_home();
        let path = home.join(".codex-global-state.json");
        let original =
            br#"{"electron-account-renderer-state-v1":{"owner":null,"inactive":{"old":false}}}"#;
        fs::write(&path, original).unwrap();
        assert!(preserve_before_identity_change(&home).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn active_owner_state_is_not_flattened_or_rewritten() {
        let home = fixture_home();
        let path = home.join(".codex-global-state.json");
        let original = serde_json::to_vec(&serde_json::json!({
            "local-projects": {"active": {"name": "active"}},
            ACCOUNT_KEY: {
                "owner": "account-hash",
                "inactive": {"old": {"globals": {"local-projects": {"old": {"name": "old"}}}}}
            }
        })).unwrap();
        fs::write(&path, &original).unwrap();
        preserve_before_identity_change(&home).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn null_owner_without_inactive_buckets_is_left_untouched() {
        let home = fixture_home();
        let path = home.join(".codex-global-state.json");
        let original = serde_json::to_vec(&serde_json::json!({
            ACCOUNT_KEY: {"owner": null, "inactive": {}}
        })).unwrap();
        fs::write(&path, &original).unwrap();
        assert!(preserve_before_identity_change(&home).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
        fs::remove_dir_all(home).unwrap();
    }
}
