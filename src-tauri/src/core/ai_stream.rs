use serde_json::{json, Value};

/// Bounded SSE framing. No partial model text is sent to the UI before validation.
pub struct Collector {
    protocol: String,
    buffer: Vec<u8>,
    data: Vec<String>,
    data_bytes: usize,
    pub finished: bool,
    text: String,
    reason: Option<String>,
    input: Option<u64>,
    output: Option<u64>,
    response: Option<Value>,
    events: usize,
}
impl Collector {
    pub fn new(protocol: &str) -> Self {
        Self {
            protocol: protocol.into(),
            buffer: vec![],
            data: vec![],
            data_bytes: 0,
            finished: false,
            text: String::new(),
            reason: None,
            input: None,
            output: None,
            response: None,
            events: 0,
        }
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > 524_288 {
            return Err("AI流式事件超过大小限制".into());
        }
        let mut consumed = 0;
        let mut lines = Vec::new();
        for (index, byte) in self.buffer.iter().enumerate() {
            if *byte == b'\n' {
                let line = std::str::from_utf8(&self.buffer[consumed..index])
                    .map_err(|_| "AI流式文本编码无效")?
                    .trim_end_matches('\r')
                    .to_string();
                lines.push(line);
                consumed = index + 1;
            }
        }
        self.buffer.drain(..consumed);
        for line in lines {
            if self.finished {
                break;
            }
            self.line(&line)?;
        }
        Ok(())
    }
    fn line(&mut self, line: &str) -> Result<(), String> {
        if line.is_empty() {
            if self.data.is_empty() {
                return Ok(());
            }
            let data = self.data.join("\n");
            self.data.clear();
            self.data_bytes = 0;
            self.event(&data)?;
        } else if let Some(data) = line.strip_prefix("data:") {
            let data = data.strip_prefix(' ').unwrap_or(data);
            self.data_bytes += data.len();
            if self.data_bytes > 524_288 || self.data.len() >= 128 {
                return Err("AI流式事件超过大小限制".into());
            }
            self.data.push(data.into());
        }
        Ok(())
    }
    fn append(&mut self, text: &str) -> Result<(), String> {
        if self.text.len() + text.len() > 524_288 {
            return Err("AI流式结果超过大小限制".into());
        }
        self.text.push_str(text);
        Ok(())
    }
    fn event(&mut self, data: &str) -> Result<(), String> {
        self.events += 1;
        if self.events > 20_000 {
            return Err("AI流式事件数量超过限制".into());
        }
        if data == "[DONE]" {
            if self.protocol != "openai_chat" || self.reason.as_deref() != Some("stop") {
                return Err("AI流式响应未完整结束".into());
            }
            self.finished = true;
            return Ok(());
        }
        let value: Value = serde_json::from_str(data).map_err(|_| "AI流式事件格式无效")?;
        if value.get("error").is_some() {
            return Err("AI流式服务返回错误，请重试".into());
        }
        match self.protocol.as_str() {
            "openai_chat" => {
                if let Some(usage) = value.get("usage") {
                    self.input = usage
                        .get("prompt_tokens")
                        .and_then(Value::as_u64)
                        .or(self.input);
                    self.output = usage
                        .get("completion_tokens")
                        .and_then(Value::as_u64)
                        .or(self.output);
                }
                if let Some(choice) = value.pointer("/choices/0") {
                    if choice.pointer("/delta/tool_calls").is_some()
                        || choice.pointer("/delta/function_call").is_some()
                        || choice
                            .pointer("/delta/refusal")
                            .is_some_and(|v| !v.is_null() && v.as_str() != Some(""))
                    {
                        return Err("AI流式响应包含拒绝或未授权工具".into());
                    }
                    if let Some(text) = choice.pointer("/delta/content").and_then(Value::as_str) {
                        self.append(text)?;
                    }
                    if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                        if reason != "stop" {
                            return Err("AI流式响应未完整结束".into());
                        }
                        self.reason = Some(reason.into());
                    }
                }
            }
            "openai_responses" => match value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "response.output_text.delta" => {
                    if let Some(text) = value.get("delta").and_then(Value::as_str) {
                        self.append(text)?;
                    }
                }
                "response.completed" => {
                    let response = value.get("response").ok_or("AI流式完成事件无效")?;
                    if response.get("status").and_then(Value::as_str) != Some("completed") {
                        return Err("AI流式响应未完整结束".into());
                    }
                    self.response = Some(response.clone());
                    self.finished = true;
                }
                "response.output_item.added" => {
                    if value
                        .pointer("/item/type")
                        .and_then(Value::as_str)
                        .is_some_and(|t| t != "message" && t != "reasoning")
                    {
                        return Err("AI流式响应包含拒绝或未授权工具".into());
                    }
                }
                "response.refusal.delta" | "response.failed" | "response.incomplete" | "error" => {
                    return Err("AI流式服务返回错误，请重试".into())
                }
                _ => {}
            },
            "claude" => match value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "message_start" => {
                    self.input = value
                        .pointer("/message/usage/input_tokens")
                        .and_then(Value::as_u64);
                }
                "content_block_start" => {
                    match value.pointer("/content_block/type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(text) =
                                value.pointer("/content_block/text").and_then(Value::as_str)
                            {
                                self.append(text)?;
                            }
                        }
                        Some("thinking") | Some("redacted_thinking") => {}
                        _ => return Err("AI流式响应包含拒绝或未授权工具".into()),
                    }
                }
                "content_block_delta" => match value.pointer("/delta/type").and_then(Value::as_str)
                {
                    Some("text_delta") => {
                        if let Some(text) = value.pointer("/delta/text").and_then(Value::as_str) {
                            self.append(text)?;
                        }
                    }
                    Some("thinking_delta") | Some("signature_delta") => {}
                    _ => return Err("AI流式响应包含拒绝或未授权工具".into()),
                },
                "message_delta" => {
                    self.reason = value
                        .pointer("/delta/stop_reason")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    self.output = value
                        .pointer("/usage/output_tokens")
                        .and_then(Value::as_u64)
                        .or(self.output);
                }
                "message_stop" => {
                    if self.reason.as_deref() != Some("end_turn") {
                        return Err("AI流式响应未完整结束".into());
                    }
                    self.finished = true;
                }
                "error" => return Err("AI流式服务返回错误，请重试".into()),
                _ => {}
            },
            "gemini" => {
                if let Some(parts) = value
                    .pointer("/candidates/0/content/parts")
                    .and_then(Value::as_array)
                {
                    for part in parts {
                        if part.get("functionCall").is_some() {
                            return Err("AI流式响应包含拒绝或未授权工具".into());
                        }
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            self.append(text)?;
                        }
                    }
                }
                self.input = value
                    .pointer("/usageMetadata/promptTokenCount")
                    .and_then(Value::as_u64)
                    .or(self.input);
                self.output = value
                    .pointer("/usageMetadata/candidatesTokenCount")
                    .and_then(Value::as_u64)
                    .or(self.output);
                if let Some(reason) = value
                    .pointer("/candidates/0/finishReason")
                    .and_then(Value::as_str)
                {
                    if reason != "STOP" {
                        return Err("AI流式响应未完整结束".into());
                    }
                    self.reason = Some(reason.into());
                    self.finished = true;
                }
            }
            _ => return Err("AI协议无效".into()),
        }
        Ok(())
    }
    pub fn finish(self) -> Result<Value, String> {
        if !self.finished {
            return Err("AI流式响应未完整结束".into());
        }
        Ok(match self.protocol.as_str() {
            "openai_chat" => {
                json!({"choices":[{"finish_reason":"stop","message":{"content":self.text}}],"usage":{"prompt_tokens":self.input,"completion_tokens":self.output}})
            }
            "openai_responses" => self.response.ok_or("AI流式完成事件无效")?,
            "claude" => {
                json!({"stop_reason":"end_turn","content":[{"type":"text","text":self.text}],"usage":{"input_tokens":self.input,"output_tokens":self.output}})
            }
            "gemini" => {
                json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":self.text}]}}],"usageMetadata":{"promptTokenCount":self.input,"candidatesTokenCount":self.output}})
            }
            _ => return Err("AI协议无效".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_boundaries_and_required_terminal_markers() {
        let content = "{\"summary\":\"连接正常😀\"}";
        let event = format!(
            "data: {}\r\n\r\ndata: {}\r\n\r\ndata: [DONE]\r\n\r\n",
            json!({"choices":[{"delta":{"content":content}}]}),
            json!({"choices":[{"delta":{},"finish_reason":"stop"}]})
        );
        let mut collector = Collector::new("openai_chat");
        for byte in event.as_bytes() {
            collector.push(&[*byte]).unwrap();
        }
        let value = collector.finish().unwrap();
        assert_eq!(
            value
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str),
            Some(content)
        );
        let mut cut = Collector::new("openai_chat");
        cut.push(
            format!(
                "data: {}\n\n",
                json!({"choices":[{"delta":{"content":content}}]})
            )
            .as_bytes(),
        )
        .unwrap();
        assert!(cut.finish().is_err());
    }
    #[test]
    fn claude_gemini_and_responses_completion() {
        let text = "{\"summary\":\"正常\"}";
        let cases = [
            (
                "claude",
                vec![
                    json!({"type":"message_start","message":{"usage":{"input_tokens":2}}}),
                    json!({"type":"content_block_start","content_block":{"type":"text","text":""}}),
                    json!({"type":"content_block_delta","delta":{"type":"text_delta","text":text}}),
                    json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}),
                    json!({"type":"message_stop"}),
                ],
            ),
            (
                "gemini",
                vec![
                    json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":text}]}}]}),
                ],
            ),
            (
                "openai_responses",
                vec![
                    json!({"type":"response.output_text.delta","delta":text}),
                    json!({"type":"response.completed","response":{"status":"completed","output":[{"content":[{"type":"output_text","text":text}]}]}}),
                ],
            ),
        ];
        for (protocol, events) in cases {
            let mut collector = Collector::new(protocol);
            for event in events {
                collector
                    .push(format!("event: event\ndata: {event}\n\n").as_bytes())
                    .unwrap();
            }
            assert!(collector.finish().is_ok());
        }
    }
    #[test]
    fn rejects_tool_invocations_and_malformed_events() {
        for (protocol, event) in [
            (
                "claude",
                json!({"type":"content_block_start","content_block":{"type":"tool_use"}}),
            ),
            (
                "gemini",
                json!({"candidates":[{"content":{"parts":[{"functionCall":{}}]}}]}),
            ),
            (
                "openai_chat",
                json!({"choices":[{"delta":{"tool_calls":[]}}]}),
            ),
        ] {
            let mut collector = Collector::new(protocol);
            assert!(collector
                .push(format!("data: {event}\n\n").as_bytes())
                .is_err());
        }
        assert!(Collector::new("claude")
            .push(b"data: not-json\n\n")
            .is_err());
    }
}
