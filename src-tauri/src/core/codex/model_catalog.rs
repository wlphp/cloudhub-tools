//! 供应商模型目录的模板来源、条目回落与生成版本戳。
//!
//! 目录格式是 Codex 客户端的私有契约，字段随版本增删，且缺一个字段就会整份
//! 文件拒载、模型选择器里所有模型一起消失。早期实现从用户磁盘上已有的目录
//! 里拷贝一条模型作为模板：磁盘上没有目录、或模板来自旧版本客户端时，写出的
//! 目录就会缺新客户端要求的字段。
//!
//! 这里改为内置一份官方目录快照作为模板来源，并用生成器版本戳记录产出，
//! 使「生成逻辑变了但磁盘上仍是旧目录」这件事可被识别和修复。
//!
//! 内置快照取自 CLIProxyAPI（MIT），许可证副本见 `assets/CLIProxyAPI-LICENSE`。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::{Path, PathBuf}, sync::OnceLock};

/// 模型目录生成逻辑的版本号。模板字段、回落策略或落盘结构发生变化时递增，
/// 递增后磁盘上的旧目录会被判定为过期并重建。
pub const GENERATOR_VERSION:u32=1;

/// 与目录同目录的版本戳文件名。
const META_FILE:&str="cloudhub-model-catalog.meta.json";

/// 未知第三方模型统一回落到这条官方模板，再逐项打补丁。
const TEMPLATE_SLUG:&str="gpt-5.6-sol";

const CLIENT_CATALOG:&str=include_str!(concat!(env!("CARGO_MANIFEST_DIR"),"/assets/codex_client_models.json"));

/// 内置官方目录。资产在编译期固定，解析失败属于构建缺陷而不是运行时状态。
fn client_catalog()->&'static Value {
    static CATALOG:OnceLock<Value>=OnceLock::new();
    CATALOG.get_or_init(||{
        serde_json::from_str(CLIENT_CATALOG).expect("内置模型目录资产应为合法 JSON")
    })
}

fn find_entry(slug:&str)->Option<Value> {
    client_catalog()["models"].as_array()?.iter()
        .find(|entry|entry["slug"].as_str().is_some_and(|id|id.eq_ignore_ascii_case(slug)))
        .cloned()
}

/// 全部官方条目声明过的字段名。用于校验生成的条目没有丢掉任何客户端字段。
/// 从资产推导而不是手写清单：清单会随客户端版本漂移，条目全集不会。
/// `model_overrides` 是单个模型的补丁，不构成通用字段集，因此不计入。
fn official_fields()->Vec<String> {
    let mut fields:Vec<String>=client_catalog()["models"].as_array()
        .map(|rows|rows.iter().filter_map(|entry|entry.as_object()).flat_map(|object|object.keys().cloned()).collect())
        .unwrap_or_default();
    fields.sort_unstable();
    fields.dedup();
    fields
}

/// 用其余官方条目补齐指定条目缺失的字段。
///
/// 不同官方条目声明的字段并不一致：内置快照里没有一条是字段齐全的，最完整的
/// 条目也少 `knowledge_cutoff` 与 `max_completion_tokens`。客户端拒收缺字段的
/// 目录，所以无论条目命中与否，都必须先补齐再交给落盘校验。
fn schema_complete(mut entry:Value)->Value {
    let entries=client_catalog()["models"].as_array().cloned().unwrap_or_default();
    if let Some(object)=entry.as_object_mut() {
        for other in entries.iter().filter(|item|item.as_object().is_some()) {
            for (key,value) in other.as_object().expect("已过滤非对象条目") {
                if !object.contains_key(key) {
                    object.insert(key.clone(),value.clone());
                }
            }
        }
    }
    entry
}

/// 字段齐全的通用模板。
fn schema_complete_template()->Value {
    let entries=client_catalog()["models"].as_array().cloned().unwrap_or_default();
    schema_complete(find_entry(TEMPLATE_SLUG).or_else(||entries.first().cloned()).unwrap_or_else(||json!({})))
}

/// 取模型条目的模板。命中官方条目时保留它自己的取值并补齐缺失字段，供应商模型
/// 回落到官方模板并标记为非官方，交由调用方剥离官方模型特有的能力声明。
pub fn template(model_id:&str)->(Value,bool) {
    // 命中官方条目也要补齐：单条官方条目缺少其它条目已经声明的字段是常态，
    // 原样返回会让「应用配置」必然卡在落盘校验上。
    if let Some(entry)=find_entry(model_id) {return(schema_complete(entry),true)}
    (schema_complete_template(),false)
}

/// 把官方条目的能力声明改写为第三方模型的保守取值。
///
/// 原则是「继承 schema，不继承官方模型的身份与调参」：字段全部保留，客户端
/// 才能解析；但多智能体、加速档位、lite 协议这些官方模型专属能力必须清空，
/// 否则等于向客户端声明供应商并不具备的行为。
pub fn strip_official_capabilities(entry:&mut Value) {
    let Some(object)=entry.as_object_mut() else {return};
    object.insert("multi_agent_version".into(),Value::Null);
    object.insert("tool_mode".into(),Value::Null);
    object.insert("use_responses_lite".into(),Value::Bool(false));
    object.insert("model_specialty".into(),Value::Null);
    object.insert("auto_review_model_override".into(),Value::Null);
    object.insert("additional_speed_tiers".into(),json!([]));
    object.insert("service_tiers".into(),json!([]));
    object.insert("default_service_tier".into(),Value::Null);
    object.insert("availability_nux".into(),Value::Null);
    object.insert("upgrade".into(),Value::Null);
    // 沿用较宽松的下限，避免旧客户端因为版本门槛直接隐藏供应商模型。
    object.insert("minimal_client_version".into(),json!("0.124.0"));
    object.insert("supported_in_api".into(),Value::Bool(true));
    object.insert("visibility".into(),json!("list"));
}

/// 以内置默认值为底、覆盖层为顶层键合并。覆盖层缺少的键保留默认值，
/// 因此过期的外部模板不会把新客户端要求的字段一并带走。
pub fn merge_defaults(fallback:&Value,overlay:&Value)->Value {
    let mut merged=fallback.clone();
    if let (Some(merged),Some(overlay))=(merged.as_object_mut(),overlay.as_object()) {
        for (key,value) in overlay {
            merged.insert(key.clone(),value.clone());
        }
    }
    merged
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct CatalogMeta { generator:u32, #[serde(rename="appVersion")] app_version:String, #[serde(rename="catalogHash")] catalog_hash:String, #[serde(rename="writtenAt")] written_at:i64 }

fn meta_path(catalog:&Path)->PathBuf {catalog.with_file_name(META_FILE)}

fn digest(content:&str)->String {
    format!("{:x}",Sha256::digest(content.as_bytes()))
}

/// 目录落盘成功后写版本戳。版本戳只用于判断产出是否陈旧，写失败不牵连目录本身。
pub fn write_meta(catalog:&Path,content:&str) {
    let meta=CatalogMeta{
        generator:GENERATOR_VERSION,
        app_version:env!("CARGO_PKG_VERSION").to_string(),
        catalog_hash:digest(content),
        written_at:chrono::Utc::now().timestamp_millis()
    };
    if let Ok(text)=serde_json::to_string_pretty(&meta) {
        let _=super::profile::write_private(&meta_path(catalog),&text);
    }
}

/// 目录由旧版生成器产出时返回 true。版本戳缺失也算陈旧：无法证明它包含当前
/// 生成逻辑所要求的字段，就按需要重建处理。
pub fn needs_rebuild(catalog:&Path)->bool {
    if !catalog.exists() {return false}
    let (Ok(content),Ok(text))=(fs::read_to_string(catalog),fs::read_to_string(meta_path(catalog))) else {return true};
    match serde_json::from_str::<CatalogMeta>(text.as_str()) {
        // 内容被外部改过也算陈旧，避免把手工调整当成自己的产出继续沿用。
        Ok(meta)=>meta.generator!=GENERATOR_VERSION||meta.catalog_hash!=digest(content.as_str()),
        Err(_)=>true
    }
}

/// 落盘前的结构校验。宁可让「应用配置」当场失败，也不要写出一份客户端读不了
/// 的目录却在界面上报告成功——那正是本模块要消除的失败方式。
pub fn validate(catalog:&Value)->Result<(),String> {
    let models=catalog["models"].as_array().filter(|rows|!rows.is_empty())
        .ok_or("生成的模型目录缺少模型条目")?;
    let required=official_fields();
    for entry in models {
        entry["slug"].as_str().filter(|slug|!slug.trim().is_empty())
            .ok_or("生成的模型目录存在缺少标识的条目")?;
        for field in required.iter() {
            if !entry.as_object().is_some_and(|object|object.contains_key(field)) {
                return Err(format!("生成的模型目录条目缺少客户端字段 {field}"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry_of(slug:&str)->Value {
        let (mut entry,official)=template(slug);
        if !official {strip_official_capabilities(&mut entry)}
        entry
    }

    #[test]
    fn official_slugs_keep_their_own_entry_and_unknown_models_fall_back() {
        assert!(template("gpt-5.6-sol").1);
        assert!(!template("deepseek-v4-pro").1);
        assert_eq!(template("deepseek-v4-pro").0["slug"],json!("gpt-5.6-sol"));
    }

    /// 这条用例锁住本次故障的成因：生成条目必须覆盖官方条目的全部字段，
    /// 任何一个字段缺失都会让客户端拒绝加载整份目录。
    #[test]
    fn provider_entries_keep_every_field_of_the_official_template() {
        let entry=entry_of("deepseek-v4-pro").as_object().cloned().expect("条目应为对象");
        for field in official_fields() {
            assert!(entry.contains_key(&field),"供应商条目缺少官方字段 {field}");
        }
    }

    #[test]
    fn official_only_capabilities_are_not_inherited_by_provider_models() {
        let entry=entry_of("deepseek-v4-pro");
        assert!(entry["multi_agent_version"].is_null());
        assert!(entry["tool_mode"].is_null());
        assert_eq!(entry["use_responses_lite"],json!(false));
        assert_eq!(entry["service_tiers"],json!([]));
    }

    #[test]
    fn merging_an_older_overlay_never_drops_bundled_fields() {
        let base=json!({"truncation_policy":{"limit":10000},"shell_type":"shell_command"});
        let merged=merge_defaults(&base,&json!({"shell_type":"custom","legacy":1}));
        assert_eq!(merged["truncation_policy"],json!({"limit":10000}));
        assert_eq!(merged["shell_type"],json!("custom"));
        assert_eq!(merged["legacy"],json!(1));
    }

    #[test]
    fn validation_rejects_an_entry_missing_a_client_field() {
        let mut entry=entry_of("deepseek-v4-pro");
        entry.as_object_mut().map(|object|object.remove("truncation_policy"));
        let catalog=json!({"models":[entry]});
        assert!(validate(&catalog).unwrap_err().contains("truncation_policy"));
    }

    #[test]
    fn meta_stamp_detects_stale_and_hand_edited_catalogs() {
        let dir=std::env::temp_dir().join(format!("cloudhub-catalog-meta-{}",std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let catalog=dir.join("cloudhub-model-catalog.json");
        assert!(!needs_rebuild(&catalog));
        std::fs::write(&catalog,"{\"models\":[]}").unwrap();
        assert!(needs_rebuild(&catalog));
        write_meta(&catalog,"{\"models\":[]}");
        assert!(!needs_rebuild(&catalog));
        std::fs::write(&catalog,"{\"models\":[1]}").unwrap();
        assert!(needs_rebuild(&catalog));
        let _=std::fs::remove_dir_all(&dir);
    }
}
