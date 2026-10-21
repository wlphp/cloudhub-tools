//! Responses client -> Chat Completions provider. Functions are never executed here.
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn request(bytes:&[u8],models:&[String])->Result<(Value,bool),String> {
    let mut source:Value=serde_json::from_slice(bytes).map_err(|_| "供应商请求 JSON 无效")?;
    let model=source["model"].as_str().filter(|v|models.iter().any(|m|m==v)).ok_or("模型不在供应商目录中")?.to_owned();
    // Reuse strict Responses content/tool validation, without the official
    // route's narrower model-ID alphabet.
    source["model"]=json!("provider-model");
    let (mut body,stream)=super::responses::normalize(&serde_json::to_vec(&source).map_err(|_| "供应商请求无效")?)?;
    body["model"]=json!(model);
    let mut messages=Vec::new();
    if let Some(instructions)=body["instructions"].as_str() {messages.push(json!({"role":"system","content":instructions}));}
    for row in body["input"].as_array().ok_or("供应商输入无效")? {
        match row["type"].as_str() {
            Some("function_call")=> {
                let call=json!({"id":row["call_id"],"type":"function","function":{"name":row["name"],"arguments":row["arguments"]}});
                if let Some(last)=messages.last_mut().filter(|v|v["role"]=="assistant" && v["tool_calls"].is_array()) {
                    last["tool_calls"].as_array_mut().ok_or("函数历史无效")?.push(call);
                } else {messages.push(json!({"role":"assistant","content":null,"tool_calls":[call]}));}
            }
            Some("function_call_output")=>messages.push(json!({"role":"tool","tool_call_id":row["call_id"],"content":row["output"]})),
            Some("reasoning")=>{},
            None|Some("message")=> {
                let mut parts=Vec::new();
                for part in row["content"].as_array().ok_or("消息内容无效")? {
                    if part["type"]=="input_image" {parts.push(json!({"type":"image_url","image_url":{"url":part["image_url"],"detail":part.get("detail").cloned().unwrap_or(json!("auto"))}}));}
                    else {parts.push(json!({"type":"text","text":part["text"]}));}
                }
                messages.push(json!({"role":if row["role"]=="developer" {json!("system")}else{row["role"].clone()},"content":parts}));
            }
            _=>return Err("Chat 转换不支持此输入类型".into()),
        }
    }
    let mut result=json!({"model":model,"messages":messages,"stream":stream});
    for key in ["temperature","top_p","parallel_tool_calls","service_tier"] {if let Some(v)=body.get(key) {result[key]=v.clone();}}
    if let Some(v)=body.get("max_output_tokens") {result["max_completion_tokens"]=v.clone();}
    if let Some(effort)=body["reasoning"]["effort"].as_str() {result["reasoning_effort"]=json!(effort);}
    if let Some(tools)=body["tools"].as_array().filter(|v|!v.is_empty()) {
        result["tools"]=json!(tools.iter().map(|t|{let mut f=t.clone();f.as_object_mut().unwrap().remove("type");json!({"type":"function","function":f})}).collect::<Vec<_>>());
    }
    if let Some(choice)=body.get("tool_choice") {result["tool_choice"]=if choice.is_string(){choice.clone()}else{json!({"type":"function","function":{"name":choice["name"]}})};}
    if let Some(format)=body["text"].get("format") {
        result["response_format"]=if format["type"]=="json_schema" {let mut schema=format.clone();schema.as_object_mut().unwrap().remove("type");json!({"type":"json_schema","json_schema":schema})} else {format.clone()};
    }
    if stream {result["stream_options"]=json!({"include_usage":true});}
    Ok((result,stream))
}

pub struct ChatStream {
    id:String,model:String,sequence:u64,output:Vec<Value>,text:Option<usize>,tools:BTreeMap<u64,usize>,
    finished:Option<String>,usage:Value,
}
impl ChatStream {
    pub fn new(model:&str)->Self {Self{id:format!("resp_{}",uuid::Uuid::new_v4()),model:model.into(),sequence:0,output:vec![],text:None,tools:BTreeMap::new(),finished:None,usage:json!({"input_tokens":0,"output_tokens":0,"total_tokens":0})}}
    fn event(&mut self,mut value:Value)->Value {value["sequence_number"]=json!(self.sequence);self.sequence+=1;value}
    pub fn response(&self,status:&str)->Value {
        json!({"id":self.id,"object":"response","created_at":chrono::Utc::now().timestamp(),"model":self.model,"status":status,"output":self.output,"usage":self.usage,"error":null,"incomplete_details":if status=="incomplete"{json!({"reason":"max_output_tokens"})}else{Value::Null}})
    }
    pub fn start(&mut self)->Vec<Value> {
        let response=self.response("in_progress");
        vec![self.event(json!({"type":"response.created","response":response})),self.event(json!({"type":"response.in_progress","response":response}))]
    }
    pub fn feed(&mut self,value:&Value)->Result<Vec<Value>,String> {
        if value.get("error").is_some() {return Err("上游流式请求失败".into());}
        if let Some(usage)=value.get("usage").filter(|v|v.is_object()) {
            let input=usage["prompt_tokens"].as_u64().unwrap_or(0);let output=usage["completion_tokens"].as_u64().unwrap_or(0);
            self.usage=json!({"input_tokens":input,"output_tokens":output,"total_tokens":input.saturating_add(output)});
        }
        let choices=value["choices"].as_array().ok_or("上游 Chat 流格式无效")?;
        if choices.len()>1 {return Err("上游返回了多个候选".into());}
        let Some(choice)=choices.first() else{return Ok(vec![]);};
        if self.finished.is_some() {return Err("上游在结束标记后继续返回候选".into());}
        let delta=&choice["delta"];
        let mut events=Vec::new();
        if let Some(text)=delta["content"].as_str().filter(|v|!v.is_empty()) {
            let index=if let Some(index)=self.text{index}else{
                let index=self.output.len();self.text=Some(index);
                let item=json!({"id":format!("msg_{}",uuid::Uuid::new_v4()),"type":"message","status":"in_progress","role":"assistant","content":[]});self.output.push(item.clone());
                events.push(self.event(json!({"type":"response.output_item.added","output_index":index,"item":item})));
                let part=json!({"type":"output_text","text":"","annotations":[]});self.output[index]["content"]=json!([part]);
                events.push(self.event(json!({"type":"response.content_part.added","item_id":self.output[index]["id"],"output_index":index,"content_index":0,"part":part})));index
            };
            let previous=self.output[index]["content"][0]["text"].as_str().unwrap_or("").to_string();
            self.output[index]["content"][0]["text"]=json!(previous+text);
            events.push(self.event(json!({"type":"response.output_text.delta","item_id":self.output[index]["id"],"output_index":index,"content_index":0,"delta":text})));
        }
        for tool in delta["tool_calls"].as_array().into_iter().flatten() {
            let tool_index=tool["index"].as_u64().filter(|v|*v<128).ok_or("上游工具索引无效")?;
            let index=if let Some(index)=self.tools.get(&tool_index){*index}else{
                let call_id=tool["id"].as_str().filter(|v|!v.is_empty()&&v.len()<=256&&!v.chars().any(char::is_control)).ok_or("上游工具标识无效")?;
                let name=tool["function"]["name"].as_str().filter(|v|!v.is_empty()&&v.len()<=128&&v.bytes().all(|b|b.is_ascii_alphanumeric()||b"._-".contains(&b))).ok_or("上游工具名称无效")?;
                let index=self.output.len();self.tools.insert(tool_index,index);
                let item=json!({"id":format!("fc_{}",uuid::Uuid::new_v4()),"type":"function_call","status":"in_progress","call_id":call_id,"name":name,"arguments":""});self.output.push(item.clone());
                events.push(self.event(json!({"type":"response.output_item.added","output_index":index,"item":item})));index
            };
            if tool["id"].as_str().is_some_and(|id|self.output[index]["call_id"]!=id) || tool["function"]["name"].as_str().is_some_and(|name|self.output[index]["name"]!=name) {return Err("上游工具身份发生变化".into());}
            if let Some(arguments)=tool["function"]["arguments"].as_str().filter(|v|!v.is_empty()) {
                let previous=self.output[index]["arguments"].as_str().unwrap_or("").to_string();
                if previous.len()+arguments.len()>512*1024 {return Err("上游工具参数超过限制".into());}
                self.output[index]["arguments"]=json!(previous+arguments);
                events.push(self.event(json!({"type":"response.function_call_arguments.delta","item_id":self.output[index]["id"],"output_index":index,"delta":arguments})));
            }
        }
        if let Some(reason)=choice["finish_reason"].as_str() {
            if !matches!(reason,"stop"|"tool_calls"|"length") {return Err("上游未正常完成请求".into());}
            self.finished=Some(reason.into());
        }
        Ok(events)
    }
    pub fn finish(&mut self)->Result<Vec<Value>,String> {
        let reason=self.finished.clone().ok_or("上游流提前结束")?;
        let incomplete=reason=="length";
        if self.output.is_empty() && !incomplete {return Err("上游没有返回内容".into());}
        let mut events=Vec::new();
        for index in 0..self.output.len() {
            if self.output[index]["type"]=="function_call" {
                let arguments=self.output[index]["arguments"].as_str().unwrap_or("");
                if !incomplete && !serde_json::from_str::<Value>(arguments).is_ok_and(|v|v.is_object()) {return Err("上游工具参数不是完整 JSON".into());}
                events.push(self.event(json!({"type":"response.function_call_arguments.done","item_id":self.output[index]["id"],"output_index":index,"arguments":arguments})));
            } else {
                let part=self.output[index]["content"][0].clone();
                events.push(self.event(json!({"type":"response.output_text.done","item_id":self.output[index]["id"],"output_index":index,"content_index":0,"text":part["text"]})));
                events.push(self.event(json!({"type":"response.content_part.done","item_id":self.output[index]["id"],"output_index":index,"content_index":0,"part":part})));
            }
            self.output[index]["status"]=json!(if incomplete{"incomplete"}else{"completed"});
            events.push(self.event(json!({"type":"response.output_item.done","output_index":index,"item":self.output[index]})));
        }
        let status=if incomplete{"incomplete"}else{"completed"};
        events.push(self.event(json!({"type":format!("response.{status}"),"response":self.response(status)})));
        Ok(events)
    }
    pub fn from_completion(value:&Value,model:&str)->Result<Value,String> {
        let choices=value["choices"].as_array().filter(|v|v.len()==1).ok_or("上游 Chat 响应无效")?;
        let mut message=choices[0]["message"].clone();
        if let Some(tools)=message["tool_calls"].as_array_mut(){for (index,tool) in tools.iter_mut().enumerate(){
            let tool=tool.as_object_mut().ok_or("上游工具条目无效")?;
            tool.insert("index".into(),json!(index));
        }}
        let mut state=Self::new(model);
        state.feed(&json!({"choices":[{"delta":message,"finish_reason":choices[0]["finish_reason"]}],"usage":value["usage"]}))?;
        state.finish()?;
        Ok(state.response(if choices[0]["finish_reason"]=="length"{"incomplete"}else{"completed"}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requests_preserve_tools_results_models_and_limits() {
        let source=json!({"model":"org/model","stream":true,"store":false,"input":[{"type":"function_call","call_id":"c","name":"read","arguments":"{}"},{"type":"function_call_output","call_id":"c","output":"result"}],"tools":[{"type":"function","name":"read","parameters":{"type":"object"},"strict":true}],"max_output_tokens":64});
        let (request,stream)=request(&serde_json::to_vec(&source).unwrap(),&["org/model".into()]).unwrap();
        assert!(stream);assert_eq!(request["model"],"org/model");assert_eq!(request["messages"].as_array().unwrap().iter().find(|v|v["role"]=="tool").unwrap()["tool_call_id"],"c");assert_eq!(request["tools"][0]["function"]["strict"],true);assert_eq!(request["max_completion_tokens"],64);
    }
    #[test]
    fn fragmented_tool_arguments_and_truncation_are_explicit() {
        let mut state=ChatStream::new("m");
        state.start();
        let first=state.feed(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"read","arguments":"{\"path\":"}}]}}]})).unwrap();
        let second=state.feed(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2}})).unwrap();
        assert_eq!(first.iter().filter(|v|v["type"]=="response.output_item.added").count(),1);assert!(second.iter().all(|v|v["type"]!="response.output_item.added"));
        let end=state.finish().unwrap();assert_eq!(end.last().unwrap()["response"]["usage"]["input_tokens"],4);assert_eq!(end.last().unwrap()["response"]["output"][0]["arguments"],"{\"path\":\"a\"}");
        let mut truncated=ChatStream::new("m"); truncated.feed(&json!({"choices":[{"delta":{"content":"partial"}}]})).unwrap(); assert!(truncated.finish().is_err());
    }

    #[test]
    fn malformed_completion_tools_return_errors_instead_of_panicking() {
        for tool in [Value::Null,json!(17),json!("invalid"),json!([])] {
            let body=json!({"choices":[{"message":{"tool_calls":[tool]},"finish_reason":"tool_calls"}]});
            assert!(ChatStream::from_completion(&body,"m").is_err());
        }
    }

    #[test]
    fn finished_stream_allows_usage_but_rejects_more_candidates() {
        let mut state=ChatStream::new("m");
        state.feed(&json!({"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]})).unwrap();
        state.feed(&json!({"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}})).unwrap();
        assert_eq!(state.finish().unwrap().last().unwrap()["response"]["usage"]["total_tokens"],5);
        assert!(state.feed(&json!({"choices":[{"delta":{"content":"unexpected"}}]})).is_err());
        assert_eq!(state.response("completed")["output"][0]["content"][0]["text"],"OK");
    }

    #[test]
    fn reasoning_exhausting_output_budget_remains_incomplete() {
        let body=json!({"choices":[{"message":{"content":null,"reasoning_content":"partial thinking"},"finish_reason":"length"}]});
        let response=ChatStream::from_completion(&body,"m").unwrap();
        assert_eq!(response["status"],"incomplete");
        assert_eq!(response["incomplete_details"]["reason"],"max_output_tokens");
        assert_eq!(response["output"],json!([]));
        let mut state=ChatStream::new("m");
        state.feed(&json!({"choices":[{"delta":{"reasoning_content":"partial thinking"},"finish_reason":"length"}]})).unwrap();
        assert_eq!(state.finish().unwrap().last().unwrap()["type"],"response.incomplete");
    }
}
