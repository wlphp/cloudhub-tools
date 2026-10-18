use serde::Serialize;

#[derive(Debug, Serialize)]
pub(crate) struct PlatformError {
    pub kind: &'static str,
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

pub(crate) type PlatformResult<T> = Result<T, PlatformError>;

impl From<String> for PlatformError {
    fn from(message: String) -> Self { Self::from_message(message) }
}

impl From<&str> for PlatformError {
    fn from(message: &str) -> Self { Self::from_message(message.to_string()) }
}

impl PlatformError {
    fn from_message(message: String) -> Self {
        if [
            "路由端口被占用，请修改端口后重试", "请先回到直连，再修改监听端口",
            "请选择已保存的供应商", "路由与聚合需要已填写密钥的供应商，官方订阅请使用直连",
            "路由端口、超时、重试或熔断参数无效", "供应商名单包含重复或无效标识",
            "聚合模式至少需要一个已配置的模型", "聚合默认供应商至少需要一个已配置的模型", "缺少接管恢复记录，配置未改写", "路由配置损坏", "路由状态不可用",
            "接管备份损坏，配置未改写", "接管备份路径无效", "当前配置不是对象，无法恢复",
            "当前 env 不是对象，无法恢复", "请先回到直连再切换项目", "请先回到直连再导入配置",
            "该供应商仍在路由或聚合名单中，请先移除", "当前直连供应商不能删除，请先切换",
            "此供应商需要协议转换，请在路由或聚合模式中使用", "此供应商需要协议转换，请使用路由或聚合",
            "该供应商尚未填写 API Key，无法切换", "该供应商尚未填写 API Key",
            "供应商请求地址无效", "请求地址必须为不含凭据、查询参数及片段的 HTTP(S) 地址",
            "供应商名称不能为空", "供应商标识不能为空", "供应商不存在", "供应商配置损坏",
            "供应商名称、标识、密钥或模型列表无效", "聚合模型 ID 不能为空、重复或超过长度限制", "供应商模型映射无效",
            "扩展环境变量只接受非敏感字符串，请使用专用认证字段保存密钥",
            "请先保存供应商请求地址与 API Key", "模型列表请求失败，请检查网络",
            "模型列表请求被拒绝，请检查 API Key、地址或手动填写模型", "模型列表超过大小限制",
            "模型列表格式无效", "上游未返回模型列表", "模型列表读取失败",
            "Claude Code 配置不是合法 JSON，无法解析", "Claude Code 配置或 env 不是对象，配置未改写",
            "Claude 配置或 env 必须是对象，配置未改写", "Claude 配置是链接或超过大小限制，未读取",
            "不能改写链接配置文件", "没有可恢复的备份", "备份配置格式无效，未恢复",
            "读取 Claude Code 配置失败", "写入 Claude Code 配置失败", "保存 Claude Code 配置失败",
            "所选项目目录不可用，请重新选择", "项目目录不可用", "请选择项目文件夹",
            "MCP 名称或配置无效", "MCP 命令或参数无效", "MCP 传输类型无效",
            "MCP 环境变量或请求头无效", "mcpServers 必须是对象", "未找到停用的 MCP", "未找到 MCP",
            "提示词名称、内容或数量无效", "提示词不存在",
            "请先启用其他提示词或恢复 CLAUDE.md，再删除当前提示词",
            "没有可恢复的文件备份", "文件备份无效", "Claude 文件不是合法 JSON，未改写",
            "Claude 配置必须是对象，未改写", "工作台数据损坏", "保存工作台数据失败",
            "同名技能已存在，请先卸载或改名", "同名技能已存在，无法覆盖",
            "所选目录没有 SKILL.md", "技能文件数量或大小超过限制",
            "技能包含链接，不能自动复制或移动", "技能文件夹名称无效", "技能目录不可用",
            "会话标识无效", "会话不存在", "同名会话已存在", "配置正在使用",
        ].contains(&message.as_str()) {
            return Self { kind: "platform-error", code: "claude-workbench", message, retryable: false };
        }
        // Exact authored diagnostics only: never forward arbitrary native error text.
        if ["桌宠设置读取失败", "桌宠设置无效", "桌宠数据保存失败", "此窗口不支持桌宠操作",
            "提醒记录读取失败", "提醒状态不可用", "无法关闭提醒", "无法显示桌面提醒",
            "无法读取显示器", "未找到显示器", "无法读取桌宠窗口", "无法移动桌宠",
            "无法关闭桌宠", "无法调整桌宠大小", "无法读取桌宠位置", "无法显示桌宠",
            "无法创建桌宠窗口", "无法隐藏桌宠", "桌宠动画帧无效", "桌宠状态不可用",
            "桌宠交互区域无效", "无法读取桌宠大小", "无法调整桌宠窗口", "桌宠移动距离无效",
            "无效的桌宠入口", "提醒暂缓参数无效", "巡检正在执行，请稍后重试", "巡检状态不可用",
            "提醒不存在", "请先开启运维预警", "手动巡检间隔至少一分钟"
        ].contains(&message.as_str()) {
            return Self { kind: "platform-error", code: "validation", message, retryable: false };
        }
        if [
            "此窗口不支持备忘录提醒", "备忘录任务执行失败", "备忘录状态不可用",
            "无法打开备忘录",
            "备忘录不存在或已被删除", "请选择要删除的备忘录", "无法开始删除备忘录",
            "删除备忘录失败", "提交备忘录删除失败", "保存备忘录失败", "提交备忘录失败",
            "无法开始保存备忘录", "读取备忘录失败", "标题不能为空",
            "请选择或填写分组", "至少保留一个分组", "目标分组与要删除的分组相同",
            "分组不存在或已被删除", "迁移备忘录分组失败", "删除备忘录分组失败",
            "提交备忘录分组删除失败", "无法开始删除分组", "保存备忘录分组失败",
            "读取备忘录分组失败", "初始化备忘录分组失败", "保存提醒失败",
            "读取备忘录提醒失败", "无法开始处理提醒", "更新提醒状态失败", "提交提醒状态失败",
            "无法开始完成提醒", "完成提醒失败", "提交提醒完成失败", "稍后提醒时间无效",
            "无法开始稍后提醒", "稍后提醒失败", "提交稍后提醒失败", "提醒重复方式无效",
            "提醒时间必须晚于当前时间", "提醒时间过远，最多提前十年"
        ].contains(&message.as_str())
            || notes_length_message(&message).is_some()
        {
            return Self { kind: "platform-error", code: "notes", message, retryable: false };
        }
        if [
            "该发行版已安装，请从下方列表直接启动或管理",
            "WSL 命令未完成，请检查发行版、安装目录和 WSL 状态",
            "无法打开 WSL 终端，请确认 Windows Terminal 或 WSL 可用",
            "请输入完整发行版名称以确认删除",
            "该发行版已不存在，请刷新列表",
            "WSL 服务内部错误（E_UNEXPECTED）。请保存工作并停止全部 WSL 后重试；仍失败时重启 Windows",
            "无法确认发行版运行状态，请刷新列表",
            "发行版启动进程已退出，请检查 Linux 环境后重试",
            "WSL 操作任务失败，请重试",
            "未能启动该发行版，请检查 WSL 安装和发行版环境",
            "无法读取 WSL 在线目录，请检查网络连接后重试",
            "WSL 在线目录为空，请重新加载目录",
            "读取 WSL 在线目录任务失败，请重试",
            "请选择本机 TAR 备份文件位置",
            "WSL 备份文件未生成，请重试",
            "无法保存 WSL 备份，请检查文件占用、目录权限和磁盘空间",
            "备份 WSL 发行版任务失败，请重试",
        ].contains(&message.as_str()) {
            return Self { kind: "platform-error", code: "wsl-dashboard", message, retryable: false };
        }
        if ["代理地址无效", "代理地址不能包含换行或控制字符", "代理地址不能超过 512 个字符",
            "代理地址缺少协议，请填写 http://127.0.0.1:10808 这样的完整地址",
            "请填写无账号密码的 HTTP/HTTPS 代理地址，例如 http://127.0.0.1:7890",
            "请先停止该账号的服务或实例，再修改代理", "保存账号代理任务失败", "保存账号代理失败",
            "读取本机代理配置失败，请手动填写代理地址", "本机代理配置超过读取限制"
            , "请选择 1–1000 个有效账号后批量设置代理", "所选账号已不存在，请刷新列表后重试",
            "所选账号中有服务、实例或唤醒任务运行，请先停止后批量设置代理；未修改任何账号",
            "批量保存代理失败，未修改任何账号", "批量保存代理任务失败"
        ].contains(&message.as_str()) {
            return Self { kind: "platform-error", code: "codex-proxy", message, retryable: false };
        }
        if let Some((safe_message, retryable)) = safe_esa_query_error(&message) {
            return Self { kind: "platform-error", code: "esa-query", message: safe_message, retryable };
        }
        if is_safe_esa_error(&message) {
            let retryable = message.contains("超时")
                || message.contains("稍后")
                || message.contains("HTTP 429")
                || message.contains("HTTP 502")
                || message.contains("HTTP 503")
                || message.contains("HTTP 504");
            return Self { kind: "platform-error", code: "certificate", message, retryable };
        }
        let normalized = message.to_ascii_lowercase();
        let (code, retryable) = if message == "本机 FRP 面板端口已被占用，请先停止旧连接或占用该端口的进程" {
            ("frp-port-conflict", false)
        } else if message.contains("所选账号已有实例或服务运行") {
            ("codex-account-busy", false)
        } else if message.contains("本地 API 端口被占用") || message.contains("无法监听") {
            ("codex-gateway-port-conflict", false)
        } else if normalized.contains("取消") || normalized.contains("cancel") {
            ("cancelled", false)
        } else if normalized.contains("不存在") || normalized.contains("not found") {
            ("not-found", false)
        } else if normalized.contains("冲突") || normalized.contains("已存在") || normalized.contains("已在运行") || normalized.contains("conflict") {
            ("conflict", false)
        } else if normalized.contains("权限") || normalized.contains("无权") || normalized.contains("forbidden") || normalized.contains("permission") || normalized.contains("http 403") || normalized.contains("status 403") {
            ("permission", false)
        } else if normalized.contains("密钥") || normalized.contains("凭据") || normalized.contains("认证") || normalized.contains("签名") || normalized.contains("access key") || normalized.contains("authentication") || normalized.contains("unauthorized") || normalized.contains("token") || normalized.contains("http 401") || normalized.contains("status 401") {
            ("authentication", false)
        } else if normalized.contains("参数") || normalized.contains("格式") || normalized.contains("不能为空") || normalized.contains("无效") || normalized.contains("invalid") || normalized.contains("must be") || normalized.contains("eab") || normalized.contains("dns 区域不属于当前账号") || normalized.contains("dns 验证未") || normalized.contains("证书品牌") {
            ("validation", false)
        } else if normalized.contains("超时") || normalized.contains("网络") || normalized.contains("连接") || normalized.contains("请求失败") || normalized.contains("timeout") || normalized.contains("network") || normalized.contains("connection") || normalized.contains("http 429") || normalized.contains("http 502") || normalized.contains("http 503") || normalized.contains("http 504") || normalized.contains("status 429") || normalized.contains("status 502") || normalized.contains("status 503") || normalized.contains("status 504") {
            ("network", true)
        } else {
            ("unknown", false)
        };
        let public_message = match code {
            "frp-port-conflict" => "本机 FRP 面板端口已被占用，请先停止旧连接或占用该端口的进程",
            "codex-account-busy" => "所选账号已有 Codex 实例或服务运行，请先停止后再启动 API 服务",
            "codex-gateway-port-conflict" => "本地 API 端口已被占用，请换一个端口后重试",
            "authentication" => "认证失败，请检查凭据或登录状态",
            "permission" => "权限不足，请检查当前账号权限",
            "network" => "网络或云服务暂时不可用，请稍后重试",
            "not-found" => "目标资源不存在或已被移除",
            "conflict" => "操作冲突，请刷新后重试",
            "cancelled" => "操作已取消",
            "validation" => "输入参数无效，请检查后重试",
            _ => "操作失败，请稍后重试",
        };
        Self { kind: "platform-error", code, message: public_message.to_string(), retryable }
    }
}

/// Matches only the fixed notes length diagnostics (`{label}过长，最多 {max} 个字符`),
/// keeping the label and numeric limit inside the authored whitelist so no
/// user text can be forwarded.
fn notes_length_message(message: &str) -> Option<(&str, u32)> {
    const LABELS: [(&str, u32); 6] = [
        ("标题", 200),
        ("正文", 200_000),
        ("账号", 512),
        ("密码", 2048),
        ("分组名", 20),
        ("标签", 16),
    ];
    LABELS.into_iter().find(|(label, max)| {
        message.len() <= label.len() + 64
            && message.starts_with(label)
            && message.ends_with(&format!("过长，最多 {max} 个字符"))
    })
}

fn safe_esa_query_error(message: &str) -> Option<(String, bool)> {
    let rest = message.strip_prefix("ESA 查询失败：")?;
    let (action, details) = rest.split_once("（")?;
    if !["ListSites", "DescribeSiteTimeSeriesData", "DescribeSiteWafTimeSeriesData"].contains(&action) { return None; }
    let details = details.strip_suffix('）')?;
    let retryable = match details {
        "网络连接失败" => true,
        "响应格式无效" => false,
        _ => {
            let (status, code) = details.strip_prefix("HTTP ")?.split_once("，错误代码 ")?;
            if status.len() != 3 || !status.bytes().all(|byte| byte.is_ascii_digit()) { return None; }
            if code.is_empty() || code.len() > 80 || !code.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')) { return None; }
            matches!(status, "429" | "502" | "503" | "504")
        }
    };
    Some((message.to_string(), retryable))
}

fn is_safe_esa_error(message: &str) -> bool {
    const AUTHORED: &[&str] = &[
        "ESA：证书域名与 ESA 站点不匹配",
        "ESA：证书与私钥不匹配或格式无效",
        "ESA：ESA 自定义证书配额不足，请检查站点套餐",
        "ESA：ESA 证书名称已存在，请刷新站点证书后重试",
        "ESA：账号缺少 ESA 操作权限",
        "ESA：ESA 正在处理请求或已限流，请稍后重试",
        "ESA 请求失败，请检查账号权限、站点状态及请求参数后重试",
        "ESA 网络请求失败或超时，请稍后刷新确认",
        "ESA 返回读取失败",
        "ESA 返回超出大小限制",
        "ESA 返回格式无效",
        "ESA 签名失败",
        "ESA 请求不可用",
        "ESA 请求方式无效",
        "ESA 请求构建失败",
        "ESA 账号或站点无效",
        "ESA 未返回站点信息",
        "ESA 返回的站点 ID 不匹配",
        "ESA 站点域名无效",
        "ESA 证书列表格式无效",
        "ESA 已接收上传但未返回证书 ID，请刷新确认后重试",
        "ESA 未返回挑战记录 ID，请检查站点 DNS 记录",
    ];
    if AUTHORED.contains(&message) {
        return true;
    }
    if let Some(code) = message
        .strip_prefix("ESA 返回错误代码 ")
        .and_then(|value| value.strip_suffix("，请检查账号权限、站点状态及证书格式后重试"))
    {
        return !code.is_empty()
            && code.len() <= 80
            && code.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    }
    message
        .strip_prefix("ESA 请求返回 HTTP ")
        .and_then(|value| value.strip_suffix("，请检查接口状态后重试"))
        .is_some_and(|status| status.len() == 3 && status.bytes().all(|byte| byte.is_ascii_digit()))
}

pub(crate) fn sanitize_resource_error(message: &str) -> String {
    let normalized = message.to_ascii_lowercase();
    if message == "服务器查询超时，部分地域未完成；请在账号中填写服务器所在地域后重试" {
        message.to_string()
    } else if message == "账号地域配置无效" {
        "账号地域配置无效，请检查账号设置中的默认地域".to_string()
    } else if normalized.contains("authorization failed or requested resource not found") {
        "Authorization failed or requested resource not found".to_string()
    } else if normalized.contains("401") || normalized.contains("unauthorized") || normalized.contains("invalid token") || normalized.contains("authentication") || normalized.contains("access key") || normalized.contains("secret") {
        "云厂商认证失败，请检查账号凭据".to_string()
    } else if normalized.contains("403") || normalized.contains("forbidden") || normalized.contains("accessdenied") || normalized.contains("permission") {
        "云厂商权限不足，请检查账号权限".to_string()
    } else if normalized.contains("429") || normalized.contains("too many requests") || normalized.contains("rate limit") {
        "云厂商请求过于频繁，请稍后重试".to_string()
    } else if normalized.contains("502") || normalized.contains("503") || normalized.contains("504") || normalized.contains("timeout") || normalized.contains("network") || normalized.contains("connection") || normalized.contains("请求失败") || normalized.contains("网络") || normalized.contains("连接") || normalized.contains("超时") {
        "云厂商或网络暂时不可用，请稍后重试".to_string()
    } else {
        "云厂商返回了无法公开的错误信息".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{sanitize_resource_error, PlatformError};

    #[test]
    fn proxy_errors_preserve_authored_guidance_only() {
        let error = PlatformError::from("请先停止该账号的服务或实例，再修改代理");
        assert_eq!(error.code, "codex-proxy");
        assert_eq!(error.message, "请先停止该账号的服务或实例，再修改代理");
        let error = PlatformError::from("保存账号代理失败 token=test-secret");
        assert!(!error.message.contains("test-secret"));
    }

    #[test]
    fn frp_port_conflict_is_not_a_retryable_network_error() {
        let error = PlatformError::from("本机 FRP 面板端口已被占用，请先停止旧连接或占用该端口的进程");
        assert_eq!(error.code, "frp-port-conflict");
        assert!(!error.retryable);
        assert!(error.message.contains("端口已被占用"));
    }

    #[test]
    fn notes_errors_keep_authored_text_and_drop_user_input() {
        assert_eq!(PlatformError::from("标题过长，最多 200 个字符").code, "notes");
        assert_eq!(PlatformError::from("密码过长，最多 2048 个字符").code, "notes");
        assert_eq!(PlatformError::from("备忘录不存在或已被删除").code, "notes");
        // Arbitrary text, including a look-alike length message with user data, is not forwarded.
        let error = PlatformError::from("标题过长，最多 200 个字符 secret-value");
        assert_ne!(error.message, "标题过长，最多 200 个字符 secret-value");
        assert!(!error.message.contains("secret-value"));
    }

    #[test]
    fn classifies_network_errors_as_retryable() {
        let error = PlatformError::from("连接超时".to_string());
        assert_eq!(error.code, "network");
        assert!(error.retryable);
    }

    #[test]
    fn keeps_authentication_errors_non_retryable() {
        let error = PlatformError::from("AccessKey 凭据无效".to_string());
        assert_eq!(error.code, "authentication");
        assert!(!error.retryable);
    }

    #[test]
    fn esa_query_errors_preserve_only_allowlisted_diagnostics() {
        let error = PlatformError::from("ESA 查询失败：DescribeSiteTimeSeriesData（HTTP 403，错误代码 Forbidden）");
        assert_eq!(error.code, "esa-query");
        assert!(error.message.contains("HTTP 403"));
        assert!(!error.retryable);

        let error = PlatformError::from("ESA 查询失败：DescribeSiteWafTimeSeriesData（HTTP 503，错误代码 ServiceUnavailable）");
        assert_eq!(error.code, "esa-query");
        assert!(error.retryable);

        let error = PlatformError::from("ESA 查询失败：DescribeSiteTimeSeriesData（HTTP 403，错误代码 token=secret）");
        assert_eq!(error.code, "permission");
        assert!(!error.message.contains("secret"));
    }

    #[test]
    fn classifies_duplicate_operations_as_conflicts() {
        let error = PlatformError::from("同步任务已在运行".to_string());
        assert_eq!(error.code, "conflict");
        assert!(!error.retryable);
    }

    #[test]
    fn explains_codex_gateway_start_conflicts_without_exposing_details() {
        let account = PlatformError::from("所选账号已有实例或服务运行，请先停止");
        assert_eq!(account.code, "codex-account-busy");
        assert!(account.message.contains("先停止"));
        let port = PlatformError::from("本地 API 端口被占用或无法监听，请选择其他端口");
        assert_eq!(port.code, "codex-gateway-port-conflict");
        assert!(port.message.contains("换一个端口"));
    }

    #[test]
    fn classifies_http_rate_limits_as_retryable() {
        let error = PlatformError::from("Vultr API 返回 HTTP 429".to_string());
        assert_eq!(error.code, "network");
        assert!(error.retryable);
    }

    #[test]
    fn classifies_http_authentication_and_permission_failures() {
        assert_eq!(PlatformError::from("HTTP 401 Unauthorized".to_string()).code, "authentication");
        assert_eq!(PlatformError::from("HTTP 403 Forbidden".to_string()).code, "permission");
    }

    #[test]
    fn never_returns_provider_error_text_to_the_command_boundary() {
        let error = PlatformError::from("provider failed secret=TOP_SECRET token=TOP_TOKEN".to_string());
        assert_eq!(error.code, "authentication");
        assert!(!error.message.contains("TOP_SECRET"));
        assert!(!error.message.contains("TOP_TOKEN"));
    }

    #[test]
    fn preserves_only_safe_esa_diagnostics() {
        let error = PlatformError::from("ESA 返回错误代码 Certificate.BadFormat，请检查账号权限、站点状态及证书格式后重试");
        assert_eq!(error.code, "certificate");
        assert!(error.message.contains("Certificate.BadFormat"));

        let hidden = PlatformError::from("ESA provider response token=TOP_SECRET");
        assert_eq!(hidden.code, "authentication");
        assert!(!hidden.message.contains("TOP_SECRET"));

        let retryable = PlatformError::from("ESA 网络请求失败或超时，请稍后刷新确认");
        assert_eq!(retryable.code, "certificate");
        assert!(retryable.retryable);
    }

    #[test]
    fn sanitizes_resource_error_payloads() {
        let message = sanitize_resource_error("request failed secret=TOP_SECRET token=TOP_TOKEN");
        assert_eq!(message, "云厂商认证失败，请检查账号凭据");
        assert!(!message.contains("TOP_SECRET"));
        assert!(!message.contains("TOP_TOKEN"));
    }
}
