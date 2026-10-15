//! Account-labelled login configuration snapshots. Never reads chat databases or patches clients.
use super::wechat_plugin::plugin_error;
use crate::core::error::PlatformResult;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionInfo {
    id: String,
    label: String,
    created_at: u64,
    data_path: String,
    recovery: bool,
    family: &'static str,
}

#[cfg(windows)]
pub(super) mod windows {
    use super::*;
    use crate::commands::wechat_plugin::windows::{
        process_ids, running_processes, validate_path, LAUNCH_LOCK,
    };
    use crate::core::storage::{data_dir, decrypt_secret, encrypt_secret};
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::{
        fs::{self, File, OpenOptions},
        io::{Read, Seek, SeekFrom, Write},
        path::{Path, PathBuf},
        process::{Command, Stdio},
        time::{SystemTime, UNIX_EPOCH},
    };
    use zeroize::{Zeroize, Zeroizing};

    const LIMIT: u64 = 1024 * 1024;
    const STORE_LIMIT: u64 = 16 * 1024 * 1024;
    const NEW_FILES: &[&str] = &[
        "all_users/config/global_config",
        "all_users/config/global_config.crc",
    ];
    const OLD_FILES: &[&str] = &["All Users/config/config.data"];
    const IO_ERROR: &str = "微信配置操作失败，请检查目录权限和磁盘空间";
    const FORMAT_ERROR: &str = "微信配置快照无效或不兼容，请重新保存";

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(
            callback: unsafe extern "system" fn(isize, isize) -> i32,
            param: isize,
        ) -> i32;
        fn IsWindowVisible(window: isize) -> i32;
        fn GetWindowThreadProcessId(window: isize, pid: *mut u32) -> u32;
    }
    fn visible_wechat_windows() -> PlatformResult<std::collections::HashSet<isize>> {
        struct Context {
            pids: std::collections::HashSet<u32>,
            windows: std::collections::HashSet<isize>,
        }
        unsafe extern "system" fn collect(window: isize, param: isize) -> i32 {
            let context = &mut *(param as *mut Context);
            let mut pid = 0;
            GetWindowThreadProcessId(window, &mut pid);
            if context.pids.contains(&pid) && IsWindowVisible(window) != 0 {
                context.windows.insert(window);
            }
            1
        }
        let mut context = Context {
            pids: process_ids()?,
            windows: Default::default(),
        };
        if unsafe { EnumWindows(collect, &mut context as *mut Context as isize) } == 0 {
            return Err(plugin_error("无法确认微信窗口，请检查客户端后重试"));
        }
        Ok(context.windows)
    }

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Snapshot {
        version: u8,
        id: String,
        label: String,
        created_at: u64,
        root: String,
        modern: bool,
        recovery: bool,
        files: Vec<Vec<u8>>,
    }
    impl Drop for Snapshot {
        fn drop(&mut self) {
            for file in &mut self.files {
                file.zeroize();
            }
        }
    }
    impl Snapshot {
        fn info(&self) -> SessionInfo {
            SessionInfo {
                id: self.id.clone(),
                label: self.label.clone(),
                created_at: self.created_at,
                data_path: self.root.clone(),
                recovery: self.recovery,
                family: if self.modern {
                    "微信 4.x"
                } else {
                    "微信 3.x"
                },
            }
        }
        fn names(&self) -> &'static [&'static str] {
            if self.modern {
                NEW_FILES
            } else {
                OLD_FILES
            }
        }
    }
    fn safe_directory(path: &Path) -> PlatformResult<PathBuf> {
        let text = path.to_string_lossy();
        let bytes = text.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'\\' | b'/')
            || text.chars().any(char::is_control)
        {
            return Err(plugin_error("请选择本地微信数据根目录"));
        }
        let resolved = path.canonicalize().map_err(|_| plugin_error(IO_ERROR))?;
        if !resolved.is_dir()
            || !matches!(resolved.components().next(), Some(std::path::Component::Prefix(p)) if matches!(p.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
        {
            return Err(plugin_error("请选择本地微信数据根目录"));
        }
        Ok(resolved)
    }
    // Reject reparse points at every config path component, including junctions.
    fn config_path(root: &Path, relative: &str) -> PlatformResult<PathBuf> {
        let mut target = root.to_path_buf();
        for component in Path::new(relative).components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return Err(plugin_error(FORMAT_ERROR));
            }
            target.push(component);
            let meta = fs::symlink_metadata(&target)
                .map_err(|_| plugin_error("未找到受支持的微信登录配置，请选择数据根目录"))?;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(plugin_error("微信配置目录不能包含链接或重解析点"));
            }
        }
        if !target.is_file() {
            return Err(plugin_error(FORMAT_ERROR));
        }
        Ok(target)
    }
    fn open_configs(root: &Path, names: &[&str], write: bool) -> PlatformResult<Vec<File>> {
        names
            .iter()
            .map(|name| {
                let path = config_path(root, name)?;
                // Allow existing readers that themselves permit writes, but never concurrent writers.
                // All target handles are acquired before any writes; never close WeChat handles.
                let file = OpenOptions::new()
                    .read(true)
                    .write(write)
                    .share_mode(if write { 1 } else { 0 })
                    .open(path)
                    .map_err(|_| plugin_error("微信配置被占用或不可写，请退出微信后重试"))?;
                if file.metadata().map_err(|_| plugin_error(IO_ERROR))?.len() > LIMIT {
                    return Err(plugin_error("微信登录配置超过大小限制"));
                }
                Ok(file)
            })
            .collect()
    }
    fn read_configs(files: &mut [File]) -> PlatformResult<Vec<Vec<u8>>> {
        let mut result = Zeroizing::new(Vec::<Vec<u8>>::new());
        for file in files {
            let mut bytes = Zeroizing::new(Vec::new());
            file.seek(SeekFrom::Start(0))
                .map_err(|_| plugin_error(IO_ERROR))?;
            (&mut *file)
                .take(LIMIT + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| plugin_error(IO_ERROR))?;
            if bytes.is_empty() || bytes.len() as u64 > LIMIT {
                return Err(plugin_error(FORMAT_ERROR));
            }
            result.push(std::mem::take(&mut *bytes));
        }
        Ok(std::mem::take(&mut *result))
    }
    fn store() -> PlatformResult<PathBuf> {
        let root = data_dir()
            .map_err(|_| plugin_error(IO_ERROR))?
            .join("wechat-login-configs");
        fs::create_dir_all(&root).map_err(|_| plugin_error(IO_ERROR))?;
        if fs::symlink_metadata(&root)
            .map_err(|_| plugin_error(IO_ERROR))?
            .file_attributes()
            & 0x400
            != 0
        {
            return Err(plugin_error(IO_ERROR));
        }
        Ok(root)
    }
    fn snapshot(
        root: String,
        modern: bool,
        label: String,
        recovery: bool,
        files: Vec<Vec<u8>>,
    ) -> Snapshot {
        Snapshot {
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            label,
            root,
            modern,
            recovery,
            files,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        }
    }
    fn persist(value: &Snapshot) -> PlatformResult<()> {
        let root = store()?;
        if fs::read_dir(&root)
            .map_err(|_| plugin_error(IO_ERROR))?
            .count()
            >= 200
        {
            return Err(plugin_error("微信配置快照已达上限，请先整理本地快照目录"));
        }
        let plain =
            Zeroizing::new(serde_json::to_string(value).map_err(|_| plugin_error(IO_ERROR))?);
        let encrypted = encrypt_secret(&plain).map_err(|_| plugin_error(IO_ERROR))?;
        let temporary = root.join(format!("{}.tmp", value.id));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| plugin_error(IO_ERROR))?;
        file.write_all(encrypted.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| plugin_error(IO_ERROR))?;
        drop(file);
        fs::rename(temporary, root.join(format!("{}.enc", value.id)))
            .map_err(|_| plugin_error(IO_ERROR))
    }
    fn load_from(root: &Path, id: &str) -> PlatformResult<Snapshot> {
        if !uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
            return Err(plugin_error(FORMAT_ERROR));
        }
        let path = root.join(format!("{id}.enc"));
        let meta = fs::symlink_metadata(&path).map_err(|_| plugin_error(FORMAT_ERROR))?;
        if meta.file_attributes() & 0x400 != 0 || !meta.is_file() || meta.len() > STORE_LIMIT {
            return Err(plugin_error(FORMAT_ERROR));
        }
        let encrypted = fs::read_to_string(path).map_err(|_| plugin_error(FORMAT_ERROR))?;
        let plain =
            Zeroizing::new(decrypt_secret(&encrypted).map_err(|_| plugin_error(FORMAT_ERROR))?);
        let value: Snapshot =
            serde_json::from_str(&plain).map_err(|_| plugin_error(FORMAT_ERROR))?;
        if value.version != 1
            || value.id != id
            || value.files.len() != value.names().len()
            || value
                .files
                .iter()
                .any(|f| f.is_empty() || f.len() as u64 > LIMIT)
        {
            return Err(plugin_error(FORMAT_ERROR));
        }
        Ok(value)
    }
    pub(super) fn list() -> PlatformResult<Vec<SessionInfo>> {
        let root = store()?;
        let mut items = Vec::new();
        for entry in fs::read_dir(&root)
            .map_err(|_| plugin_error(IO_ERROR))?
            .take(201)
        {
            let entry = entry.map_err(|_| plugin_error(IO_ERROR))?;
            if entry.path().extension().is_some_and(|s| s == "enc") {
                let id = entry
                    .path()
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_owned();
                items.push(load_from(&root, &id)?.info());
            }
        }
        items.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(items)
    }

    fn delete_from(root: &Path, id: &str) -> PlatformResult<()> {
        if !uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
            return Err(plugin_error("微信配置标识无效"));
        }
        // Delete only this UUID-named CloudHub snapshot. Never use the saved WeChat data path.
        let file = root.join(format!("{id}.enc"));
        let meta = match fs::symlink_metadata(&file) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(plugin_error("删除微信配置失败，请刷新列表后重试")),
        };
        if !meta.is_file() || meta.file_attributes() & 0x400 != 0 {
            return Err(plugin_error("删除微信配置失败，请刷新列表后重试"));
        }
        match fs::remove_file(file) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(plugin_error("删除微信配置失败，请刷新列表后重试")),
        }
    }

    pub(super) fn delete(id: String) -> PlatformResult<()> {
        let _guard = LAUNCH_LOCK
            .try_lock()
            .map_err(|_| plugin_error("微信启动任务正在执行，请稍后重试"))?;
        delete_from(&store()?, &id)
    }
    fn validate_family(executable: &Path, modern: bool) -> PlatformResult<()> {
        let client_modern = executable
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("Weixin.exe"));
        if client_modern == modern {
            return Ok(());
        }
        Err(plugin_error(if client_modern {
            "当前客户端是微信 4.x，所选配置属于微信 3.x；请重新检测当前版本的数据目录"
        } else {
            "当前客户端是微信 3.x，所选配置属于微信 4.x；请选择对应客户端或数据目录"
        }))
    }

    pub(super) fn capture(
        data_path: String,
        label: String,
        path: String,
    ) -> PlatformResult<SessionInfo> {
        let _guard = LAUNCH_LOCK
            .try_lock()
            .map_err(|_| plugin_error("微信启动任务正在执行，请稍后重试"))?;
        let label = label.trim();
        if label.is_empty() || label.chars().count() > 40 || label.chars().any(char::is_control) {
            return Err(plugin_error("请填写 1～40 字的账号配置名称"));
        }
        let executable = validate_path(&path)?;
        if running_processes()? != 0 {
            return Err(plugin_error("保存配置前请从托盘退出所有微信"));
        }
        let root = safe_directory(Path::new(&data_path))?;
        let modern = config_path(&root, NEW_FILES[0]).is_ok();
        // Reject the incompatible family before reading or persisting login bytes.
        validate_family(&executable, modern)?;
        let mut files = open_configs(&root, if modern { NEW_FILES } else { OLD_FILES }, false)?;
        let value = snapshot(
            data_path,
            modern,
            label.into(),
            false,
            read_configs(&mut files)?,
        );
        persist(&value)?;
        Ok(value.info())
    }
    fn write_bytes(file: &mut File, bytes: &[u8]) -> std::io::Result<()> {
        file.seek(SeekFrom::Start(0))?;
        file.write_all(bytes)?;
        file.set_len(bytes.len() as u64)?;
        file.sync_all()
    }
    fn replace(
        files: &mut [File],
        next: &[Vec<u8>],
        previous: &[Vec<u8>],
        fail_at: Option<usize>,
    ) -> PlatformResult<()> {
        for index in 0..files.len() {
            let result = if fail_at == Some(index) {
                Err(std::io::Error::other("synthetic failure"))
            } else {
                write_bytes(&mut files[index], &next[index])
            };
            if result.is_err() {
                let mut recovered = true;
                for (file, bytes) in files.iter_mut().zip(previous) {
                    recovered &= write_bytes(file, bytes).is_ok();
                }
                return Err(plugin_error(if recovered {
                    "写入微信配置失败，已还原原配置"
                } else {
                    "微信配置写入及回滚失败，请退出微信并恢复备份"
                }));
            }
        }
        Ok(())
    }
    fn validate_quick_interval(interval: Option<u64>) -> PlatformResult<()> {
        if interval.is_some_and(|value| value > 500) {
            return Err(plugin_error("快速启动间隔须为 0～500 毫秒"));
        }
        Ok(())
    }
    pub(super) fn apply(
        id: String,
        executable: Option<String>,
        quick_interval_ms: Option<u64>,
    ) -> PlatformResult<()> {
        validate_quick_interval(quick_interval_ms)?;
        let _guard = LAUNCH_LOCK
            .try_lock()
            .map_err(|_| plugin_error("微信启动任务正在执行，请稍后重试"))?;
        let value = load_from(&store()?, &id)?;
        let executable = executable.map(|path| validate_path(&path)).transpose()?;
        let baseline = if executable.is_some() && quick_interval_ms.is_none() {
            visible_wechat_windows()?
        } else {
            Default::default()
        };
        if let Some(path) = &executable {
            validate_family(path, value.modern)?;
            if value.recovery {
                return Err(plugin_error("客户端与账号配置类型不匹配"));
            }
        } else if !value.recovery || running_processes()? != 0 {
            return Err(plugin_error("恢复备份前请退出所有微信并选择恢复备份"));
        }
        let root = safe_directory(Path::new(&value.root))?;
        let mut files = open_configs(&root, value.names(), true)?;
        let previous = snapshot(
            value.root.clone(),
            value.modern,
            "恢复前备份".into(),
            true,
            read_configs(&mut files)?,
        );
        // Backup must be durable before the original bytes can be changed.
        persist(&previous)?;
        replace(&mut files, &value.files, &previous.files, None)?;
        drop(files);
        if let Some(path) = executable {
            match Command::new(&path)
                .current_dir(path.parent().unwrap())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(mut child) => {
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                }
                Err(_) => {
                    let mut files = open_configs(&root, value.names(), true)?;
                    replace(&mut files, &previous.files, &value.files, None)?;
                    return Err(plugin_error("启动微信失败，已还原启动前配置"));
                }
            }
            // Explicit experimental fast mode: accepted spawn requests are not confirmed windows.
            // Keep the mutex through the short delay; config writes themselves remain sequential.
            if let Some(interval) = quick_interval_ms {
                std::thread::sleep(std::time::Duration::from_millis(interval));
                return Ok(());
            }
            // Do not report a logged-in session: WeChat may merge requests or reject its saved login.
            // Keep the launch lock until a new window appears; avoid switching config during startup.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while std::time::Instant::now() < deadline {
                if visible_wechat_windows()?
                    .iter()
                    .any(|window| !baseline.contains(window))
                {
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
            return Err(plugin_error(
                "已发出启动请求但未确认新窗口，请检查微信后再操作；恢复前备份已保留",
            ));
        }
        Ok(())
    }

    pub(super) fn validate_directory(path: &str) -> PlatformResult<()> {
        let root = safe_directory(Path::new(path))?;
        if config_path(&root, NEW_FILES[0]).is_ok() || config_path(&root, OLD_FILES[0]).is_ok() {
            Ok(())
        } else {
            // A user may choose a new profile folder beside the executable. That is
            // not WeChat's existing login-data root; inspect only known filenames.
            let installation = [Some(root.as_path()), root.parent()]
                .into_iter()
                .flatten()
                .any(|directory| {
                    ["Weixin.exe", "WeChat.exe"]
                        .iter()
                        .any(|name| directory.join(name).is_file())
                });
            Err(plugin_error(if installation {
                "所选位置是微信程序目录，请在微信设置中查看文件存储位置，再选择实际数据目录"
            } else {
                "未找到登录配置，请选择包含 all_users 或 All Users 的微信数据目录；请先登录一次微信"
            }))
        }
    }

    pub(crate) fn matching_data_root(path: &str) -> Option<bool> {
        let root = safe_directory(Path::new(path)).ok()?;
        for (modern, names) in [(true, NEW_FILES), (false, OLD_FILES)] {
            if names.iter().all(|name| {
                config_path(&root, name)
                    .ok()
                    .and_then(|file| fs::metadata(file).ok())
                    .is_some_and(|meta| meta.len() > 0 && meta.len() <= LIMIT)
            }) {
                return Some(modern);
            }
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn quick_intervals_are_bounded_before_file_operations() {
            for interval in [None, Some(0), Some(20), Some(50), Some(500)] {
                assert!(validate_quick_interval(interval).is_ok());
            }
            for interval in [501, 20000, u64::MAX] {
                let error = apply(String::new(), None, Some(interval)).err().unwrap();
                assert_eq!(error.message, "快速启动间隔须为 0～500 毫秒");
            }
        }
        #[test]
        fn restore_can_coexist_with_readers_but_refuses_live_writers() {
            let root =
                std::env::temp_dir().join(format!("cloudhub-sharing-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("all_users/config")).unwrap();
            for name in NEW_FILES {
                fs::write(root.join(name), b"fixture-original").unwrap();
            }
            let reader = OpenOptions::new()
                .read(true)
                .share_mode(3)
                .open(root.join(NEW_FILES[0]))
                .unwrap();
            let restore = open_configs(&root, NEW_FILES, true).unwrap();
            assert!(open_configs(&root, NEW_FILES, true).is_err());
            drop(restore);
            drop(reader);
            let writer = OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(3)
                .open(root.join(NEW_FILES[0]))
                .unwrap();
            assert!(open_configs(&root, NEW_FILES, true).is_err());
            drop(writer);
            assert_eq!(
                fs::read(root.join(NEW_FILES[0])).unwrap(),
                b"fixture-original"
            );
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn deletion_is_confined_to_one_snapshot_and_retries_are_safe() {
            let root =
                std::env::temp_dir().join(format!("cloudhub-delete-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let id = uuid::Uuid::new_v4().to_string();
            let other = uuid::Uuid::new_v4().to_string();
            fs::write(root.join(format!("{id}.enc")), b"fixture").unwrap();
            fs::write(root.join(format!("{other}.enc")), b"fixture").unwrap();
            fs::write(root.join("config.data"), b"fixture-original").unwrap();
            for invalid in [
                "../config.data",
                "..",
                "",
                "C:\\config.data",
                "invalid:stream",
            ] {
                assert!(delete_from(&root, invalid).is_err());
            }
            delete_from(&root, &id).unwrap();
            delete_from(&root, &id).unwrap();
            assert!(!root.join(format!("{id}.enc")).exists());
            assert!(root.join(format!("{other}.enc")).is_file());
            assert_eq!(
                fs::read(root.join("config.data")).unwrap(),
                b"fixture-original"
            );
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn families_are_validated_and_existing_snapshot_metadata_exposes_family_only() {
            assert!(validate_family(Path::new(r"C:\Weixin.exe"), true).is_ok());
            assert!(validate_family(Path::new(r"C:\WeChat.exe"), false).is_ok());
            assert!(validate_family(Path::new(r"C:\Weixin.exe"), false)
                .err()
                .unwrap()
                .message
                .contains("所选配置属于微信 3.x"));
            assert!(validate_family(Path::new(r"C:\WeChat.exe"), true)
                .err()
                .unwrap()
                .message
                .contains("所选配置属于微信 4.x"));
            let old = snapshot(
                "fixture-root".into(),
                false,
                "fixture".into(),
                false,
                vec![b"fixture-data".to_vec()],
            );
            let metadata = serde_json::to_value(old.info()).unwrap();
            assert_eq!(metadata["family"], "微信 3.x");
            assert!(metadata.get("files").is_none());
            assert!(!serde_json::to_string(&metadata)
                .unwrap()
                .contains("fixture-data"));
        }
        #[test]
        fn directory_selection_distinguishes_program_and_existing_data() {
            let root = std::env::temp_dir().join(format!(
                "cloudhub-wechat-selection-{}",
                uuid::Uuid::new_v4()
            ));
            let selected = root.join("wx1");
            fs::create_dir_all(&selected).unwrap();
            fs::write(root.join("Weixin.exe"), b"fixture-not-executable").unwrap();
            let error = validate_directory(selected.to_str().unwrap())
                .err()
                .unwrap();
            assert!(error.message.starts_with("所选位置是微信程序目录"));
            fs::create_dir_all(selected.join("all_users/config")).unwrap();
            fs::write(selected.join(NEW_FILES[0]), b"fixture-config").unwrap();
            assert!(validate_directory(selected.to_str().unwrap()).is_ok());
            let empty = root.join("unconfigured/data");
            fs::create_dir_all(&empty).unwrap();
            let error = validate_directory(empty.to_str().unwrap()).err().unwrap();
            assert!(error.message.contains("请先登录一次微信"));
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn bounded_whitelist_exclusive_handles_and_rollback() {
            let root =
                std::env::temp_dir().join(format!("cloudhub-wechat-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("all_users/config")).unwrap();
            for name in NEW_FILES {
                fs::write(root.join(name), b"fixture-original").unwrap();
            }
            assert!(config_path(&root, "../outside").is_err());
            let mut files = open_configs(&root, NEW_FILES, true).unwrap();
            assert!(open_configs(&root, NEW_FILES, true).is_err());
            let previous = read_configs(&mut files).unwrap();
            let next = vec![b"fixture-next".to_vec(); 2];
            assert!(replace(&mut files, &next, &previous, Some(1)).is_err());
            assert_eq!(read_configs(&mut files).unwrap(), previous);
            replace(&mut files, &next, &previous, None).unwrap();
            assert_eq!(read_configs(&mut files).unwrap(), next);
            drop(files);
            fs::write(root.join(NEW_FILES[0]), vec![0; (LIMIT + 1) as usize]).unwrap();
            assert!(open_configs(&root, NEW_FILES, true).is_err());
            fs::remove_dir_all(root).unwrap();
        }
    }
}

#[tauri::command]
pub(crate) async fn wechat_sessions_delete(id: String) -> PlatformResult<()> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || windows::delete(id))
            .await
            .map_err(|_| plugin_error("删除微信配置任务失败，请重试"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = id;
        Err(plugin_error("微信多开插件仅支持 Windows 桌面端"))
    }
}

#[tauri::command]
pub(crate) async fn wechat_sessions_list() -> PlatformResult<Vec<SessionInfo>> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(windows::list)
            .await
            .map_err(|_| plugin_error("读取微信配置列表失败"))?;
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}
#[tauri::command]
pub(crate) async fn wechat_sessions_select(
    app: tauri::AppHandle,
) -> PlatformResult<Option<String>> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            let Some(file) = app
                .dialog()
                .file()
                .set_title("选择微信数据根目录（xwechat_files 或 WeChat Files）")
                .blocking_pick_folder()
            else {
                return Ok(None);
            };
            let path = file
                .into_path()
                .map_err(|_| plugin_error("请选择本地微信数据根目录"))?;
            let text = path
                .to_str()
                .ok_or_else(|| plugin_error("请选择本地微信数据根目录"))?;
            windows::validate_directory(text)?;
            Ok(Some(text.to_owned()))
        })
        .await
        .map_err(|_| plugin_error("选择微信数据目录失败"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err(plugin_error("微信多开插件仅支持 Windows 桌面端"))
    }
}
#[tauri::command]
pub(crate) async fn wechat_sessions_capture(
    data_path: String,
    label: String,
    path: String,
) -> PlatformResult<SessionInfo> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            windows::capture(data_path, label, path)
        })
        .await
        .map_err(|_| plugin_error("保存微信配置任务失败"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = (data_path, label, path);
        Err(plugin_error("微信多开插件仅支持 Windows 桌面端"))
    }
}
#[tauri::command]
pub(crate) async fn wechat_sessions_launch(
    id: String,
    path: String,
    quick_interval_ms: Option<u64>,
) -> PlatformResult<()> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            windows::apply(id, Some(path), quick_interval_ms)
        })
        .await
        .map_err(|_| plugin_error("启动微信任务失败，请重试"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = (id, path, quick_interval_ms);
        Err(plugin_error("微信多开插件仅支持 Windows 桌面端"))
    }
}
#[tauri::command]
pub(crate) async fn wechat_sessions_restore(id: String) -> PlatformResult<()> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || windows::apply(id, None, None))
            .await
            .map_err(|_| plugin_error("恢复微信配置任务失败"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = id;
        Err(plugin_error("微信多开插件仅支持 Windows 桌面端"))
    }
}
