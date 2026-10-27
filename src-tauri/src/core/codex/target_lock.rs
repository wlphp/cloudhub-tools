//! An OS lock shared by development and release builds, independent of vault keys.
use std::{fs::{self, File, OpenOptions}, path::{Path, PathBuf}};

pub fn canonical_home(home: &Path) -> Result<String, String> {
    if !home.is_absolute() || home.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err("Codex 备份目标目录无效".into());
    }
    let mut parent = home;
    let mut missing = Vec::new();
    while !parent.exists() {
        missing.push(parent.file_name().ok_or("Codex 备份目标目录无效")?.to_owned());
        parent = parent.parent().ok_or("Codex 备份目标目录无效")?;
    }
    let mut resolved = fs::canonicalize(parent).map_err(|_| "无法确认 Codex 备份目标目录")?;
    for part in missing.into_iter().rev() { resolved.push(part); }
    let result = resolved.to_string_lossy().into_owned();
    #[cfg(windows)]
    let result = result.to_lowercase();
    Ok(result)
}

pub struct TargetLock { _file: File }
impl TargetLock {
    pub fn acquire(home: &Path) -> Result<Self, String> {
        let key = super::profile::fingerprint(Some(&canonical_home(home)?));
        let root: PathBuf = std::env::temp_dir().join("cloudhub-codex-write-locks");
        fs::create_dir_all(&root).map_err(|_| "创建 Codex 目标锁失败")?;
        if fs::symlink_metadata(&root).map_err(|_| "读取 Codex 目标锁失败")?.file_type().is_symlink() {
            return Err("Codex 目标锁目录不能是链接".into());
        }
        let path = root.join(format!("{key}.lock"));
        if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
            return Err("Codex 目标锁文件无效".into());
        }
        let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path)
            .map_err(|_| "打开 Codex 目标锁失败")?;
        file.try_lock().map_err(|_| "此 Codex 目录正在被另一端操作，请稍后刷新重试")?;
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locks_aliases_and_releases_with_handle() {
        let home = std::env::temp_dir().join(format!("codex-lock-{}", uuid::Uuid::new_v4()));
        let first = TargetLock::acquire(&home).unwrap();
        assert!(TargetLock::acquire(&home.join(".")).is_err());
        assert!(TargetLock::acquire(&home.with_extension("other")).is_ok());
        drop(first);
        assert!(TargetLock::acquire(&home).is_ok());
    }
}
