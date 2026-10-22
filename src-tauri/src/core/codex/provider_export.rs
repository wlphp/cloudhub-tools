//! 明文导出供应商配置。用户显式选择导出后生成，文件内容不含本机凭据库。
use super::providers;
use rusqlite::Connection;
use serde_json::{json, Value};

/// 导出格式标识，导入端据此识别本应用导出的文件。
pub const FORMAT:&str="cloudhub-providers";

/// 生成明文 JSON。选择为空时导出全部供应商。返回值在使用后立即清零。
pub fn export(conn:&Connection,ids:Option<&[String]>)->Result<zeroize::Zeroizing<String>,String> {
    let all=providers::list(conn)?;
    let selected=match ids {
        Some(list) if !list.is_empty()=>all.into_iter().filter(|value|list.contains(&value.id)).collect::<Vec<_>>(),
        _=>all,
    };
    if selected.is_empty() {return Err("没有可导出的供应商".into());}
    let mut rows=Vec::new();
    for provider in selected {
        let mut keys=Vec::new();
        for key in &provider.keys {
            let secret=providers::credential(conn,&provider.id,&key.id)?;
            keys.push(json!({"name":key.name,"secret":secret.as_str(),"settings":key.settings}));
        }
        rows.push(json!({
            "name":provider.name,"baseUrl":provider.base_url,"wireApi":provider.wire_api,
            "models":provider.models,"note":provider.note,"settings":provider.settings,"keys":keys
        }));
    }
    serde_json::to_string_pretty(&json!({
        "format":FORMAT,"version":1,
        "exportedAt":chrono::Utc::now().to_rfc3339(),
        "warning":"文件包含明文 API Key，请妥善保管。",
        "providers":rows
    })).map(zeroize::Zeroizing::new).map_err(|_| "导出供应商配置失败".into())
}

/// 导入端读取导出文件里的供应商数组。
pub fn providers_of(root:&Value)->Option<&Vec<Value>> {
    if root.get("format").and_then(Value::as_str)==Some(FORMAT) {root.get("providers").and_then(Value::as_array)} else {None}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exported_documents_are_recognized_by_the_importer() {
        let root=json!({"format":FORMAT,"version":1,"providers":[{"name":"A"}]});
        assert_eq!(providers_of(&root).map(|rows|rows.len()),Some(1));
        assert!(providers_of(&json!([{"name":"A"}])).is_none());
    }
}
