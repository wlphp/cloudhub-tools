//! Read-only discovery: path hints and directory metadata only. No login/chat file content.
use super::wechat_plugin::plugin_error;
use crate::core::error::PlatformResult;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataCandidate {
    path: String,
    family: &'static str,
    source: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataDetection {
    candidates: Vec<DataCandidate>,
    limited: bool,
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::commands::wechat_sessions::windows::matching_data_root;
    use std::{
        collections::{HashSet, VecDeque},
        fs,
        io::Read,
        os::windows::fs::MetadataExt,
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };
    const ENTRY_LIMIT: usize = 120000;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut std::ffi::c_void,
            size: *mut u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDriveTypeW(root: *const u16) -> u32;
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            input: *const u8,
            input_len: i32,
            output: *mut u16,
            output_len: i32,
        ) -> i32;
    }
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }
    fn registry_hint(product: &str) -> Option<PathBuf> {
        let mut buffer = vec![0u16; 4096];
        let mut size = (buffer.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(
                0x80000001u32 as i32 as isize,
                wide(&format!("Software\\Tencent\\{product}")).as_ptr(),
                wide("FileSavePath").as_ptr(),
                0x6,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != 0 || size < 2 || size as usize > buffer.len() * 2 {
            return None;
        }
        buffer.truncate(size as usize / 2);
        while buffer.last() == Some(&0) {
            buffer.pop();
        }
        Some(PathBuf::from(String::from_utf16(&buffer).ok()?))
    }
    fn parse_path_hint(text: &str, documents: Option<&Path>) -> Option<PathBuf> {
        let text = text
            .trim_matches(|c: char| c == '\u{feff}' || c == '\0' || c.is_whitespace())
            .trim_matches('"');
        let text = match text.split_once(':') {
            Some((key, value)) if key.trim().eq_ignore_ascii_case("MyDocument") => {
                let value = value.trim();
                if value.is_empty() {
                    return documents.map(Path::to_path_buf);
                }
                value
            }
            _ => text,
        };
        let bytes = text.as_bytes();
        if bytes.len() < 3
            || text.len() > 4096
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'\\' | b'/')
            || text.chars().any(char::is_control)
        {
            return None;
        }
        Some(PathBuf::from(text))
    }
    // Only dedicated path-setting ini files are read; never login snapshots or chat databases.
    fn legacy_path_hint(file: &Path, documents: Option<&Path>) -> Option<PathBuf> {
        let meta = fs::symlink_metadata(file).ok()?;
        if !meta.is_file() || meta.len() > 8192 || meta.file_attributes() & 0x400 != 0 {
            return None;
        }
        let mut bytes = Vec::new();
        fs::File::open(file)
            .ok()?
            .take(8193)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > 8192 {
            return None;
        }
        let text = if bytes.starts_with(&[0xff, 0xfe])
            || bytes
                .iter()
                .skip(1)
                .step_by(2)
                .take(3)
                .filter(|&&byte| byte == 0)
                .count()
                >= 2
        {
            if bytes.len() % 2 != 0 {
                return None;
            }
            String::from_utf16(
                &bytes[if bytes.starts_with(&[0xff, 0xfe]) {
                    2
                } else {
                    0
                }..]
                    .chunks_exact(2)
                    .map(|p| u16::from_le_bytes([p[0], p[1]]))
                    .collect::<Vec<_>>(),
            )
            .ok()?
        } else {
            match std::str::from_utf8(&bytes) {
                Ok(text) => text.to_owned(),
                Err(_) => {
                    let mut decoded = vec![0u16; bytes.len()];
                    let length = unsafe {
                        MultiByteToWideChar(
                            0,
                            0,
                            bytes.as_ptr(),
                            bytes.len() as i32,
                            decoded.as_mut_ptr(),
                            decoded.len() as i32,
                        )
                    };
                    if length <= 0 {
                        return None;
                    }
                    String::from_utf16(&decoded[..length as usize]).ok()?
                }
            }
        };
        parse_path_hint(&text, documents)
    }
    fn modern_path_hints(
        seeds: &mut Vec<(PathBuf, String, usize)>,
        roaming: &Path,
        documents: Option<&Path>,
    ) {
        let config = roaming.join("Tencent/xwechat/config");
        if !ordinary_directory(&config) {
            return;
        }
        let Ok(entries) = fs::read_dir(config) else {
            return;
        };
        for entry in entries.take(256).flatten() {
            let path = entry.path();
            let stem = path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if stem.len() != 32
                || !stem.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("ini"))
            {
                continue;
            }
            if let Some(root) = legacy_path_hint(&path, documents) {
                add_locations(seeds, root, "微信 4.x 路径设置");
            }
        }
    }
    fn add_locations(seeds: &mut Vec<(PathBuf, String, usize)>, root: PathBuf, source: &str) {
        seeds.push((root.clone(), source.into(), 0));
        for suffix in [
            "xwechat_files",
            "WeChat Files",
            "Tencent/xwechat_files",
            "Tencent/WeChat Files",
        ] {
            seeds.push((root.join(suffix), source.into(), 0));
        }
    }
    fn ordinary_directory(path: &Path) -> bool {
        fs::symlink_metadata(path)
            .is_ok_and(|meta| meta.is_dir() && meta.file_attributes() & 0x400 == 0)
    }
    pub(super) fn scan(
        seeds: Vec<(PathBuf, String, usize)>,
        entry_limit: usize,
        budget: Duration,
    ) -> DataDetection {
        let mut queue: VecDeque<_> = seeds.into();
        let mut visited = HashSet::new();
        let mut found = HashSet::new();
        let mut candidates = Vec::new();
        let mut entries = 0;
        let started = Instant::now();
        while let Some((path, source, depth)) = queue.pop_front() {
            if entries >= entry_limit || started.elapsed() >= budget || candidates.len() >= 32 {
                return DataDetection {
                    candidates,
                    limited: true,
                };
            }
            entries += 1;
            let text = path.to_string_lossy().to_string();
            // Do not query UNC paths or follow junctions, including redirected OneDrive trees.
            let bytes = text.as_bytes();
            if bytes.len() < 3
                || !bytes[0].is_ascii_alphabetic()
                || bytes[1] != b':'
                || !matches!(bytes[2], b'\\' | b'/')
            {
                continue;
            }
            if !ordinary_directory(&path) {
                continue;
            }
            let Ok(canonical) = path.canonicalize() else {
                continue;
            };
            // Track remaining depth so an exact hint cannot suppress a later explicit search.
            let key = canonical.to_string_lossy().to_lowercase();
            if !visited.insert((key.clone(), depth)) {
                continue;
            }
            if let Some(modern) = matching_data_root(&text) {
                if found.insert(key) {
                    candidates.push(DataCandidate {
                        path: text,
                        family: if modern { "微信 4.x" } else { "微信 3.x" },
                        source,
                    });
                }
                continue; // Never descend into account/chat folders after finding the root.
            }
            if depth == 0 {
                continue;
            }
            let Ok(children) = fs::read_dir(&path) else {
                continue;
            };
            for child in children {
                entries += 1;
                if entries >= entry_limit
                    || started.elapsed() >= budget
                    || queue.len() >= entry_limit
                {
                    return DataDetection {
                        candidates,
                        limited: true,
                    };
                }
                let Ok(child) = child else {
                    continue;
                };
                let name = child.file_name().to_string_lossy().to_lowercase();
                if [
                    "windows",
                    "program files",
                    "program files (x86)",
                    "programdata",
                    "$recycle.bin",
                    "system volume information",
                    ".git",
                    "node_modules",
                    "appdata",
                ]
                .contains(&name.as_str())
                {
                    continue;
                }
                if child.file_type().is_ok_and(|kind| kind.is_dir())
                    && ordinary_directory(&child.path())
                {
                    let next = (child.path(), source.clone(), depth - 1);
                    if ["wechat", "weixin", "微信", "tencent"]
                        .iter()
                        .any(|hint| name.contains(hint))
                    {
                        queue.push_front(next);
                    } else {
                        queue.push_back(next);
                    }
                }
            }
        }
        DataDetection {
            candidates,
            limited: false,
        }
    }
    pub(super) fn detect(search: Option<PathBuf>) -> DataDetection {
        if let Some(root) = search {
            return scan(
                vec![(root, "所选位置查找".into(), 6)],
                ENTRY_LIMIT,
                Duration::from_secs(8),
            );
        }
        let mut seeds = Vec::new();
        let documents = dirs::document_dir();
        for product in ["Weixin", "WeChat"] {
            if let Some(path) = registry_hint(product) {
                add_locations(&mut seeds, path, "微信保存的位置");
            }
        }
        if let Some(roaming) = dirs::config_dir() {
            modern_path_hints(&mut seeds, &roaming, documents.as_deref());
            if let Some(path) = legacy_path_hint(
                &roaming.join("Tencent/WeChat/All Users/config/3ebffe94.ini"),
                documents.as_deref(),
            ) {
                add_locations(&mut seeds, path, "微信路径设置");
            }
        }
        if let Some(path) = documents {
            add_locations(&mut seeds, path, "文档目录");
        }
        if let Some(home) = dirs::home_dir() {
            add_locations(&mut seeds, home.clone(), "用户目录");
            add_locations(&mut seeds, home.join("Documents"), "用户文档目录");
            add_locations(
                &mut seeds,
                home.join("OneDrive/Documents"),
                "OneDrive 文档目录",
            );
        }
        let mut roots = Vec::new();
        for letter in b'C'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if unsafe { GetDriveTypeW(wide(&root).as_ptr()) } == 3 {
                add_locations(&mut seeds, PathBuf::from(&root), "本地磁盘常见位置");
                roots.push((PathBuf::from(root), "本地磁盘浅层查找".into(), 3));
            }
        }
        // Evaluate all exact hints before bounded shallow directory traversal.
        seeds.extend(roots);
        scan(seeds, ENTRY_LIMIT, Duration::from_secs(8))
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        #[ignore = "只读检查本机目录及路径设置，输出匹配目录，不读取登录或聊天文件内容"]
        fn detect_local_data_paths_readonly() {
            let result = detect(std::env::var_os("CLOUDHUB_WECHAT_SEARCH_ROOT").map(PathBuf::from));
            println!("{}", serde_json::to_string(&result).unwrap());
        }
        #[test]
        fn discovers_custom_nested_roots_deduplicates_and_respects_budget() {
            let root =
                std::env::temp_dir().join(format!("cloudhub-detect-{}", uuid::Uuid::new_v4()));
            let data = root.join("custom/location/xwechat_files");
            fs::create_dir_all(data.join("all_users/config")).unwrap();
            fs::create_dir_all(root.join("not-a-data-folder")).unwrap();
            for name in ["global_config", "global_config.crc"] {
                fs::write(data.join("all_users/config").join(name), b"fixture").unwrap();
            }
            let result = scan(
                vec![
                    (data.clone(), "hint".into(), 0),
                    (root.clone(), "search".into(), 6),
                ],
                500,
                Duration::from_secs(2),
            );
            assert_eq!(result.candidates.len(), 1);
            assert!(!result.limited);
            assert_eq!(result.candidates[0].family, "微信 4.x");
            assert!(
                scan(
                    vec![(root.clone(), "limited".into(), 6)],
                    1,
                    Duration::from_secs(2)
                )
                .limited
            );
            let hint = root.join("path.ini");
            fs::write(&hint, b"MyDocument:").unwrap();
            assert_eq!(legacy_path_hint(&hint, Some(&root)).unwrap(), root);
            fs::write(&hint, vec![0; 8193]).unwrap();
            assert!(legacy_path_hint(&hint, None).is_none());
            fs::remove_dir_all(root).unwrap();
        }
        #[test]
        fn modern_path_settings_find_non_documents_data_and_ignore_unrelated_ini() {
            let root =
                std::env::temp_dir().join(format!("cloudhub-modern-hint-{}", uuid::Uuid::new_v4()));
            let roaming = root.join("Roaming");
            let config = roaming.join("Tencent/xwechat/config");
            let data_parent = root.join("同步目录");
            fs::create_dir_all(&config).unwrap();
            fs::create_dir_all(data_parent.join("xwechat_files/all_users/config")).unwrap();
            for name in ["global_config", "global_config.crc"] {
                fs::write(
                    data_parent
                        .join("xwechat_files/all_users/config")
                        .join(name),
                    b"fixture",
                )
                .unwrap();
            }
            let setting = config.join("0123456789abcdef0123456789abcdef.ini");
            fs::write(&setting, data_parent.to_string_lossy().as_bytes()).unwrap();
            fs::write(
                config.join("unrelated.ini"),
                root.to_string_lossy().as_bytes(),
            )
            .unwrap();
            let mut seeds = Vec::new();
            modern_path_hints(&mut seeds, &roaming, None);
            let result = scan(seeds, 100, Duration::from_secs(2));
            assert_eq!(result.candidates.len(), 1);
            assert_eq!(result.candidates[0].family, "微信 4.x");
            assert_eq!(result.candidates[0].source, "微信 4.x 路径设置");
            assert!(parse_path_hint("MyDocument:", Some(&root)).is_some());
            assert_eq!(
                parse_path_hint(&format!("MyDocument:{}", data_parent.display()), None).unwrap(),
                data_parent
            );
            for text in [
                "token=value",
                "\\\\server\\share",
                "C:relative",
                "C:\\data\nother=value",
            ] {
                assert!(parse_path_hint(text, None).is_none());
            }
            let utf16: Vec<u8> = data_parent
                .to_string_lossy()
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
            fs::write(&setting, utf16).unwrap();
            assert_eq!(legacy_path_hint(&setting, None).unwrap(), data_parent);
            fs::remove_dir_all(root).unwrap();
        }
    }
}

#[tauri::command]
pub(crate) async fn wechat_sessions_detect(
    app: tauri::AppHandle,
    browse: bool,
) -> PlatformResult<Option<DataDetection>> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            let search = if browse {
                use tauri_plugin_dialog::DialogExt;
                let Some(folder) = app
                    .dialog()
                    .file()
                    .set_title("选择查找范围，例如 D 盘或存放微信文件的文件夹")
                    .blocking_pick_folder()
                else {
                    return Ok(None);
                };
                Some(
                    folder
                        .into_path()
                        .map_err(|_| plugin_error("请选择本地微信数据根目录"))?,
                )
            } else {
                None
            };
            Ok(Some(windows::detect(search)))
        })
        .await
        .map_err(|_| plugin_error("检测微信数据目录失败，请重试"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = (app, browse);
        Err(plugin_error("微信多开插件仅支持 Windows 桌面端"))
    }
}
