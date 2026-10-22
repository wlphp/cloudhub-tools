//! Responses protocol validation. Function tools are forwarded to the model;
//! this module never invokes tools or interprets their arguments as commands.
use serde_json::{json, Value};
use std::collections::HashSet;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::io::Cursor;

const INVALID: &str = "Responses 请求参数无效";

fn fields(value: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or(INVALID)?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Responses 请求包含不支持的字段".into());
    }
    Ok(())
}
fn string<'a>(value: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    value.get(key).and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= max).ok_or_else(|| INVALID.into())
}
fn name_valid(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn image_part(part: &Value) -> Result<Value, String> {
    const ERROR: &str = "图片输入无效，请使用不超过2MB、1600像素的PNG、JPEG或WebP内嵌图片";
    fields(part, &["type", "image_url", "detail"])?;
    let url = string(part, "image_url", 2_800_000)?;
    let (header, encoded) = url.split_once(',').ok_or(ERROR)?;
    let format = match header {
        "data:image/png;base64" => image::ImageFormat::Png,
        "data:image/jpeg;base64" => image::ImageFormat::Jpeg,
        "data:image/webp;base64" => image::ImageFormat::WebP,
        _ => return Err(ERROR.into()),
    };
    let bytes = STANDARD.decode(encoded).map_err(|_| ERROR)?;
    if bytes.len() > 2_097_152 { return Err(ERROR.into()); }
    let reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|_| ERROR)?;
    if reader.format() != Some(format) { return Err(ERROR.into()); }
    let (width, height) = reader.into_dimensions().map_err(|_| ERROR)?;
    if width == 0 || height == 0 || width > 1600 || height > 1600 { return Err(ERROR.into()); }
    if part.get("detail").is_some_and(|v| !matches!(v.as_str(), Some("auto" | "low" | "high"))) {
        return Err(ERROR.into());
    }
    Ok(part.clone())
}

fn text_parts(value: &Value, role: &str) -> Result<Value, String> {
    let assistant = role == "assistant";
    if let Some(text) = value.as_str() {
        return Ok(json!([{"type":if assistant {"output_text"} else {"input_text"},"text":text}]));
    }
    let parts = value.as_array().filter(|v| v.len() <= 100).ok_or("仅支持文本内容")?;
    let mut result = Vec::new();
    for part in parts {
        if part.get("type").and_then(Value::as_str) == Some("input_image") {
            if role != "user" { return Err("图片仅允许用于用户消息".into()); }
            result.push(image_part(part)?);
            continue;
        }
        fields(part, &["type", "text", "annotations"])?;
        if !matches!(part.get("type").and_then(Value::as_str), Some("text" | "input_text" | "output_text"))
            || part.get("text").and_then(Value::as_str).is_none() {
            return Err("仅支持文本内容".into());
        }
        result.push(json!({"type":if assistant {"output_text"} else {"input_text"},"text":part["text"]}));
    }
    Ok(Value::Array(result))
}

pub fn normalize(bytes: &[u8]) -> Result<(Value, bool), String> {
    let mut body: Value = serde_json::from_slice(bytes).map_err(|_| INVALID)?;
    // Codex 客户端附带的遥测/关联元数据不参与模型请求语义，不应转发给供应商。
    if let Some(object) = body.as_object_mut() { object.remove("client_metadata"); }
    fields(&body, &["model", "input", "instructions", "stream", "store", "tools", "tool_choice",
        "parallel_tool_calls", "reasoning", "include", "max_output_tokens", "temperature", "top_p",
        "text", "prompt_cache_key", "service_tier", "metadata", "truncation"])?;
    if !super::gateway::model_valid(string(&body, "model", 100)?) { return Err("模型 ID 无效".into()); }
    if body.get("store").is_some_and(|v| v != &json!(false)) {
        return Err("本网关不支持服务端会话存储，请传递完整历史并设置 store=false".into());
    }
    let stream = match body.get("stream") { None => false, Some(v) => v.as_bool().ok_or(INVALID)? };
    if body.get("instructions").is_some_and(|v| !v.is_string()) { return Err(INVALID.into()); }
    if body.get("max_output_tokens").is_some_and(|v| v.as_u64().is_none_or(|v| v == 0 || v > 262144)) { return Err(INVALID.into()); }
    for (key, max) in [("temperature", 2.0), ("top_p", 1.0)] {
        if body.get(key).is_some_and(|v| v.as_f64().is_none_or(|v| !(0.0..=max).contains(&v))) { return Err(INVALID.into()); }
    }
    if body.get("parallel_tool_calls").is_some_and(|v| !v.is_boolean()) { return Err(INVALID.into()); }
    if body.get("prompt_cache_key").is_some_and(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 256 || s.chars().any(char::is_control))) { return Err(INVALID.into()); }
    if body.get("service_tier").is_some_and(|v| !matches!(v.as_str(), Some("auto" | "default" | "priority" | "flex"))) { return Err(INVALID.into()); }
    if body.get("truncation").is_some_and(|v| !matches!(v.as_str(), Some("auto" | "disabled"))) { return Err(INVALID.into()); }
    if let Some(metadata) = body.get("metadata") {
        let values = metadata.as_object().filter(|v| v.len() <= 16).ok_or(INVALID)?;
        if values.iter().any(|(key, value)| key.len() > 64 || value.as_str().is_none_or(|v| v.len() > 512)) { return Err(INVALID.into()); }
    }
    if let Some(reasoning) = body.get_mut("reasoning").and_then(Value::as_object_mut) {
        // Codex 客户端扩展字段，不属于上游 Responses reasoning 参数。
        reasoning.remove("context");
    }
    if let Some(reasoning) = body.get("reasoning") {
        fields(reasoning, &["effort", "summary"])?;
        if reasoning.get("effort").is_some_and(|v| !matches!(v.as_str(), Some("none" | "minimal" | "low" | "medium" | "high" | "xhigh")))
            || reasoning.get("summary").is_some_and(|v| !matches!(v.as_str(), Some("auto" | "concise" | "detailed"))) { return Err("推理参数无效".into()); }
    }
    if let Some(include) = body.get("include") {
        let values = include.as_array().filter(|v| v.len() <= 8).ok_or(INVALID)?;
        if values.iter().any(|v| v.as_str() != Some("reasoning.encrypted_content")) { return Err("不支持所请求的附加输出".into()); }
    }
    let text_is_string = body.get("text").is_some_and(Value::is_string);
    if text_is_string { body.as_object_mut().ok_or(INVALID)?.remove("text"); }
    if let Some(text) = body.get("text") {
        fields(text, &["format", "verbosity"])?;
        if text.get("verbosity").is_some_and(|v| !matches!(v.as_str(), Some("low" | "medium" | "high"))) { return Err(INVALID.into()); }
        if let Some(format) = text.get("format") {
            fields(format, &["type", "name", "schema", "strict", "description"])?;
            match format.get("type").and_then(Value::as_str) {
                Some("text" | "json_object") => { fields(format, &["type"])?; }
                Some("json_schema") => {
                    if !name_valid(string(format, "name", 128)?) || !format.get("schema").is_some_and(Value::is_object)
                        || format.get("strict").is_some_and(|v| !v.is_boolean())
                        || format.get("description").is_some_and(|v| !v.is_string()) { return Err(INVALID.into()); }
                }
                _ => return Err(INVALID.into()),
            }
        }
    }
    let mut names = HashSet::new();
    if let Some(tools) = body.get("tools") {
        let tools = tools.as_array().filter(|v| v.len() <= 128).ok_or("函数工具数量无效")?;
        for tool in tools {
            fields(tool, &["type", "name", "description", "parameters", "strict"])?;
            if tool.get("type").and_then(Value::as_str) != Some("function") { return Err("目前仅支持客户端函数工具，不支持托管工具".into()); }
            let name = string(tool, "name", 128)?;
            if !name_valid(name) || !names.insert(name.to_string()) || !tool.get("parameters").is_some_and(Value::is_object)
                || tool.get("description").is_some_and(|v| !v.is_string())
                || tool.get("strict").is_some_and(|v| !v.is_boolean()) { return Err("函数工具定义无效".into()); }
        }
    }
    if let Some(choice) = body.get("tool_choice") {
        if let Some(choice) = choice.as_str() {
            if !matches!(choice, "auto" | "none" | "required") || (choice == "required" && names.is_empty()) { return Err("工具选择参数无效".into()); }
        } else {
            fields(choice, &["type", "name"])?;
            if choice.get("type").and_then(Value::as_str) != Some("function") || !names.contains(string(choice, "name", 128)?) { return Err("工具选择参数无效".into()); }
        }
    }
    let input = body.get("input").ok_or(INVALID)?;
    if input.as_str().is_some_and(str::is_empty) { return Err("输入不能为空".into()); }
    let rows = if input.is_string() { vec![json!({"role":"user","content":input})] }
        else { input.as_array().filter(|v| !v.is_empty() && v.len() <= 1000).ok_or("输入消息数量无效")?.clone() };
    let mut normalized = Vec::new();
    let mut calls = HashSet::new();
    let mut outputs = HashSet::new();
    for mut row in rows {
        match row.get("type").and_then(Value::as_str) {
            // Codex 客户端把首条用户消息直接写成顶层 input_text 条目，
            // 官方 Responses 允许这种简写，部分上游只接受 message 形态。
            Some("input_text") | Some("text") => {
                fields(&row, &["type", "text"])?;
                let text = string(&row, "text", 512 * 1024)?;
                row = json!({"role":"user","content":[{"type":"input_text","text":text}]});
            }
            Some("output_text") | Some("refusal") => {
                fields(&row, &["type", "text"])?;
                let text = string(&row, "text", 512 * 1024)?;
                row = json!({"role":"assistant","content":[{"type":"output_text","text":text}]});
            }
            None | Some("message") => {
                fields(&row, &["type", "id", "status", "role", "content"])?;
                let role = string(&row, "role", 16)?;
                if !matches!(role, "user" | "assistant" | "system" | "developer") { return Err("消息角色无效".into()); }
                let content = text_parts(row.get("content").ok_or(INVALID)?, role)?;
                row = json!({"role":role,"content":content});
            }
            Some("function_call") => {
                fields(&row, &["type", "id", "status", "call_id", "name", "arguments"])?;
                let call = string(&row, "call_id", 256)?.to_string();
                if !calls.insert(call) || !name_valid(string(&row, "name", 128)?)
                    || !serde_json::from_str::<Value>(string(&row, "arguments", 512 * 1024)?).is_ok_and(|v| v.is_object()) { return Err("函数调用参数无效".into()); }
                row.as_object_mut().ok_or(INVALID)?.remove("status");
            }
            Some("function_call_output") => {
                fields(&row, &["type", "id", "status", "call_id", "output"])?;
                let call = string(&row, "call_id", 256)?.to_string();
                if !calls.contains(&call) || !outputs.insert(call) { return Err("工具结果缺少匹配的函数调用".into()); }
                if !row.get("output").is_some_and(Value::is_string) { return Err("目前仅支持文本函数工具结果".into()); }
                row.as_object_mut().ok_or(INVALID)?.remove("status");
            }
            Some("reasoning") => {
                fields(&row, &["type", "id", "summary", "encrypted_content", "status"])?;
                string(&row, "encrypted_content", 512 * 1024)?;
                let summary = row.get("summary").and_then(Value::as_array).filter(|v| v.len() <= 100).ok_or(INVALID)?;
                for item in summary {
                    fields(item, &["type", "text"])?;
                    if item.get("type").and_then(Value::as_str) != Some("summary_text") || !item.get("text").is_some_and(Value::is_string) { return Err(INVALID.into()); }
                }
                row.as_object_mut().ok_or(INVALID)?.remove("status");
            }
            Some("additional_tools") => {
                // Codex 扩展元数据，不是模型对话内容；仅在其为数组时忽略。
                if !row.get("additional_tools").is_none_or(Value::is_array) {
                    return Err("Responses additional_tools 格式无效".into());
                }
                continue;
            }
            Some(other) => return Err(format!("不支持此 Responses 输入类型：{}", other.chars().take(64).collect::<String>())),
            None => return Err("Responses 输入项缺少类型".into()),
        }
        normalized.push(row);
    }
    body["input"] = Value::Array(normalized);
    body["stream"] = json!(true);
    body["store"] = json!(false);
    let object = body.as_object_mut().ok_or(INVALID)?;
    object.entry("instructions").or_insert(json!(""));
    object.entry("tools").or_insert(json!([]));
    object.entry("parallel_tool_calls").or_insert(json!(true));
    Ok((body, stream))
}

pub fn prepare_chatgpt(body: &mut Value) -> Result<(), String> {
    let object = body.as_object_mut().ok_or(INVALID)?;
    for field in ["max_output_tokens", "temperature", "top_p", "metadata", "truncation"] { object.remove(field); }
    // The subscription endpoint takes string tool_choice. Preserve a forced
    // function exactly by restricting its definitions before requiring a call.
    if object.get("tool_choice").is_some_and(Value::is_object) {
        let name = object["tool_choice"]["name"].as_str().ok_or(INVALID)?.to_string();
        let tools = object.get_mut("tools").and_then(Value::as_array_mut).ok_or(INVALID)?;
        tools.retain(|tool| tool.get("name").and_then(Value::as_str) == Some(name.as_str()));
        if tools.len() != 1 { return Err("工具选择参数无效".into()); }
        object.insert("tool_choice".into(), json!("required"));
    }
    let include = object.entry("include").or_insert(json!([])).as_array_mut().ok_or(INVALID)?;
    if !include.iter().any(|v| v.as_str() == Some("reasoning.encrypted_content")) { include.push(json!("reasoning.encrypted_content")); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vision_input_survives_normalization_and_subscription_adaptation() {
        let (image, _) = crate::core::ai_images::challenge().unwrap();
        let part = json!({"type":"input_image","image_url":image.data_url,"detail":"high"});
        let (mut value, _) = normalize_value(json!({"model":"gpt-test","input":[{"role":"user","content":[{"type":"input_text","text":"Read colors"},part.clone()]}]})).unwrap();
        prepare_chatgpt(&mut value).unwrap();
        assert_eq!(value["input"][0]["content"][1], part);
        let mut detail = super::super::gateway_controls::CallDetail::default();
        let logged = detail.sanitize(&value).to_string();
        assert!(!logged.contains(&image.base64));
        assert!(logged.contains("图片内容已隐藏"));
    }
    #[test]
    fn invalid_images_and_non_user_images_are_rejected_without_echoing_data() {
        let (image, _) = crate::core::ai_images::challenge().unwrap();
        for part in [
            json!({"type":"input_image","image_url":"https://private.test/image"}),
            json!({"type":"input_image","image_url":"data:image/jpeg;base64,test-only-private"}),
            json!({"type":"input_image","image_url":image.data_url,"detail":"invalid"}),
            json!({"type":"input_image","image_url":image.data_url,"file_id":"private"}),
            json!({"type":"input_image","image_url":image.data_url.replace("image/jpeg", "image/png")}),
        ] {
            let error = normalize_value(json!({"model":"gpt-test","input":[{"role":"user","content":[part]}]})).unwrap_err();
            assert!(!error.contains("private"));
            assert!(!error.contains(&image.base64));
        }
        for role in ["assistant", "system", "developer"] {
            assert!(normalize_value(json!({"model":"gpt-test","input":[{"role":role,"content":[{"type":"input_image","image_url":image.data_url}]}]})).is_err());
        }
    }
    fn normalize_value(value: Value) -> Result<(Value, bool), String> { normalize(value.to_string().as_bytes()) }
    #[test]
    fn codex_client_metadata_is_dropped_but_unknown_fields_are_rejected() {
        let marker = "private-client-correlation-marker";
        let (value, _) = normalize_value(json!({
            "model":"gpt-test",
            "input":"hello",
            "client_metadata":{"session_id":marker,"installation_id":"private-install-marker"},
            "reasoning":{"context":"all_turns","effort":"medium","summary":"detailed"},
            "text":"plain text format"
        })).unwrap();
        assert!(value.get("client_metadata").is_none());
        assert!(value.get("reasoning").unwrap().get("context").is_none());
        assert!(value.get("text").is_none());
        assert!(!value.to_string().contains(marker));
        assert!(normalize_value(json!({"model":"gpt-test","input":"hello","unsupported_marker":true})).is_err());
    }
    #[test]
    fn codex_additional_tools_metadata_is_ignored_but_not_forwarded() {
        let (value, _) = normalize_value(json!({
            "model":"gpt-test",
            "input":[{"type":"additional_tools","additional_tools":[{"name":"local_search"}]}]
        })).unwrap();
        assert!(value["input"].as_array().unwrap().is_empty());
        assert!(!value.to_string().contains("additional_tools"));
        assert!(normalize_value(json!({"model":"gpt-test","input":[{"type":"additional_tools","additional_tools":"invalid"}]})).is_err());
    }

    #[test]
    fn codex_style_top_level_input_text_becomes_a_user_message() {
        // Codex 客户端首条消息使用顶层 input_text 条目，必须能规范成用户消息。
        let (value, _) = normalize_value(json!({"model":"gpt-test","input":[{"type":"input_text","text":"hello"}]})).unwrap();
        assert_eq!(value["input"][0]["role"],"user");
        assert_eq!(value["input"][0]["content"][0]["type"],"input_text");
        assert_eq!(value["input"][0]["content"][0]["text"],"hello");
        let (value, _) = normalize_value(json!({"model":"gpt-test","input":[{"type":"text","text":"hello"}]})).unwrap();
        assert_eq!(value["input"][0]["role"],"user");
        // 不认识的顶层类型仍然拒绝。
        assert!(normalize_value(json!({"model":"gpt-test","input":[{"type":"unknown","text":"hello"}]})).is_err());
    }
    fn tool() -> Value { json!({"type":"function","name":"read_file","description":"Test only","parameters":{"type":"object","properties":{"path":{"type":"string"}}},"strict":false}) }
    #[test]
    fn claude_controls_and_tools_survive_and_subscription_body_is_adapted() {
        let (mut value, stream) = normalize_value(json!({"model":"gpt-test","input":"hi","stream":true,"max_output_tokens":64000,"temperature":1,"top_p":0.9,"tools":[tool()],"tool_choice":{"type":"function","name":"read_file"},"parallel_tool_calls":false,"reasoning":{"effort":"high","summary":"auto"},"text":{"format":{"type":"text"}},"prompt_cache_key":"test-only-session"})).unwrap();
        assert!(stream);
        assert_eq!(value["tools"][0], tool());
        assert_eq!(value["reasoning"]["summary"], "auto");
        prepare_chatgpt(&mut value).unwrap();
        assert_eq!(value["tool_choice"], "required");
        assert_eq!(value["parallel_tool_calls"], false);
        assert_eq!(value["include"], json!(["reasoning.encrypted_content"]));
        assert!(value.get("max_output_tokens").is_none());
        assert!(value.get("temperature").is_none());
        assert!(value.get("top_p").is_none());
    }
    #[test]
    fn full_parallel_tool_history_preserves_ids_outputs_and_encrypted_reasoning() {
        let history = json!([
            {"role":"user","content":"Read two test files"},
            {"type":"reasoning","id":"reasoning-test","encrypted_content":"test-only-opaque","summary":[{"type":"summary_text","text":"Checking"}]},
            {"type":"function_call","call_id":"call-test-1","name":"read_file","arguments":"{\"path\":\"one.test\"}"},
            {"type":"function_call","call_id":"call-test-2","name":"read_file","arguments":"{\"path\":\"two.test\"}"},
            {"type":"function_call_output","call_id":"call-test-2","output":"second test output"},
            {"type":"function_call_output","call_id":"call-test-1","output":"first test output"}
        ]);
        let (value, _) = normalize_value(json!({"model":"gpt-test","tools":[tool()],"input":history})).unwrap();
        assert_eq!(value["input"].as_array().unwrap()[1..], history.as_array().unwrap()[1..]);
    }
    #[test]
    fn invalid_tools_unpaired_outputs_and_provider_overrides_are_rejected_without_values() {
        for extra in [json!({"tools":[{"type":"shell"}]}), json!({"tools":[tool(),tool()]}), json!({"base_url":"http://test-only-untrusted"}),json!({"store":true}),json!({"previous_response_id":"test-only-id"}),json!({"reasoning":{"effort":"invalid"}})] {
            let mut value=json!({"model":"gpt-test","input":"hi"});
            value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            let error=normalize_value(value).unwrap_err();
            assert!(!error.contains("test-only-untrusted"));
            assert!(!error.contains("test-only-id"));
        }
        assert!(normalize_value(json!({"model":"gpt-test","input":[{"type":"function_call_output","call_id":"unmatched","output":"test"}]})).is_err());
        assert!(normalize_value(json!({"model":"gpt-test","input":"hi","tools":[tool()],"tool_choice":{"type":"function","name":"undeclared"}})).is_err());
    }
}
