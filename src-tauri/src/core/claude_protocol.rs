//! Claude Code wire adapters. Tool definitions/results are data, never executed here.
use serde_json::{json, Value};
use super::claude_providers::ApiFormat;

fn text(value: &Value) -> String {
    if let Some(s) = value.as_str() { return s.to_string(); }
    value.as_array().into_iter().flatten().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n")
}

pub fn request(source: &Value, format: ApiFormat) -> Result<Value, String> {
    if format == ApiFormat::Anthropic { return Ok(source.clone()); }
    let messages = source["messages"].as_array().ok_or("messages 必须是数组")?;
    let mut chat = Vec::new();
    if source.get("system").is_some() { chat.push(json!({"role":"system","content":text(&source["system"])})); }
    for message in messages {
        let role = message["role"].as_str().filter(|r| matches!(*r,"user"|"assistant")).ok_or("消息角色无效")?;
        if message["content"].is_string() { chat.push(json!({"role":role,"content":message["content"]})); continue; }
        let mut parts = Vec::new();
        let mut tools = Vec::new();
        let mut results = Vec::new();
        for part in message["content"].as_array().ok_or("消息内容无效")? {
            match part["type"].as_str() {
                Some("text") => parts.push(json!({"type":"text","text":part["text"]})),
                Some("image") => {
                    let image = if part["source"]["type"] == "url" { part["source"]["url"].as_str().unwrap_or("").to_string() }
                        else { format!("data:{};base64,{}",part["source"]["media_type"].as_str().unwrap_or("image/png"),part["source"]["data"].as_str().ok_or("图片数据无效")?) };
                    parts.push(json!({"type":"image_url","image_url":{"url":image}}));
                }
                Some("tool_use") => tools.push(json!({"id":part["id"],"type":"function","function":{"name":part["name"],"arguments":serde_json::to_string(&part["input"]).map_err(|_|"工具参数无效")?}})),
                Some("tool_result") => results.push(json!({"role":"tool","tool_call_id":part["tool_use_id"],"content":text(&part["content"])})),
                Some("thinking"|"redacted_thinking") => {}
                _ => return Err("当前协议转换不支持此内容块，请使用 Anthropic 原生上游".into()),
            }
        }
        if !parts.is_empty() || !tools.is_empty() {
            let mut m = json!({"role":role,"content":if parts.is_empty(){Value::Null}else{json!(parts)}});
            if !tools.is_empty() { m["tool_calls"] = json!(tools); }
            chat.push(m);
        }
        if !results.is_empty() {
            let insertion=chat.len()-usize::from(!parts.is_empty());
            for (offset, result) in results.into_iter().enumerate(){chat.insert(insertion+offset,result);}
        }
    }
    let tools: Vec<_> = source["tools"].as_array().into_iter().flatten().map(|tool| {
        if tool["name"].as_str().is_none() || !tool["input_schema"].is_object() { return Err("当前上游不支持服务器工具定义".to_string()); }
        Ok(json!({"type":"function","function":{"name":tool["name"],"description":tool["description"].as_str().unwrap_or(""),"parameters":tool["input_schema"]}}))
    }).collect::<Result<_,_>>()?;
    let mut body = json!({"model":source["model"],"messages":chat,"stream":source["stream"].as_bool().unwrap_or(false)});
    for key in ["temperature","top_p","max_tokens"] { if let Some(v) = source.get(key) { body[key] = v.clone(); } }
    if let Some(stops) = source.get("stop_sequences") { body["stop"] = stops.clone(); }
    if !tools.is_empty() { body["tools"] = json!(tools); }
    if let Some(choice) = source.get("tool_choice") {
        body["tool_choice"] = match choice["type"].as_str() {
            Some("any") => json!("required"), Some("none") => json!("none"),
            Some("tool") => json!({"type":"function","function":{"name":choice["name"]}}),
            _ => json!("auto"),
        };
        if let Some(v) = choice.get("disable_parallel_tool_use").and_then(Value::as_bool) { body["parallel_tool_calls"] = json!(!v); }
    }
    match format {
        ApiFormat::OpenaiChat => {
            if body["stream"] == true { body["stream_options"] = json!({"include_usage":true}); }
            Ok(body)
        }
        ApiFormat::OpenaiResponses => {
            let mut input = Vec::new();
            for m in &chat {
                if m["role"] == "system" { continue; }
                if m["role"] == "tool" { input.push(json!({"type":"function_call_output","call_id":m["tool_call_id"],"output":m["content"]})); continue; }
                if m["content"].is_string() {
                    input.push(json!({"role":m["role"],"content":m["content"]}));
                } else if let Some(parts) = m["content"].as_array() {
                    let content: Vec<_> = parts.iter().map(|p| if p["type"] == "image_url" {
                        json!({"type":"input_image","image_url":p["image_url"]["url"]})
                    } else { json!({"type":if m["role"]=="assistant"{"output_text"}else{"input_text"},"text":p["text"]}) }).collect();
                    input.push(json!({"role":m["role"],"content":content}));
                }
                for call in m["tool_calls"].as_array().into_iter().flatten() {
                    input.push(json!({"type":"function_call","call_id":call["id"],"name":call["function"]["name"],"arguments":call["function"]["arguments"]}));
                }
            }
            let mut result = json!({"model":source["model"],"input":input,"stream":body["stream"],"store":false});
            if source.get("system").is_some() { result["instructions"] = json!(text(&source["system"])); }
            for key in ["temperature","top_p"] { if let Some(v)=body.get(key) {result[key]=v.clone();} }
            if let Some(v)=body.get("max_tokens") {result["max_output_tokens"]=v.clone();}
            if !tools.is_empty() { result["tools"]=json!(tools.iter().map(|t| json!({"type":"function","name":t["function"]["name"],"description":t["function"]["description"],"parameters":t["function"]["parameters"]})).collect::<Vec<_>>()); }
            if let Some(choice)=body.get("tool_choice") {
                result["tool_choice"]=if choice.is_object(){json!({"type":"function","name":choice["function"]["name"]})}else{choice.clone()};
            }
            Ok(result)
        }
        ApiFormat::Gemini => {
            let mut contents = Vec::new();
            for m in &chat {
                if m["role"] == "system" { continue; }
                let mut parts = Vec::new();
                if m["role"] == "tool" {
                    let id=m["tool_call_id"].as_str().unwrap_or("");
                    let name=chat.iter().flat_map(|m|m["tool_calls"].as_array().into_iter().flatten()).find(|c|c["id"]==id).and_then(|c|c["function"]["name"].as_str()).unwrap_or(id);
                    parts.push(json!({"functionResponse":{"name":name,"response":{"result":m["content"]}}}));
                } else if m["content"].is_string() { parts.push(json!({"text":m["content"]})); }
                else {
                    for p in m["content"].as_array().into_iter().flatten() {
                        if p["type"] == "text" {parts.push(json!({"text":p["text"]}));}
                        else if let Some(url)=p["image_url"]["url"].as_str() {
                            let (kind,data)=url.strip_prefix("data:").and_then(|s|s.split_once(";base64,")).ok_or("Gemini 转换仅支持内嵌图片")?;
                            parts.push(json!({"inlineData":{"mimeType":kind,"data":data}}));
                        }
                    }
                }
                for c in m["tool_calls"].as_array().into_iter().flatten() {
                    parts.push(json!({"functionCall":{"name":c["function"]["name"],"args":serde_json::from_str::<Value>(c["function"]["arguments"].as_str().unwrap_or("{}")).map_err(|_|"工具参数不是 JSON")?}}));
                }
                contents.push(json!({"role":if m["role"]=="assistant"{"model"}else{"user"},"parts":parts}));
            }
            let mut result=json!({"contents":contents,"generationConfig":{}});
            if source.get("system").is_some(){result["systemInstruction"]=json!({"parts":[{"text":text(&source["system"])}]});}
            for (from,to) in [("max_tokens","maxOutputTokens"),("temperature","temperature"),("top_p","topP"),("stop_sequences","stopSequences")] {
                if let Some(v)=source.get(from){result["generationConfig"][to]=v.clone();}
            }
            if !tools.is_empty(){result["tools"]=json!([{"functionDeclarations":tools.iter().map(|t|&t["function"]).collect::<Vec<_>>()}]);}
            if let Some(choice)=source.get("tool_choice"){
                let mode=match choice["type"].as_str(){Some("none")=>"NONE",Some("any"|"tool")=>"ANY",_=>"AUTO"};
                result["toolConfig"]=json!({"functionCallingConfig":{"mode":mode}});
                if choice["type"]=="tool"{result["toolConfig"]["functionCallingConfig"]["allowedFunctionNames"]=json!([choice["name"]]);}
            }
            Ok(result)
        }
        ApiFormat::Anthropic => unreachable!(),
    }
}

pub fn usage(v:&Value,format:ApiFormat)->Value {
    let u=if format==ApiFormat::Gemini{&v["usageMetadata"]}else{&v["usage"]};
    json!({"input_tokens":u["input_tokens"].as_u64().or_else(||u["prompt_tokens"].as_u64()).or_else(||u["promptTokenCount"].as_u64()).unwrap_or(0),
        "output_tokens":u["output_tokens"].as_u64().or_else(||u["completion_tokens"].as_u64()).or_else(||u["candidatesTokenCount"].as_u64()).unwrap_or(0),
        "cache_read_input_tokens":u["cache_read_input_tokens"].as_u64().or_else(||u["prompt_tokens_details"]["cached_tokens"].as_u64()).or_else(||u["input_tokens_details"]["cached_tokens"].as_u64()).or_else(||u["cachedContentTokenCount"].as_u64()).unwrap_or(0)})
}

pub fn response(v:&Value,format:ApiFormat,model:&str)->Result<Value,String>{
    if format==ApiFormat::Anthropic {return Ok(v.clone());}
    let mut content=Vec::new();
    let mut stop="end_turn";
    match format {
        ApiFormat::OpenaiChat=>{
            let c=v["choices"].get(0).ok_or("上游没有返回有效结果")?;
            let m=&c["message"];
            if let Some(t)=m["reasoning_content"].as_str(){content.push(json!({"type":"thinking","thinking":t}));}
            if let Some(t)=m["content"].as_str(){content.push(json!({"type":"text","text":t}));}
            for c in m["tool_calls"].as_array().into_iter().flatten(){
                content.push(json!({"type":"tool_use","id":c["id"],"name":c["function"]["name"],"input":serde_json::from_str::<Value>(c["function"]["arguments"].as_str().unwrap_or("{}")).map_err(|_|"上游工具参数无效")?}));
                stop="tool_use";
            }
            if c["finish_reason"]=="length"{stop="max_tokens";}
        }
        ApiFormat::OpenaiResponses=>{
            for item in v["output"].as_array().ok_or("上游没有返回有效结果")?{
                if item["type"]=="function_call"{
                    content.push(json!({"type":"tool_use","id":item["call_id"],"name":item["name"],"input":serde_json::from_str::<Value>(item["arguments"].as_str().unwrap_or("{}")).map_err(|_|"上游工具参数无效")?}));stop="tool_use";
                }
                for p in item["content"].as_array().into_iter().flatten(){if let Some(t)=p["text"].as_str(){content.push(json!({"type":"text","text":t}));}}
            }
            if v["status"]=="incomplete"{stop="max_tokens";}
        }
        ApiFormat::Gemini=>{
            let c=v["candidates"].get(0).ok_or("上游没有返回有效结果")?;
            for p in c["content"]["parts"].as_array().into_iter().flatten(){
                if let Some(t)=p["text"].as_str(){content.push(if p["thought"]==true{json!({"type":"thinking","thinking":t})}else{json!({"type":"text","text":t})});}
                if p["functionCall"].is_object(){content.push(json!({"type":"tool_use","id":format!("toolu_{}",uuid::Uuid::new_v4()),"name":p["functionCall"]["name"],"input":p["functionCall"]["args"]}));stop="tool_use";}
            }
            if c["finishReason"]=="MAX_TOKENS"{stop="max_tokens";}
        }
        _=>unreachable!(),
    }
    Ok(json!({"id":format!("msg_{}",uuid::Uuid::new_v4()),"type":"message","role":"assistant","model":model,"content":content,"stop_reason":stop,"stop_sequence":null,"usage":usage(v,format)}))
}

pub fn sse(event:&Value)->Vec<u8>{
    format!("event: {}\ndata: {}\n\n",event["type"].as_str().unwrap_or("message"),event).into_bytes()
}

/// Stateful stream conversion preserves tool indices and fragmented arguments.
pub struct Stream {
    model:String,
    started:bool,
    ended:bool,
    blocks:Vec<(String,usize)>,
    pub tokens:Value,
    tool:bool,
    stop:String,
}
impl Stream{
    pub fn new(model:&str)->Self{Self{model:model.into(),started:false,ended:false,blocks:Vec::new(),tokens:json!({"input_tokens":0,"output_tokens":0}),tool:false,stop:"end_turn".into()}}
    fn start(&mut self,out:&mut Vec<Value>){
        if !self.started{self.started=true;out.push(json!({"type":"message_start","message":{"id":format!("msg_{}",uuid::Uuid::new_v4()),"type":"message","role":"assistant","content":[],"model":self.model,"stop_reason":null,"stop_sequence":null,"usage":self.tokens}}));}
    }
    fn delta(&mut self,key:String,block:Value,delta:Value,out:&mut Vec<Value>){
        let index=if let Some((_,i))=self.blocks.iter().find(|(k,_)|*k==key){*i}else{
            let i=self.blocks.len();self.blocks.push((key,i));out.push(json!({"type":"content_block_start","index":i,"content_block":block}));i
        };
        out.push(json!({"type":"content_block_delta","index":index,"delta":delta}));
    }
    pub fn feed(&mut self,v:&Value,format:ApiFormat)->Result<Vec<Value>,String>{
        if self.ended{return Ok(Vec::new());}
        if v.get("error").is_some() || v["type"]=="error" || v["type"]=="response.failed" {return Err("上游流式请求失败".into());}
        let mut out=Vec::new();self.start(&mut out);
        let tokens=usage(if v["type"]=="response.completed"||v["type"]=="response.incomplete"{&v["response"]}else{v},format);
        for k in ["input_tokens","output_tokens","cache_read_input_tokens"] {if tokens[k].as_u64().unwrap_or(0)>0{self.tokens[k]=tokens[k].clone();}}
        match format{
            ApiFormat::OpenaiChat=>{
                for c in v["choices"].as_array().into_iter().flatten(){
                    let d=&c["delta"];
                    if let Some(t)=d["content"].as_str(){self.delta("text".into(),json!({"type":"text","text":""}),json!({"type":"text_delta","text":t}),&mut out);}
                    if let Some(t)=d["reasoning_content"].as_str().or_else(||d["reasoning"].as_str()){self.delta("thinking".into(),json!({"type":"thinking","thinking":""}),json!({"type":"thinking_delta","thinking":t}),&mut out);}
                    for call in d["tool_calls"].as_array().into_iter().flatten(){
                        self.tool=true;
                        self.delta(format!("tool-{}",call["index"].as_u64().unwrap_or(0)),json!({"type":"tool_use","id":call["id"],"name":call["function"]["name"],"input":{}}),json!({"type":"input_json_delta","partial_json":call["function"]["arguments"].as_str().unwrap_or("")}),&mut out);
                    }
                    if c["finish_reason"]=="length"{self.stop="max_tokens".into();}
                }
            }
            ApiFormat::OpenaiResponses=>{
                match v["type"].as_str(){
                    Some("response.output_text.delta")=>self.delta(format!("text-{}",v["output_index"]),json!({"type":"text","text":""}),json!({"type":"text_delta","text":v["delta"]}),&mut out),
                    Some("response.reasoning_summary_text.delta")=>self.delta("thinking".into(),json!({"type":"thinking","thinking":""}),json!({"type":"thinking_delta","thinking":v["delta"]}),&mut out),
                    Some("response.output_item.added") if v["item"]["type"]=="function_call"=>{
                        self.tool=true;self.delta(format!("tool-{}",v["output_index"]),json!({"type":"tool_use","id":v["item"]["call_id"],"name":v["item"]["name"],"input":{}}),json!({"type":"input_json_delta","partial_json":""}),&mut out);
                    }
                    Some("response.function_call_arguments.delta")=>self.delta(format!("tool-{}",v["output_index"]),json!({"type":"tool_use","id":v["item_id"],"name":"","input":{}}),json!({"type":"input_json_delta","partial_json":v["delta"]}),&mut out),
                    Some("response.incomplete")=>self.stop="max_tokens".into(),
                    _=>{}
                }
            }
            ApiFormat::Gemini=>{
                for p in v["candidates"][0]["content"]["parts"].as_array().into_iter().flatten(){
                    if let Some(t)=p["text"].as_str(){
                        if p["thought"]==true{self.delta("thinking".into(),json!({"type":"thinking","thinking":""}),json!({"type":"thinking_delta","thinking":t}),&mut out);}
                        else{self.delta("text".into(),json!({"type":"text","text":""}),json!({"type":"text_delta","text":t}),&mut out);}
                    }
                    if p["functionCall"].is_object(){
                        self.tool=true;self.delta(format!("tool-{}",self.blocks.len()),json!({"type":"tool_use","id":format!("toolu_{}",uuid::Uuid::new_v4()),"name":p["functionCall"]["name"],"input":{}}),json!({"type":"input_json_delta","partial_json":p["functionCall"]["args"].to_string()}),&mut out);
                    }
                }
                if v["candidates"][0]["finishReason"]=="MAX_TOKENS"{self.stop="max_tokens".into();}
            }
            _=>{}
        }
        Ok(out)
    }
    pub fn finish(&mut self)->Vec<Value>{
        if self.ended{return Vec::new();}
        let mut out=Vec::new();self.start(&mut out);self.ended=true;
        for (_,i) in &self.blocks{out.push(json!({"type":"content_block_stop","index":i}));}
        out.push(json!({"type":"message_delta","delta":{"stop_reason":if self.tool&&self.stop!="max_tokens"{"tool_use"}else{&self.stop},"stop_sequence":null},"usage":self.tokens}));
        out.push(json!({"type":"message_stop"}));out
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn tools_images_and_results_are_mapped_without_execution(){
        let v=json!({"model":"m","max_tokens":100,"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"c","name":"read","input":{"path":"a"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"c","content":[{"type":"text","text":"hello"}]}]}],"tools":[{"name":"read","input_schema":{"type":"object"}}]});
        let chat=request(&v,ApiFormat::OpenaiChat).unwrap();
        assert_eq!(chat["messages"][1]["role"],"tool");
        let r=request(&v,ApiFormat::OpenaiResponses).unwrap();
        assert_eq!(r["input"][0]["type"],"function_call");
        assert_eq!(r["input"][1]["type"],"function_call_output");
        assert!(request(&v,ApiFormat::Gemini).unwrap()["contents"][1]["parts"][0]["functionResponse"].is_object());
    }
    #[test]
    fn streaming_tool_arguments_keep_the_same_block(){
        let mut s=Stream::new("m");
        let first=s.feed(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t","function":{"name":"f","arguments":"{"}}]}}]}),ApiFormat::OpenaiChat).unwrap();
        let second=s.feed(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}],"usage":{"prompt_tokens":4,"completion_tokens":2}}),ApiFormat::OpenaiChat).unwrap();
        assert_eq!(first.iter().filter(|v|v["type"]=="content_block_start").count(),1);
        assert!(second.iter().all(|v|v["type"]!="content_block_start"));
        let end=s.finish();assert_eq!(end[end.len()-2]["delta"]["stop_reason"],"tool_use");assert_eq!(s.tokens["input_tokens"],4);
    }
}
