use serde::Deserialize;

#[derive(serde::Serialize)]
pub struct FolderCreation {
    pub(super) created: Vec<String>,
    pub(super) error: Option<&'static str>,
}

pub(super) fn create_folders(desktop: &std::path::Path, count: u32) -> FolderCreation {
    let mut created = Vec::new();
    for suffix in 1..=10_000 {
        let name = if suffix == 1 { "新建文件夹".into() } else { format!("新建文件夹 ({suffix})") };
        match std::fs::create_dir(desktop.join(&name)) {
            Ok(()) => {
                created.push(name);
                if created.len() == count as usize {
                    return FolderCreation { created, error: None };
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return FolderCreation { created, error: Some("无法在桌面创建文件夹，请检查桌面目录是否可写。") },
        }
    }
    FolderCreation { created, error: Some("桌面没有足够的可用文件夹名称。") }
}

/// Create a blank OOXML workbook using an exclusive new-file handle so existing files are never replaced.
pub(super) fn create_workbook(desktop: &std::path::Path) -> Result<String, String> {
    use std::{fs::OpenOptions, io::Write};
    use zip::{write::SimpleFileOptions, ZipWriter};
    const PARTS: &[(&str, &str)] = &[
        ("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/></Types>"),
        ("_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>"),
        ("xl/workbook.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"),
        ("xl/_rels/workbook.xml.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>"),
        ("xl/worksheets/sheet1.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>"),
    ];
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for suffix in 0..1000u32 {
        let name = if suffix == 0 { "新建工作簿.xlsx".to_string() } else { format!("新建工作簿 ({suffix}).xlsx") };
        let path = desktop.join(&name);
        let file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法在桌面创建 Excel 文件。".into()),
        };
        let result = (|| {
            let mut archive = ZipWriter::new(file);
            for (part, content) in PARTS {
                archive.start_file(*part, options).map_err(|_| "生成 Excel 工作簿失败")?;
                archive.write_all(content.as_bytes()).map_err(|_| "写入 Excel 工作簿失败")?;
            }
            archive.finish().map_err(|_| "完成 Excel 工作簿失败")?;
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        return Ok(name);
    }
    Err("桌面上已有太多同名工作簿，未创建文件。".into())
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ComputerAction { Shutdown, Restart, TaskManager, Lock, Explorer }

impl ComputerAction {
    fn command(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Self::Shutdown => ("shutdown.exe", &["/s", "/t", "0"]),
            Self::Restart => ("shutdown.exe", &["/r", "/t", "0"]),
            Self::TaskManager => ("Taskmgr.exe", &[]),
            Self::Lock => ("rundll32.exe", &["user32.dll,LockWorkStation"]),
            Self::Explorer => ("explorer.exe", &[]),
        }
    }
}

pub fn run(action: ComputerAction) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::{os::windows::process::CommandExt, path::PathBuf, process::{Command, Stdio}};
        let root = PathBuf::from(std::env::var_os("SystemRoot").ok_or("无法找到 Windows 系统目录")?);
        let (name, args) = action.command();
        let executable = if action == ComputerAction::Explorer { root.join(name) } else { root.join("System32").join(name) };
        let mut command = Command::new(executable);
        command.args(args).creation_flags(0x08000000).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        if matches!(action, ComputerAction::TaskManager | ComputerAction::Explorer) {
            let mut child = command.spawn().map_err(|_| "无法打开系统工具")?;
            std::thread::spawn(move || { let _ = child.wait(); });
        } else if !command.status().map_err(|_| "无法执行电脑操作")?.success() {
            return Err("系统未能执行此操作，请检查当前用户权限".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = action; Err("电脑快捷操作目前仅支持 Windows 桌面端".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actions_are_fixed_and_do_not_force_close_applications() {
        for action in [ComputerAction::Shutdown,ComputerAction::Restart,ComputerAction::TaskManager,ComputerAction::Lock,ComputerAction::Explorer] {
            let (program,args)=action.command();
            assert!(program.ends_with(".exe"));
            assert!(!args.contains(&"/f"));
        }
        assert_eq!(ComputerAction::Shutdown.command(),("shutdown.exe", &["/s","/t","0"][..]));
        assert_eq!(ComputerAction::Restart.command(),("shutdown.exe", &["/r","/t","0"][..]));
        assert!(serde_json::from_str::<ComputerAction>("\"cmd.exe\"").is_err());
        assert!(serde_json::from_str::<ComputerAction>("\"shutdown /f\"").is_err());
    }
}
