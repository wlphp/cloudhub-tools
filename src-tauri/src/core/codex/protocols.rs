//! Local wire-protocol adapters. They translate data, never execute tools.
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Responses,
    Chat,
    Completion,
    Anthropic,
    Gemini,
}
impl Protocol {
    pub fn for_path(path: &str) -> Self {
        if path.starts_with("/v1beta/models/") {
            Self::Gemini
        } else {
            match path {
                "/v1/messages" => Self::Anthropic,
                "/v1/completions" => Self::Completion,
                "/v1/chat/completions" => Self::Chat,
                _ => Self::Responses,
            }
        }
    }
}
pub fn gemini_path(path: &str) -> Option<(&str, bool)> {
    let tail = path.strip_prefix("/v1beta/models/")?;
    let (model, method) = tail.split_once(':')?;
    if !super::gateway::model_valid(model) {
        return None;
    }
    match method {
        "generateContent" => Some((model, false)),
        "streamGenerateContent" => Some((model, true)),
        _ => None,
    }
}
fn fields(value: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or("协议请求参数无效")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("协议请求包含尚不支持的字段".into());
    }
    Ok(())
}
fn text(value: &Value) -> Result<String, String> {
    if let Some(s) = value.as_str() {
        return Ok(s.into());
    }
    let parts = value
        .as_array()
        .filter(|parts| parts.len() <= 100)
        .ok_or("仅支持文本和函数工具内容")?;
    let mut result = String::new();
    for part in parts {
        fields(part, &["type", "text", "cache_control"])?;
        if part["type"] != "text" {
            return Err("仅支持文本和函数工具内容".into());
        }
        result.push_str(part["text"].as_str().ok_or("文本内容无效")?);
    }
    Ok(result)
}
fn push_text(input: &mut Vec<Value>, role: &str, text: String) {
    input.push(json!({"role":role,"content":[{"type":if role=="assistant" {"output_text"} else {"input_text"},"text":text}]}));
}
fn schema(value: &Value) -> Value {
    match value {
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        if k == "type" && v.is_string() {
                            json!(v.as_str().unwrap().to_ascii_lowercase())
                        } else {
                            schema(v)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(schema).collect()),
        _ => value.clone(),
    }
}
pub fn normalize(path: &str, bytes: &[u8]) -> Result<(Value, bool), String> {
    let source: Value = serde_json::from_slice(bytes).map_err(|_| "协议请求 JSON 无效")?;
    let protocol = Protocol::for_path(path);
    let mut body = json!({"model":source["model"],"store":false,"input":[],"tools":[]});
    let mut input = Vec::new();
    let streaming;
    match protocol {
        Protocol::Completion => {
            fields(
                &source,
                &[
                    "model",
                    "prompt",
                    "stream",
                    "max_tokens",
                    "temperature",
                    "top_p",
                ],
            )?;
            push_text(
                &mut input,
                "user",
                source["prompt"]
                    .as_str()
                    .ok_or("Completions 仅支持单个文本 prompt")?
                    .into(),
            );
            streaming = source
                .get("stream")
                .map(|v| v.as_bool().ok_or("stream 参数无效"))
                .transpose()?
                .unwrap_or(false);
            for (from, to) in [
                ("max_tokens", "max_output_tokens"),
                ("temperature", "temperature"),
                ("top_p", "top_p"),
            ] {
                if let Some(v) = source.get(from) {
                    body[to] = v.clone();
                }
            }
        }
        Protocol::Anthropic => {
            fields(
                &source,
                &[
                    "model",
                    "messages",
                    "system",
                    "max_tokens",
                    "stream",
                    "temperature",
                    "top_p",
                    "tools",
                    "tool_choice",
                    "metadata",
                ],
            )?;
            if source.get("max_tokens").is_none() {
                return Err("Anthropic 请求需要 max_tokens".into());
            }
            body["max_output_tokens"] = source["max_tokens"].clone();
            streaming = source
                .get("stream")
                .map(|v| v.as_bool().ok_or("stream 参数无效"))
                .transpose()?
                .unwrap_or(false);
            if let Some(system) = source.get("system") {
                body["instructions"] = json!(text(system)?);
            }
            for key in ["temperature", "top_p"] {
                if let Some(v) = source.get(key) {
                    body[key] = v.clone();
                }
            }
            if let Some(metadata) = source.get("metadata") {
                fields(metadata, &["user_id"])?;
            }
            let messages = source["messages"]
                .as_array()
                .filter(|v| !v.is_empty() && v.len() <= 256)
                .ok_or("messages 数量无效")?;
            for message in messages {
                fields(message, &["role", "content"])?;
                let role = message["role"]
                    .as_str()
                    .filter(|v| matches!(*v, "user" | "assistant"))
                    .ok_or("消息角色无效")?;
                if message["content"].is_string() {
                    push_text(&mut input, role, text(&message["content"])?);
                    continue;
                }
                let parts = message["content"]
                    .as_array()
                    .filter(|v| v.len() <= 100)
                    .ok_or("消息内容无效")?;
                for part in parts {
                    match part["type"].as_str() {
                        Some("text") => {
                            fields(part, &["type", "text", "cache_control"])?;
                            push_text(
                                &mut input,
                                role,
                                part["text"].as_str().ok_or("文本内容无效")?.into(),
                            );
                        }
                        Some("tool_use") if role == "assistant" => {
                            fields(part, &["type", "id", "name", "input", "cache_control"])?;
                            if !part["input"].is_object() {
                                return Err("工具参数须为对象".into());
                            }
                            input.push(json!({"type":"function_call","call_id":part["id"],"name":part["name"],"arguments":part["input"].to_string()}));
                        }
                        Some("tool_result") if role == "user" => {
                            fields(
                                part,
                                &[
                                    "type",
                                    "tool_use_id",
                                    "content",
                                    "is_error",
                                    "cache_control",
                                ],
                            )?;
                            if part.get("is_error").is_some_and(|v| !v.is_boolean()) {
                                return Err("工具结果无效".into());
                            }
                            let result = text(&part["content"])?;
                            input.push(json!({"type":"function_call_output","call_id":part["tool_use_id"],"output":if part["is_error"]==true{format!("Tool error: {result}")}else{result}}));
                        }
                        _ => {
                            return Err(
                                "Anthropic 入口仅支持文本和客户端函数工具，暂不支持图片或 thinking"
                                    .into(),
                            )
                        }
                    }
                }
            }
            if let Some(tools) = source.get("tools") {
                let tools = tools
                    .as_array()
                    .filter(|v| v.len() <= 128)
                    .ok_or("工具数量无效")?;
                let mut mapped = Vec::new();
                for tool in tools {
                    fields(
                        tool,
                        &["name", "description", "input_schema", "cache_control"],
                    )?;
                    let mut mapped_tool = json!({"type":"function","name":tool["name"],"parameters":tool["input_schema"]});
                    if let Some(v) = tool.get("description") {
                        mapped_tool["description"] = v.clone();
                    }
                    mapped.push(mapped_tool);
                }
                body["tools"] = json!(mapped);
            }
            if let Some(choice) = source.get("tool_choice") {
                fields(choice, &["type", "name", "disable_parallel_tool_use"])?;
                body["tool_choice"] = match choice["type"].as_str() {
                    Some("auto") => json!("auto"),
                    Some("any") => json!("required"),
                    Some("none") => json!("none"),
                    Some("tool") => json!({"type":"function","name":choice["name"]}),
                    _ => return Err("工具选择无效".into()),
                };
                if let Some(v) = choice.get("disable_parallel_tool_use") {
                    body["parallel_tool_calls"] = json!(!v.as_bool().ok_or("并行工具参数无效")?);
                }
            }
        }
        Protocol::Gemini => {
            fields(
                &source,
                &[
                    "contents",
                    "systemInstruction",
                    "generationConfig",
                    "tools",
                    "toolConfig",
                ],
            )?;
            let (model, stream) = gemini_path(path).ok_or("Gemini 模型路径无效")?;
            body["model"] = json!(model);
            streaming = stream;
            if let Some(system) = source.get("systemInstruction") {
                fields(system, &["role", "parts"])?;
                let parts = system["parts"]
                    .as_array()
                    .filter(|v| v.len() <= 100)
                    .ok_or("系统指令无效")?;
                let mut instruction = String::new();
                for part in parts {
                    fields(part, &["text"])?;
                    instruction.push_str(part["text"].as_str().ok_or("仅支持文本系统指令")?);
                }
                body["instructions"] = json!(instruction);
            }
            if let Some(config) = source.get("generationConfig") {
                fields(
                    config,
                    &[
                        "temperature",
                        "topP",
                        "maxOutputTokens",
                        "candidateCount",
                        "responseMimeType",
                        "responseSchema",
                        "responseJsonSchema",
                    ],
                )?;
                if config.get("candidateCount").is_some_and(|v| v != &json!(1)) {
                    return Err("仅支持单个候选结果".into());
                }
                for (from, to) in [
                    ("temperature", "temperature"),
                    ("topP", "top_p"),
                    ("maxOutputTokens", "max_output_tokens"),
                ] {
                    if let Some(v) = config.get(from) {
                        body[to] = v.clone();
                    }
                }
                match config.get("responseMimeType").and_then(Value::as_str) {
                    None | Some("text/plain") => {
                        if config
                            .get("responseSchema")
                            .or(config.get("responseJsonSchema"))
                            .is_some()
                        {
                            return Err("响应 schema 需要 application/json".into());
                        }
                    }
                    Some("application/json") => {
                        body["text"] = if let Some(v) = config
                            .get("responseJsonSchema")
                            .or(config.get("responseSchema"))
                        {
                            json!({"format":{"type":"json_schema","name":"gemini_response","schema":schema(v)}})
                        } else {
                            json!({"format":{"type":"json_object"}})
                        };
                    }
                    _ => return Err("响应 MIME 类型不支持".into()),
                }
            }
            let contents = source["contents"]
                .as_array()
                .filter(|v| !v.is_empty() && v.len() <= 256)
                .ok_or("contents 数量无效")?;
            let mut pending: HashMap<String, VecDeque<String>> = HashMap::new();
            for content in contents {
                fields(content, &["role", "parts"])?;
                let role = match content.get("role").and_then(Value::as_str) {
                    None | Some("user") => "user",
                    Some("model") => "assistant",
                    _ => return Err("消息角色无效".into()),
                };
                let parts = content["parts"]
                    .as_array()
                    .filter(|v| v.len() <= 100)
                    .ok_or("parts 数量无效")?;
                for part in parts {
                    fields(part, &["text", "functionCall", "functionResponse"])?;
                    if part.as_object().is_none_or(|v| v.len() != 1) {
                        return Err("仅支持文本和函数工具 parts".into());
                    }
                    if let Some(v) = part.get("text") {
                        push_text(&mut input, role, v.as_str().ok_or("文本内容无效")?.into());
                    } else if let Some(call) =
                        part.get("functionCall").filter(|_| role == "assistant")
                    {
                        fields(call, &["id", "name", "args"])?;
                        let name = call["name"].as_str().ok_or("函数名称无效")?;
                        if !call["args"].is_object() {
                            return Err("函数参数须为对象".into());
                        }
                        let id = match call.get("id") {
                            Some(v) => v.as_str().ok_or("函数标识无效")?.to_string(),
                            None => format!("gemini-call-{}", input.len()),
                        };
                        pending
                            .entry(name.into())
                            .or_default()
                            .push_back(id.clone());
                        input.push(json!({"type":"function_call","call_id":id,"name":name,"arguments":call["args"].to_string()}));
                    } else if let Some(result) =
                        part.get("functionResponse").filter(|_| role == "user")
                    {
                        fields(result, &["id", "name", "response"])?;
                        let name = result["name"].as_str().ok_or("函数名称无效")?;
                        if !result["response"].is_object() {
                            return Err("函数结果须为对象".into());
                        }
                        let calls = pending.get_mut(name).ok_or("函数结果缺少对应调用历史")?;
                        let id = if let Some(v) = result.get("id") {
                            let id = v.as_str().ok_or("函数标识无效")?;
                            let at = calls
                                .iter()
                                .position(|v| v == id)
                                .ok_or("函数结果缺少对应调用历史")?;
                            calls.remove(at).unwrap()
                        } else {
                            calls.pop_front().ok_or("函数结果缺少对应调用历史")?
                        };
                        input.push(json!({"type":"function_call_output","call_id":id,"output":result["response"].to_string()}));
                    } else {
                        return Err("函数调用或结果的消息角色无效".into());
                    }
                }
            }
            if let Some(tools) = source.get("tools") {
                let mut mapped = Vec::new();
                for tool in tools
                    .as_array()
                    .filter(|v| v.len() <= 128)
                    .ok_or("工具数量无效")?
                {
                    fields(tool, &["functionDeclarations"])?;
                    for declaration in tool["functionDeclarations"]
                        .as_array()
                        .filter(|v| v.len() <= 128)
                        .ok_or("函数声明无效")?
                    {
                        fields(
                            declaration,
                            &["name", "description", "parameters", "parametersJsonSchema"],
                        )?;
                        let parameters = declaration
                            .get("parametersJsonSchema")
                            .or(declaration.get("parameters"))
                            .cloned()
                            .unwrap_or(json!({"type":"object","properties":{}}));
                        let mut function = json!({"type":"function","name":declaration["name"],"parameters":schema(&parameters)});
                        if let Some(v) = declaration.get("description") {
                            function["description"] = v.clone();
                        }
                        mapped.push(function);
                    }
                }
                body["tools"] = json!(mapped);
            }
            if let Some(config) = source.get("toolConfig") {
                fields(config, &["functionCallingConfig"])?;
                let choice = &config["functionCallingConfig"];
                fields(choice, &["mode", "allowedFunctionNames"])?;
                let names = choice
                    .get("allowedFunctionNames")
                    .map(|v| v.as_array().ok_or("函数选择无效"))
                    .transpose()?;
                if names.is_some_and(|v| v.len() > 1) {
                    return Err("暂不支持多个指定函数名称".into());
                }
                body["tool_choice"] = match choice["mode"].as_str() {
                    Some("AUTO") => json!("auto"),
                    Some("NONE") => json!("none"),
                    Some("ANY") => {
                        if let Some(name) = names.and_then(|v| v.first()) {
                            json!({"type":"function","name":name})
                        } else {
                            json!("required")
                        }
                    }
                    _ => return Err("函数调用模式不支持".into()),
                };
                if names.is_some_and(|v| !v.is_empty()) && choice["mode"] != "ANY" {
                    return Err("指定函数需要 ANY 模式".into());
                }
            }
        }
        _ => return Err("协议转换路径无效".into()),
    }
    body["input"] = json!(input);
    body["stream"] = json!(streaming);
    super::responses::normalize(&serde_json::to_vec(&body).map_err(|_| "协议参数转换失败")?)
}
fn output(value: &Value) -> Vec<Value> {
    value["output"].as_array().cloned().unwrap_or_default()
}
pub fn valid_output(value: &Value) -> bool {
    value["output"].as_array().is_some_and(|items| {
        items.iter().all(|item| {
            item["type"] != "function_call"
                || (item["call_id"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 256)
                    && item["name"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty() && s.len() <= 128)
                    && item["arguments"]
                        .as_str()
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .is_some_and(|v| v.is_object()))
        })
    })
}
pub fn anthropic_content(value: &Value) -> Vec<Value> {
    let mut blocks = Vec::new();
    for item in output(value) {
        if item["type"] == "function_call" {
            if let Some(args) = item["arguments"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .filter(Value::is_object)
            {
                blocks.push(json!({"type":"tool_use","id":item["call_id"],"name":item["name"],"input":args}));
            }
        } else if let Some(parts) = item["content"].as_array() {
            for part in parts {
                if let Some(text) = part["text"].as_str() {
                    blocks.push(json!({"type":"text","text":text}));
                }
            }
        }
    }
    blocks
}
pub fn gemini_content(value: &Value) -> Vec<Value> {
    anthropic_content(value).iter().map(|block| if block["type"]=="tool_use"{json!({"functionCall":{"id":block["id"],"name":block["name"],"args":block["input"]}})}else{json!({"text":block["text"]})}).collect()
}
fn usage(value: &Value) -> Value {
    json!({"input_tokens":value.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0),"output_tokens":value.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0)})
}
fn gemini_usage(value: &Value) -> Value {
    let u = usage(value);
    let i = u["input_tokens"].as_u64().unwrap_or(0);
    let o = u["output_tokens"].as_u64().unwrap_or(0);
    json!({"promptTokenCount":i,"candidatesTokenCount":o,"totalTokenCount":i.saturating_add(o)})
}
pub fn response(protocol: Protocol, value: &Value, id: &str, model: &Value) -> Value {
    match protocol {
        Protocol::Anthropic => {
            let content = anthropic_content(value);
            let stop = if content.iter().any(|v| v["type"] == "tool_use") {
                "tool_use"
            } else {
                "end_turn"
            };
            json!({"id":id,"type":"message","role":"assistant","model":model,"content":content,"stop_reason":stop,"stop_sequence":null,"usage":usage(value)})
        }
        Protocol::Gemini => {
            json!({"candidates":[{"index":0,"content":{"role":"model","parts":gemini_content(value)},"finishReason":"STOP"}],"usageMetadata":gemini_usage(value),"modelVersion":model,"responseId":id})
        }
        Protocol::Completion => {
            let text = anthropic_content(value)
                .iter()
                .filter_map(|v| v["text"].as_str())
                .collect::<Vec<_>>()
                .join("");
            let u = usage(value);
            let i = u["input_tokens"].as_u64().unwrap_or(0);
            let o = u["output_tokens"].as_u64().unwrap_or(0);
            json!({"id":id,"object":"text_completion","created":chrono::Utc::now().timestamp(),"model":model,"choices":[{"index":0,"text":text,"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":i,"completion_tokens":o,"total_tokens":i.saturating_add(o)}})
        }
        _ => value.clone(),
    }
}
pub fn error(protocol: Protocol, status: u16, message: &str) -> Value {
    if protocol == Protocol::Gemini {
        json!({"error":{"code":status,"message":message,"status":match status {401=>"UNAUTHENTICATED",403=>"PERMISSION_DENIED",400=>"INVALID_ARGUMENT",429=>"RESOURCE_EXHAUSTED",_=>"UNAVAILABLE"}}})
    } else {
        json!({"type":"error","error":{"type":if status==401{"authentication_error"}else if status==400{"invalid_request_error"}else{"api_error"},"message":message}})
    }
}

pub struct StreamAdapter {
    protocol: Protocol,
    id: String,
    model: Value,
    started: bool,
    blocks: BTreeMap<(u64, u64), (usize, bool, bool)>,
    seen_tools: HashSet<String>,
    text_seen: bool,
}
impl StreamAdapter {
    pub fn new(protocol: Protocol, id: String, model: Value) -> Self {
        Self {
            protocol,
            id,
            model,
            started: false,
            blocks: BTreeMap::new(),
            seen_tools: HashSet::new(),
            text_seen: false,
        }
    }
    fn start(&mut self, events: &mut Vec<Value>, value: &Value) {
        if self.started {
            return;
        }
        self.started = true;
        events.push(json!({"type":"message_start","message":{"id":self.id,"type":"message","role":"assistant","model":self.model,"content":[],"stop_reason":null,"stop_sequence":null,"usage":usage(value)}}));
    }
    fn block(&mut self, key: (u64, u64), content: Value, events: &mut Vec<Value>) -> usize {
        if let Some((index, _, _)) = self.blocks.get(&key) {
            return *index;
        }
        let index = self.blocks.len();
        self.blocks.insert(key, (index, true, false));
        events.push(json!({"type":"content_block_start","index":index,"content_block":content}));
        index
    }
    pub fn events(&mut self, value: &Value) -> Vec<Value> {
        let kind = value["type"].as_str().unwrap_or("");
        let mut events = Vec::new();
        if self.protocol == Protocol::Anthropic {
            self.start(&mut events, value.get("response").unwrap_or(&Value::Null));
            let key = (
                value["output_index"].as_u64().unwrap_or(0),
                value["content_index"].as_u64().unwrap_or(0),
            );
            if kind == "response.output_text.delta" {
                let index = self.block(key, json!({"type":"text","text":""}), &mut events);
                self.blocks.get_mut(&key).unwrap().2 = true;
                events.push(json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":value["delta"]}}));
            } else if kind == "response.output_item.added"
                && value["item"]["type"] == "function_call"
            {
                self.block((key.0,u64::MAX),json!({"type":"tool_use","id":value["item"]["call_id"],"name":value["item"]["name"],"input":{}}),&mut events);
            } else if kind == "response.function_call_arguments.delta" {
                if let Some((index, _, seen)) = self.blocks.get_mut(&(key.0, u64::MAX)) {
                    *seen = true;
                    events.push(json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":value["delta"]}}));
                }
            } else if kind == "response.completed" {
                let final_value = &value["response"];
                for (out_index, item) in output(final_value).iter().enumerate() {
                    if item["type"] == "function_call" {
                        let key = (out_index as u64, u64::MAX);
                        let index=self.block(key,json!({"type":"tool_use","id":item["call_id"],"name":item["name"],"input":{}}),&mut events);
                        if !self.blocks[&key].2 {
                            events.push(json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":item["arguments"]}}));
                        }
                    } else if let Some(parts) = item["content"].as_array() {
                        for (part_index, part) in parts.iter().enumerate() {
                            if part["text"].is_string() {
                                let key = (out_index as u64, part_index as u64);
                                let index =
                                    self.block(key, json!({"type":"text","text":""}), &mut events);
                                if !self.blocks[&key].2 {
                                    events.push(json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":part["text"]}}));
                                }
                            }
                        }
                    }
                }
                let mut indexes = self.blocks.values().map(|(i, _, _)| *i).collect::<Vec<_>>();
                indexes.sort_unstable();
                for index in indexes {
                    events.push(json!({"type":"content_block_stop","index":index}));
                }
                let result = response(self.protocol, final_value, &self.id, &self.model);
                events.push(json!({"type":"message_delta","delta":{"stop_reason":result["stop_reason"],"stop_sequence":null},"usage":result["usage"]}));
                events.push(json!({"type":"message_stop"}));
            }
        } else if self.protocol == Protocol::Gemini {
            if kind == "response.output_text.delta" {
                self.text_seen = true;
                events.push(json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":value["delta"]}]}}],"modelVersion":self.model,"responseId":self.id}));
            }
            if kind == "response.output_item.done" && value["item"]["type"] == "function_call" {
                let item = &value["item"];
                if let Some(id) = item["call_id"].as_str() {
                    self.seen_tools.insert(id.into());
                }
                let parts = gemini_content(&json!({"output":[item]}));
                if !parts.is_empty() {
                    events.push(json!({"candidates":[{"index":0,"content":{"role":"model","parts":parts}}],"modelVersion":self.model,"responseId":self.id}));
                }
            }
            if kind == "response.completed" {
                let mut final_value =
                    response(self.protocol, &value["response"], &self.id, &self.model);
                let parts = gemini_content(&value["response"])
                    .into_iter()
                    .filter(|part| {
                        if part.get("text").is_some() {
                            !self.text_seen
                        } else {
                            !self.seen_tools.contains(
                                part.pointer("/functionCall/id")
                                    .and_then(Value::as_str)
                                    .unwrap_or(""),
                            )
                        }
                    })
                    .collect::<Vec<_>>();
                final_value["candidates"][0]["content"]["parts"] = json!(parts);
                events.push(final_value);
            }
        } else if self.protocol == Protocol::Completion {
            if kind == "response.output_text.delta" {
                self.text_seen = true;
                events.push(json!({"id":self.id,"object":"text_completion","created":chrono::Utc::now().timestamp(),"model":self.model,"choices":[{"index":0,"text":value["delta"],"logprobs":null,"finish_reason":null}]}));
            }
            if kind == "response.completed" {
                let text = if self.text_seen {
                    json!("")
                } else {
                    response(self.protocol, &value["response"], &self.id, &self.model)["choices"][0]
                        ["text"]
                        .clone()
                };
                events.push(json!({"id":self.id,"object":"text_completion","created":chrono::Utc::now().timestamp(),"model":self.model,"choices":[{"index":0,"text":text,"logprobs":null,"finish_reason":"stop"}]}));
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn normalize_value(path: &str, value: Value) -> Result<(Value, bool), String> {
        normalize(path, value.to_string().as_bytes())
    }
    fn completion() -> Value {
        json!({"output":[{"type":"message","content":[{"type":"output_text","text":"你好"}]},{"type":"function_call","call_id":"call-a","name":"lookup","arguments":"{\"city\":\"Paris\"}"}],"usage":{"input_tokens":12,"output_tokens":7}})
    }
    #[test]
    fn anthropic_maps_history_tools_choices_and_rejects_unsupported_content() {
        let source = json!({"model":"gpt-test","max_tokens":100,"system":[{"type":"text","text":"Answer clearly"}],"messages":[{"role":"user","content":"hello"},{"role":"assistant","content":[{"type":"tool_use","id":"call-a","name":"lookup","input":{"city":"Paris"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-a","content":[{"type":"text","text":"sunny"}]}]}],"tools":[{"name":"lookup","input_schema":{"type":"object","properties":{"city":{"type":"string"}}}}],"tool_choice":{"type":"tool","name":"lookup","disable_parallel_tool_use":true}});
        let (mapped, stream) = normalize_value("/v1/messages", source).unwrap();
        assert!(!stream);
        assert_eq!(mapped["instructions"], "Answer clearly");
        assert_eq!(mapped["input"][2]["call_id"], "call-a");
        assert_eq!(mapped["parallel_tool_calls"], false);
        assert_eq!(mapped["max_output_tokens"], 100);
        assert!(normalize_value("/v1/messages",json!({"model":"gpt-test","max_tokens":1,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"https://example.test"}}]}]})).is_err());
        assert!(
            normalize_value("/v1/messages", json!({"model":"gpt-test","messages":[]})).is_err()
        );
    }
    #[test]
    fn gemini_maps_schema_and_function_result_ids() {
        let source = json!({"contents":[{"role":"user","parts":[{"text":"hello"}]},{"role":"model","parts":[{"functionCall":{"name":"lookup","args":{"city":"Paris"}}}]},{"role":"user","parts":[{"functionResponse":{"name":"lookup","response":{"weather":"sunny"}}}]}],"tools":[{"functionDeclarations":[{"name":"lookup","parameters":{"type":"OBJECT","properties":{"city":{"type":"STRING"}}}}]}],"generationConfig":{"maxOutputTokens":100,"responseMimeType":"application/json","responseSchema":{"type":"OBJECT","properties":{"answer":{"type":"STRING"}}}}});
        let (mapped, stream) =
            normalize_value("/v1beta/models/gpt-test:streamGenerateContent", source).unwrap();
        assert!(stream);
        assert_eq!(mapped["input"][1]["call_id"], mapped["input"][2]["call_id"]);
        assert_eq!(mapped["tools"][0]["parameters"]["type"], "object");
        assert_eq!(
            mapped["text"]["format"]["schema"]["properties"]["answer"]["type"],
            "string"
        );
        assert!(gemini_path("/v1beta/models/../../bad:generateContent").is_none());
        assert!(normalize_value(
            "/v1beta/models/gpt-test:generateContent",
            json!({"contents":[{"parts":[{"inlineData":{"data":"bad"}}]}]})
        )
        .is_err());
    }
    #[test]
    fn response_and_sse_preserve_tool_ids_usage_and_complete_event_sequence() {
        let final_value = completion();
        assert!(valid_output(&final_value));
        let anthropic = response(
            Protocol::Anthropic,
            &final_value,
            "msg-test",
            &json!("gpt-test"),
        );
        assert_eq!(anthropic["stop_reason"], "tool_use");
        assert_eq!(anthropic["content"][1]["input"]["city"], "Paris");
        assert_eq!(anthropic["usage"]["output_tokens"], 7);
        let mut adapter =
            StreamAdapter::new(Protocol::Anthropic, "msg-test".into(), json!("gpt-test"));
        let events = adapter.events(&json!({"type":"response.completed","response":final_value}));
        assert_eq!(events[0]["type"], "message_start");
        assert_eq!(events.last().unwrap()["type"], "message_stop");
        assert_eq!(
            events
                .iter()
                .filter(|v| v["type"] == "content_block_start")
                .count(),
            2
        );
        let gemini = response(
            Protocol::Gemini,
            &final_value,
            "gem-test",
            &json!("gpt-test"),
        );
        assert_eq!(
            gemini["candidates"][0]["content"]["parts"][1]["functionCall"]["id"],
            "call-a"
        );
        assert_eq!(gemini["usageMetadata"]["totalTokenCount"], 19);
        let mut adapter =
            StreamAdapter::new(Protocol::Gemini, "gem-test".into(), json!("gpt-test"));
        let first = adapter.events(&json!({"type":"response.output_text.delta","delta":"你好"}));
        assert_eq!(
            first[0]["candidates"][0]["content"]["parts"][0]["text"],
            "你好"
        );
        let last = adapter.events(&json!({"type":"response.completed","response":final_value}));
        assert_eq!(
            last[0]["candidates"][0]["content"]["parts"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(last[0]["candidates"][0]["finishReason"], "STOP");
        assert!(!valid_output(
            &json!({"output":[{"type":"function_call","arguments":"broken"}]})
        ));
    }
}
