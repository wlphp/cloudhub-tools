use serde::{Deserialize, Serialize};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::{HashMap, VecDeque};

pub const SCHEMA: &str = crate::core::database::CODEX_GATEWAY_PREFERENCES_SCHEMA;

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub enum RoutingStrategy { #[default] RoundRobin, QuotaFirst, Ordered }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewaySettings {
    pub logging_enabled: bool,
    pub strategy: RoutingStrategy,
    pub cooldown_seconds: u64,
}
impl Default for GatewaySettings {
    fn default() -> Self { Self { logging_enabled: false, strategy: RoutingStrategy::RoundRobin, cooldown_seconds: 60 } }
}
impl GatewaySettings {
    pub fn validate(&self) -> Result<(), String> {
        if !(5..=3600).contains(&self.cooldown_seconds) { return Err("失败冷却时间须为 5–3600 秒".into()); }
        Ok(())
    }
}
pub fn load(conn: &Connection) -> Result<GatewaySettings, String> {
    let raw: Option<String> = conn.query_row("SELECT json FROM codex_gateway_preferences WHERE id=1", [], |r| r.get(0)).optional().map_err(|_| "读取网关规则失败")?;
    let settings: GatewaySettings = match raw { Some(raw) => serde_json::from_str(&raw).map_err(|_| "网关规则格式无效")?, None => GatewaySettings::default() };
    settings.validate()?;
    Ok(settings)
}
pub fn save(conn: &Connection, settings: &GatewaySettings) -> Result<(), String> {
    settings.validate()?;
    let raw = serde_json::to_string(settings).map_err(|_| "网关规则格式无效")?;
    conn.execute("INSERT INTO codex_gateway_preferences(id,json) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET json=excluded.json", params![raw]).map_err(|_| "保存网关规则失败")?;
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallLog {
    pub id: String,
    pub timestamp: i64,
    pub endpoint: &'static str,
    pub model: Option<String>,
    pub account_id: Option<i64>,
    pub status: u16,
    pub upstream_status: Option<u16>,
    pub outcome: &'static str,
    pub streaming: bool,
    pub duration_ms: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    #[serde(skip)]
    pub detail: CallDetail,
    #[serde(skip)]
    pub detail_bytes: usize,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallDetail {
    pub request: Option<serde_json::Value>,
    pub forwarded: Option<serde_json::Value>,
    pub response: Option<serde_json::Value>,
    pub events: Vec<serde_json::Value>,
    pub event_count: usize,
    pub truncated: bool,
}
impl CallDetail {
    pub fn sanitize(&mut self, value: &serde_json::Value) -> serde_json::Value {
        fn visit(value: &serde_json::Value, field: &str, depth: usize, left: &mut usize, truncated: &mut bool) -> serde_json::Value {
            use serde_json::{Value, json};
            if depth > 10 || *left == 0 { *truncated=true; return json!("[已截断]"); }
            *left-=1;
            if matches!(field,"arguments"|"metadata"|"instructions"|"description"|"name"|"properties"|"required"|"enum") { return json!("[内容已隐藏]"); }
            match value {
                Value::Object(fields) => {
                    let allowed="model stream store input messages instructions tools tool_choice parallel_tool_calls reasoning effort summary max_output_tokens max_tokens temperature top_p text format type role content output arguments parameters strict name description required properties additionalProperties enum items response usage input_tokens output_tokens total_tokens input_tokens_details output_tokens_details cached_tokens reasoning_tokens status error code message delta sequence_number output_index content_index index choices finish_reason object created_at incomplete_details include truncation metadata";
                    let mut result=serde_json::Map::new(); let mut hidden=0;
                    for (key,v) in fields.iter().take(64) {
                        if allowed.split(' ').any(|k| k==key) { result.insert(key.clone(),visit(v,key,depth+1,left,truncated)); } else { hidden+=1; }
                    }
                    if hidden>0 { result.insert("_hidden_fields".into(),json!(hidden)); }
                    if fields.len()>64 { *truncated=true; }
                    Value::Object(result)
                }
                Value::Array(items) => { if items.len()>32 { *truncated=true; } Value::Array(items.iter().take(32).map(|v|visit(v,field,depth+1,left,truncated)).collect()) }
                Value::String(text) => {
                    let control=matches!(field,"type"|"role"|"status"|"effort"|"summary"|"tool_choice"|"finish_reason"|"object"|"include"|"truncation") && matches!(text.as_str(),"user"|"assistant"|"system"|"developer"|"message"|"input_text"|"output_text"|"text"|"function"|"function_call"|"function_call_output"|"reasoning"|"completed"|"in_progress"|"failed"|"incomplete"|"low"|"medium"|"high"|"minimal"|"none"|"auto"|"required"|"stop"|"length"|"response"|"chat.completion"|"chat.completion.chunk"|"response.created"|"response.completed"|"response.failed"|"response.incomplete"|"response.output_text.delta"|"response.output_item.added"|"response.output_item.done"|"response.function_call_arguments.delta"|"response.function_call_arguments.done"|"error"|"reasoning.encrypted_content"|"json_schema"|"json_object"|"string"|"number"|"integer"|"boolean"|"array"|"object"|"null");
                    let model=field=="model" && super::gateway::model_valid(text) && ["gpt-","o1","o3","o4"].iter().any(|prefix|text.starts_with(prefix));
                    if control || model { json!(text) } else { json!(format!("[内容已隐藏，{} 字符]",text.chars().count())) }
                }
                Value::Number(_) if matches!(field,"max_output_tokens"|"max_tokens"|"temperature"|"top_p"|"input_tokens"|"output_tokens"|"total_tokens"|"cached_tokens"|"reasoning_tokens"|"sequence_number"|"output_index"|"content_index"|"index"|"created_at") => value.clone(),
                Value::Bool(_) if matches!(field,"stream"|"store"|"strict"|"parallel_tool_calls"|"additionalProperties") => value.clone(),
                Value::Null=>Value::Null,
                _=>json!("[内容已隐藏]"),
            }
        }
        visit(value,"",0,&mut 256,&mut self.truncated)
    }
    pub fn event(&mut self, value: &serde_json::Value) {
        self.event_count+=1;
        if self.events.len()<12 { let clean=self.sanitize(value); self.events.push(clean); }
        else { self.truncated=true; if value.get("type").and_then(serde_json::Value::as_str).is_some_and(|v|matches!(v,"response.completed"|"response.failed"|"response.incomplete"|"error")) { let clean=self.sanitize(value); self.events[11]=clean; } }
    }
}
pub struct Controls {
    pub settings: GatewaySettings,
    pub generation: u64,
    pub logs: VecDeque<CallLog>,
    pub retained_bytes: usize,
    pub quotas: HashMap<i64, super::QuotaSnapshot>,
}
impl Default for Controls {
    fn default() -> Self { Self { settings: GatewaySettings::default(), generation: 0, logs: VecDeque::new(), retained_bytes: 0, quotas: HashMap::new() } }
}
impl Controls {
    pub fn record(&mut self, generation: Option<u64>, mut entry: CallLog) {
        if !self.settings.logging_enabled || generation != Some(self.generation) { return; }
        entry.detail_bytes=serde_json::to_vec(&entry.detail).map(|v|v.len()).unwrap_or(0);
        while self.logs.len()>=500 || self.retained_bytes+entry.detail_bytes>8*1024*1024 {
            if let Some(old)=self.logs.pop_front() { self.retained_bytes=self.retained_bytes.saturating_sub(old.detail_bytes); } else { return; }
        }
        self.retained_bytes+=entry.detail_bytes;
        self.logs.push_back(entry);
    }
    pub fn apply(&mut self, settings: GatewaySettings) {
        if self.settings.logging_enabled != settings.logging_enabled { self.generation = self.generation.wrapping_add(1); }
        self.settings = settings;
    }
    pub fn clear(&mut self) { self.generation = self.generation.wrapping_add(1); self.logs.clear(); self.retained_bytes=0; }
}

// Quota is a cached snapshot, never fabricated after a reset or stale refresh.
pub fn remaining(quota: &super::QuotaSnapshot, now_ms: i64) -> Option<f64> {
    let age = now_ms.checked_sub(quota.fetched_at?)?;
    if !(0..=15 * 60 * 1000).contains(&age) || quota.windows.is_empty() { return None; }
    if quota.windows.iter().any(|w| !w.used_percent.is_finite() || !(0.0..=100.0).contains(&w.used_percent) || w.resets_at.is_some_and(|reset| reset <= now_ms / 1000)) { return None; }
    quota.windows.iter().map(|w| 100.0 - w.used_percent).reduce(f64::min)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_structure_hides_credentials_and_bounds_events() {
        let mut detail=CallDetail::default();
        let source=serde_json::json!({"authorization":"fake-secret","instructions":"fake-secret","input":[{"role":"user","content":[{"type":"input_text","text":"fake-secret"}]}],"arguments":{"input_tokens":12345},"metadata":{"private":"fake-secret"},"stream":true,"usage":{"input_tokens":12,"output_tokens":4}});
        let clean=detail.sanitize(&source);
        let text=clean.to_string(); assert!(!text.contains("fake-secret")); assert!(!text.contains("12345")); assert!(!text.contains("authorization"));
        assert_eq!(clean["stream"],true); assert_eq!(clean["usage"]["input_tokens"],12); assert_eq!(clean["input"][0]["role"],"user");
        for _ in 0..100 { detail.event(&serde_json::json!({"type":"response.output_text.delta","delta":"fake-secret"})); }
        detail.event(&serde_json::json!({"type":"response.completed","response":{"status":"completed"}}));
        assert_eq!(detail.events.len(),12); assert_eq!(detail.event_count,101); assert!(detail.truncated); assert_eq!(detail.events[11]["type"],"response.completed");
        assert!(!serde_json::to_string(&detail).unwrap().contains("fake-secret"));
        let mut oversized=serde_json::json!(null); for _ in 0..20 { oversized=serde_json::json!({"input":oversized}); }
        let _=detail.sanitize(&oversized); assert!(detail.truncated);
        let mut summary=entry(); summary.detail=detail; assert!(!serde_json::to_string(&summary).unwrap().contains("events"));
    }
    #[test]
    fn diagnostic_memory_budget_evicts_and_clear_releases_bytes() {
        let mut c=Controls::default(); c.apply(GatewaySettings {logging_enabled:true,..Default::default()});
        let mut log=entry(); log.detail.response=Some(serde_json::json!("x".repeat(64000)));
        for _ in 0..500 { c.record(Some(c.generation),log.clone()); }
        assert!(c.logs.len()<500); assert!(c.retained_bytes<=8*1024*1024);
        c.clear(); assert_eq!(c.retained_bytes,0);
    }
    #[test]
    fn quota_uses_limiting_window_and_treats_expired_or_invalid_data_as_unknown() {
        let mut q = super::super::QuotaSnapshot { fetched_at:Some(1000000), windows:vec![super::super::QuotaWindow {name:"test".into(),used_percent:70.0,window_minutes:Some(300),resets_at:Some(2000)},super::super::QuotaWindow {name:"test2".into(),used_percent:20.0,window_minutes:Some(10080),resets_at:None}] };
        assert_eq!(remaining(&q,1000000),Some(30.0));
        assert_eq!(remaining(&q,2000000),None);
        q.windows[0].resets_at=Some(1000);assert_eq!(remaining(&q,1000000),None);
        q.windows[0].resets_at=None;q.windows[0].used_percent=f64::NAN;assert_eq!(remaining(&q,1000000),None);
    }
    fn entry() -> CallLog { CallLog { id: "test-id".into(), timestamp: 0, endpoint: "/v1/responses", model: Some("gpt-test".into()), account_id: Some(1), status: 200, upstream_status: Some(200), outcome: "completed", streaming: true, duration_ms: 1, input_tokens: None, output_tokens: None, detail: CallDetail::default(), detail_bytes: 0 } }
    #[test]
    fn logs_are_bounded_and_disabled_or_cleared_requests_cannot_reappear() {
        let mut c = Controls::default(); c.record(Some(0), entry()); assert!(c.logs.is_empty());
        c.apply(GatewaySettings { logging_enabled: true, ..Default::default() });
        let generation = Some(c.generation);
        for _ in 0..510 { c.record(generation, entry()); } assert_eq!(c.logs.len(), 500);
        c.clear(); c.record(generation, entry()); assert!(c.logs.is_empty());
        c.apply(GatewaySettings::default()); c.record(Some(c.generation), entry()); assert!(c.logs.is_empty());
        let serialized = serde_json::to_string(&entry()).unwrap();
        for field in ["authorization", "prompt", "input\"", "arguments", "session", "headers"] { assert!(!serialized.contains(field)); }
    }
    #[test]
    fn settings_survive_reopen_and_invalid_values_do_not_replace_them() {
        let conn=Connection::open_in_memory().unwrap(); conn.execute_batch(SCHEMA).unwrap();
        let s=GatewaySettings { logging_enabled:true, strategy:RoutingStrategy::QuotaFirst, cooldown_seconds:120 };
        save(&conn,&s).unwrap(); assert_eq!(load(&conn).unwrap().strategy,RoutingStrategy::QuotaFirst);
        assert!(save(&conn,&GatewaySettings { cooldown_seconds:0,..s }).is_err());
        assert_eq!(load(&conn).unwrap().cooldown_seconds,120);
        assert!(serde_json::from_str::<GatewaySettings>(r#"{"loggingEnabled":false,"strategy":"unknown","cooldownSeconds":60}"#).is_err());
    }
}
