use std::{fs::File, io::{Cursor, Read}};
use zeroize::Zeroizing;

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 24_000;

pub struct ChatDocument {
    pub name: String,
    pub text: String,
}

fn xml_unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
        .replace("&apos;", "'").replace("&amp;", "&")
}

fn tag_values(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut values = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let Some(end_open) = rest[start..].find('>') else { break };
        let body = &rest[start + end_open + 1..];
        let Some(end) = body.find(&close) else { break };
        values.push(xml_unescape(&body[..end]));
        rest = &body[end + close.len()..];
    }
    values
}

fn xlsx_text(bytes: &[u8]) -> Result<String, String> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|_| "XLSX 文件结构无效")?;
    if archive.len() > 512 { return Err("工作簿包含过多内部文件，无法安全读取".into()); }
    let shared = if let Ok(entry) = archive.by_name("xl/sharedStrings.xml") {
        if entry.size() > 2 * 1024 * 1024 { return Err("Excel 共享文本超出读取上限".into()); }
        let mut xml = String::new();
        entry.take(2 * 1024 * 1024 + 1).read_to_string(&mut xml).map_err(|_| "Excel 共享文本编码无效")?;
        if xml.len() > 2 * 1024 * 1024 { return Err("Excel 共享文本超出读取上限".into()); }
        let items = xml.split("<si>").skip(1).filter_map(|part| part.split_once("</si>").map(|(item, _)| {
            tag_values(item, "t").join("")
        })).collect::<Vec<_>>();
        items
    } else { Vec::new() };

    let mut sheet_names = archive.file_names().filter(|name| name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
        .map(str::to_string).collect::<Vec<_>>();
    sheet_names.sort();
    if sheet_names.is_empty() { return Err("工作簿中没有可读取的工作表".into()); }
    let mut output = String::new();
    let mut total_xml = 0usize;
    for (sheet_index, sheet_name) in sheet_names.iter().enumerate() {
        let entry = archive.by_name(sheet_name).map_err(|_| "无法读取 Excel 工作表")?;
        if entry.size() > 4 * 1024 * 1024 { return Err("Excel 工作表超出读取上限".into()); }
        let mut xml = String::new();
        entry.take(4 * 1024 * 1024 + 1).read_to_string(&mut xml).map_err(|_| "Excel 工作表编码无效")?;
        if xml.len() > 4 * 1024 * 1024 { return Err("Excel 工作表超出读取上限".into()); }
        total_xml = total_xml.saturating_add(xml.len());
        if total_xml > 8 * 1024 * 1024 { return Err("工作簿解压内容超出读取上限".into()); }
        if sheet_index > 0 { output.push_str("\n[下一工作表]\n"); }
        let mut rest = xml.as_str();
        while let Some(start) = rest.find("<row") {
            let Some(row_open_end) = rest[start..].find('>') else { break };
            let row_body = &rest[start + row_open_end + 1..];
            let Some(row_end) = row_body.find("</row>") else { break };
            let mut cells = Vec::new();
            let mut row_rest = &row_body[..row_end];
            while let Some(cell_start) = row_rest.find("<c") {
                let Some(cell_open_end) = row_rest[cell_start..].find('>') else { break };
                let cell_tag = &row_rest[cell_start..cell_start + cell_open_end + 1];
                let cell_body = &row_rest[cell_start + cell_open_end + 1..];
                let Some(cell_end) = cell_body.find("</c>") else { break };
                let value_body = &cell_body[..cell_end];
                let value = if cell_tag.contains("t=\"s\"") {
                    tag_values(value_body, "v").first().and_then(|index| index.parse::<usize>().ok())
                        .and_then(|index| shared.get(index)).cloned().unwrap_or_default()
                } else if cell_tag.contains("t=\"inlineStr\"") {
                    tag_values(value_body, "t").join("")
                } else {
                    tag_values(value_body, "v").first().cloned().unwrap_or_default()
                };
                cells.push(value.replace(['\r', '\n', '\t'], " "));
                row_rest = &cell_body[cell_end + 4..];
            }
            if !cells.is_empty() {
                output.push_str(&cells.join("\t"));
                output.push('\n');
                if output.chars().count() > MAX_TEXT_CHARS { return Err("Excel 提取内容过长，请先筛选或拆分工作表".into()); }
            }
            rest = &row_body[row_end + 6..];
        }
    }
    if output.trim().is_empty() { return Err("Excel 工作簿没有可读取的单元格内容".into()); }
    Ok(output)
}

fn office_xml_text(bytes: &[u8], kind: &str) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Office 文档结构无效")?;
    if archive.len() > 512 { return Err("Office 文档包含过多内部文件，无法安全读取".into()); }
    let mut xml_files = archive.file_names()
        .filter(|name| match kind {
            "docx" => *name == "word/document.xml",
            "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
            _ => false,
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    if kind == "pptx" {
        xml_files.sort_by_key(|name| name.trim_start_matches("ppt/slides/slide").trim_end_matches(".xml").parse::<u32>().unwrap_or(u32::MAX));
    }
    if xml_files.is_empty() { return Err("Office 文档中没有可读取的正文".into()); }
    let mut text = String::new();
    let mut total_xml = 0usize;
    for file_name in xml_files {
        let entry = archive.by_name(&file_name).map_err(|_| "无法读取 Office 文档正文")?;
        if entry.size() > 4 * 1024 * 1024 { return Err("Office 文档正文超出读取上限".into()); }
        let mut xml = String::new();
        entry.take(4 * 1024 * 1024 + 1).read_to_string(&mut xml).map_err(|_| "Office 文档正文编码无效")?;
        if xml.len() > 4 * 1024 * 1024 { return Err("Office 文档正文超出读取上限".into()); }
        total_xml = total_xml.saturating_add(xml.len());
        if total_xml > 8 * 1024 * 1024 { return Err("Office 文档解压内容超出读取上限".into()); }
        let tag = if kind == "docx" { "w:t" } else { "a:t" };
        for value in tag_values(&xml, tag) {
            if !text.is_empty() { text.push(' '); }
            text.push_str(&value);
            if text.chars().count() > MAX_TEXT_CHARS { return Err("Office 文档正文超过 24,000 字符，请拆分后再拖入".into()); }
        }
        text.push('\n');
    }
    if text.trim().is_empty() { return Err("Office 文档正文为空或无法提取".into()); }
    Ok(text)
}

pub fn read_chat_document(source_path: &str) -> Result<ChatDocument, String> {
    let path = std::path::Path::new(source_path);
    if !path.is_absolute() { return Err("请拖入本机文件".into()); }
    let name = path.file_name().and_then(|value| value.to_str()).filter(|value| !value.is_empty() && value.chars().count() <= 180)
        .ok_or("文件名无效")?.to_string();
    let file = File::open(path).map_err(|_| "无法读取附件文件")?;
    let metadata = file.metadata().map_err(|_| "无法读取附件信息")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FILE_BYTES {
        return Err("附件必须是非空文件，且不能超过 5 MiB".into());
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "读取附件失败")?;
    read_chat_document_bytes(&name, bytes)
}

pub fn read_chat_document_bytes(name: &str, bytes: Zeroizing<Vec<u8>>) -> Result<ChatDocument, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 180 || name.chars().any(char::is_control) || name.contains('/') || name.contains('\\') {
        return Err("文件名无效".into());
    }
    if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES as usize { return Err("附件必须是非空文件，且不能超过 5 MiB".into()); }
    let name = name.to_string();
    let extension = std::path::Path::new(&name).extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    let text = match extension.as_str() {
        "xlsx" => xlsx_text(&bytes)?,
        "docx" => office_xml_text(&bytes, "docx")?,
        "pptx" => office_xml_text(&bytes, "pptx")?,
        "txt" | "md" | "csv" | "tsv" | "json" | "log" | "xml" | "html" | "yaml" | "yml" | "toml" => {
            String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').to_string()
        }
        _ => format!(
            "此文件已附加，但当前版本无法提取该格式的正文。模型收到的是文件名、扩展名和大小信息，不包含文件实际内容。若需要分析正文，请将文件另存为 TXT、CSV、Markdown、DOCX、PPTX 或 XLSX 后重新拖入。\n文件类型：{}\n文件大小：{} 字节",
            if extension.is_empty() { "未知" } else { extension.as_str() }, bytes.len()
        ),
    };
    if text.trim().is_empty() || text.chars().count() > MAX_TEXT_CHARS { return Err("附件内容为空或超过 24,000 字符".into()); }
    let preview = crate::core::ai::preview(&text)?;
    if preview.removed_lines > 0 { return Err("附件疑似包含密钥或凭据，请清理后再发送。".into()); }
    Ok(ChatDocument { name, text })
}
