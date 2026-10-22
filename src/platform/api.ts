import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const invoke = tauriInvoke;

export type PlatformErrorCode =
  | "codex-login"
  | "codex-launch"
  | "codex-config"
  | "codex-import"
  | "claude-workbench"
  | "oss-cname"
  | "local-plugin"
  | "unknown"
  | "ai"
  | "unsupported-in-preview"
  | "validation"
  | "authentication"
  | "permission"
  | "network"
  | "not-found"
  | "conflict"
  | "frp-port-conflict"
  | "codex-account-busy"
  | "codex-gateway-port-conflict"
  | "codex-model-catalog"
  | "codex-provider"
  | "codex-proxy"
  | "cancelled"
  | "certificate"
  | "esa-query"
  | "authenticator-error"
  | "authenticator-locked"
  | "hardware-info"
  | "wsl-dashboard"
  | "browser"
  | "notes";

function publicPlatformMessage(code: PlatformErrorCode, rawMessage: string): string {
  if (code === "codex-config") {
    return [
      "项目目录路径无效", "项目目录必须为绝对路径", "项目目录不存在", "请选择有效的项目目录",
      "无法确定 Codex 用户目录", "CODEX_HOME 必须为绝对路径", "Codex 配置目录尚不存在",
      "无法打开 Codex 配置目录", "Codex 账号操作不可用", "读取 Codex 配置任务失败",
      "无法读取配置，请确认官方 Codex CLI 已安装且配置有效",
      "官方 CLI 无法读取配置，请检查配置格式或 CLI 版本", "CLI 未返回有效配置",
    ].includes(rawMessage) ? rawMessage : "读取 Codex 配置失败，请检查配置目录和 CLI 后重试";
  }
  if (code === "codex-launch") return ["请先停止实例再修改启动配置", "启动配置已被修改，请重新读取后再保存", "模型名称或上下文参数无效", "官方 CLI 无法保存启动配置，请检查版本或参数", "官方 CLI 无法读取启动配置，请检查版本", "检测到 Codex 客户端或 CLI 正在运行，请关闭后再切换或恢复默认登录", "关闭 Codex 客户端或 CLI 失败，请手动关闭后重试", "Codex 客户端仍在运行，请手动关闭后重试", "自动关闭 Codex 客户端或 CLI 目前仅支持 Windows，请手动关闭后重试", "请先停止 Codex 实例，再执行数据库迁移或登录备份", "请先停止 Codex 本地服务，再执行数据库迁移或登录备份", "请等待 Codex 唤醒结束后，再执行数据库迁移或登录备份", "未找到 Codex CLI，请先安装官方 CLI 并加入 PATH", "请先停止该账号的实例或 API 服务，再刷新 Token", "此账号没有可用的 Refresh Token，请重新授权或导入完整认证", "此账号由默认客户端管理，请在客户端续期后重新导入本机登录", "官方 CLI 刷新失败，请检查网络或重新授权", "请先停止目标实例和账号的服务，再切换实例账号"].includes(rawMessage) ? rawMessage : "启动配置操作失败，请重试";
  if (code === "codex-login") return ["授权身份与原账号不一致，请使用原账号重新登录", "原账号已被删除，请重新添加账号", "重新授权的账号不存在或不支持官方登录"].includes(rawMessage) ? rawMessage : "重新授权失败，请重试";
  if (code === "codex-import") {
    return ["请输入不超过 2 MB 的 Token 或 JSON", "输入的 JSON 格式无效，请检查后重试", "请输入单个 Token 或有效的账号 JSON",
      "请输入 Token 或有效的账号 JSON", "JSON 中未找到有效的 Token 凭据", "每次可导入 1 至 100 个账号",
      "仅有 Refresh Token 的账号请逐个导入，避免批量换取凭据时部分失败", "无法连接官方认证服务，请检查网络后重试",
      "Refresh Token 换取登录凭据失败，请确认 Token 有效或重新登录", "官方认证结果格式无效",
      "Codex 文件缺少有效的登录凭据", "Codex 文件缺少账号标识", "Codex 文件缺少用户标识",
      "导入包含运行中实例的账号，请先停止实例，未保存任何账号"].includes(rawMessage) ? rawMessage : "导入失败，请检查凭据、网络或账号运行状态后重试";
  }
  if (code === "claude-workbench") {
    return rawMessage
      .replace(/(password|secret|token|access[_-]?key|private[_-]?key|authorization|signature)(\s*[:=]\s*)[^,;\s]+/gi, "$1$2[已隐藏]")
      .slice(0, 240) || "Claude Code 操作失败，请重试";
  }
  if (code === "browser") {
    return rawMessage
      .replace(/(password|secret|token|access[_-]?key|private[_-]?key|authorization|signature)(\s*[:=]\s*)[^,;\s]+/gi, "$1$2[已隐藏]")
      .slice(0, 240) || "浏览器环境操作失败，请重试";
  }
  if (code === "oss-cname") {
    const safe = ["请先获取验证 Token，并配置 TXT 记录；等待 DNS 生效后重试绑定", "权限不足，请检查账号的 OSS 自定义域名操作权限", "此域名已绑定其他存储桶，请先解除原绑定", "域名参数无效，请使用具体的完整域名", "请求被拒绝，请检查域名、地域和账号权限后重试", "OSS 未返回验证 Token，请重新获取", "OSS 自定义域名列表格式无效", "OSS 连接失败或超时，请检查网络后重试", "OSS 返回读取失败", "OSS 存储桶名称或地域无效，请刷新存储桶列表", "请输入有效的完整域名，例如 img.example.com", "普通 OSS 存储桶请填写具体域名，例如 img.example.com，不能填写泛域名 *.example.com"];
    return safe.includes(rawMessage) ? rawMessage : "OSS 自定义域名操作失败，请检查账号和域名后重试";
  }
  if (code === "hardware-info") {
    const safe = ["无法读取本机硬件信息", "读取本机硬件信息失败", "本机硬件信息格式无效", "硬件信息插件当前不支持此桌面平台", "导出的图片超过大小限制", "图片格式无效，请重新导出", "图片尺寸超过限制，请缩小后重试", "请使用 PNG 图片格式", "保存位置无效", "图片保存失败，请检查目录权限和磁盘空间", "无法读取当前 Wi-Fi 密码", "无法读取当前 Wi-Fi 密码，请确认已连接 Wi-Fi 且系统允许查看已保存密码", "请在 Windows 设置 > 隐私和安全性 > 位置中开启位置服务，并允许桌面应用访问位置后重试", "当前 Wi-Fi 没有可显示的已保存密码", "此平台暂不支持读取已保存的 Wi-Fi 密码", "读取当前 Wi-Fi 配置失败，请检查无线网络状态后重试", "未检测到已连接的 Wi-Fi 网络", "当前 Wi-Fi 没有可读取的已保存密码；企业认证网络可能不使用共享密码"];
    return safe.includes(rawMessage) ? rawMessage : "电脑信息操作失败，请重试";
  }
  if (code === "wsl-dashboard") {
    const safe = ["WSL 服务内部错误（E_UNEXPECTED）。请保存工作并停止全部 WSL 后重试；仍失败时重启 Windows", "无法确认发行版运行状态，请刷新列表", "发行版启动进程已退出，请检查 Linux 环境后重试", "WSL 操作任务失败，请重试", "无法读取 WSL 在线目录，请检查网络连接后重试", "WSL 在线目录为空，请重新加载目录", "读取 WSL 在线目录任务失败，请重试", "请输入完整发行版名称以确认删除", "请选择本机 TAR 备份文件位置", "WSL 备份文件未生成，请重试", "无法保存 WSL 备份，请检查文件占用、目录权限和磁盘空间", "备份 WSL 发行版任务失败，请重试", "该发行版已安装，请从下方列表直接启动或管理", "该发行版已安装，请更换实例名称或从下方列表管理", "新实例名称已存在，请更换名称", "源发行版不存在，请刷新列表", "WSL 命令未完成，请检查发行版、安装目录和 WSL 状态", "未能启动 WSL。请确认 Windows 已启用 WSL 并重试", "未能启动该发行版，请检查 WSL 安装和发行版环境", "请选择 WSL 在线列表中的发行版", "发行版名称无效，请刷新列表后重试", "发行版名称无效，请使用字母、数字、点、下划线或连字符", "默认安装目录无效", "该发行版已不存在，请刷新列表", "无法打开该发行版的文件夹", "无法打开 WSL 终端，请确认 Windows Terminal 或 WSL 可用", "请选择存在的 RootFS 文件", "RootFS 文件仅支持 .tar、.tar.gz、.tar.xz 或 .wsl", "请选择发行版专用的安装目录", "无法创建发行版临时导出文件", "安装目录已存在且不是文件夹", "无法创建发行版安装目录，请检查路径权限和磁盘空间", "无法读取发行版安装目录", "发行版安装目录必须为空，请选择新的空目录"];
    return safe.includes(rawMessage) ? rawMessage : "WSL 操作失败，请检查发行版和安装目录后重试";
  }
  if (code === "local-plugin") {
    if (rawMessage === "快速启动间隔须为 0～500 毫秒") return rawMessage;
    if (["微信配置标识无效", "删除微信配置失败，请刷新列表后重试", "删除微信配置任务失败，请重试"].includes(rawMessage)) return rawMessage;
    if (["当前客户端是微信 4.x，所选配置属于微信 3.x；请重新检测当前版本的数据目录", "当前客户端是微信 3.x，所选配置属于微信 4.x；请选择对应客户端或数据目录"].includes(rawMessage)) return rawMessage;
    const directoryMessages = ["所选位置是微信程序目录，请在微信设置中查看文件存储位置，再选择实际数据目录", "未找到登录配置，请选择包含 all_users 或 All Users 的微信数据目录；请先登录一次微信", "检测微信数据目录失败，请重试"];
    if (directoryMessages.includes(rawMessage)) return rawMessage;
    const safe = ["请选择 2～5 个启动窗口", "请选择本地安装的 Weixin.exe 或 WeChat.exe", "微信客户端路径不可用，请重新选择", "无法检查微信进程，请稍后重试", "微信启动任务正在执行，请稍后重试", "请先从微信托盘菜单退出所有微信，再批量启动", "读取微信状态失败，请重试", "选择微信客户端失败，请重试", "微信多开插件仅支持 Windows 桌面端", "启动微信任务失败，请重试"];
    safe.push("微信配置操作失败，请检查目录权限和磁盘空间", "微信配置快照无效或不兼容，请重新保存", "无法确认微信窗口，请检查客户端后重试", "请选择本地微信数据根目录", "未找到受支持的微信登录配置，请选择数据根目录", "微信配置目录不能包含链接或重解析点", "微信配置被占用或不可写，请退出微信后重试", "微信登录配置超过大小限制", "微信配置快照已达上限，请先整理本地快照目录", "微信启动任务正在执行，请稍后重试", "请填写 1～40 字的账号配置名称", "保存配置前请从托盘退出所有微信", "写入微信配置失败，已还原原配置", "微信配置写入及回滚失败，请退出微信并恢复备份", "客户端与账号配置类型不匹配", "恢复备份前请退出所有微信并选择恢复备份", "恢复前备份", "启动微信失败，已还原启动前配置", "已发出启动请求但未确认新窗口，请检查微信后再操作；恢复前备份已保留", "读取微信配置列表失败", "选择微信数据根目录（xwechat_files 或 WeChat Files）", "选择微信数据目录失败", "微信多开插件仅支持 Windows 桌面端", "保存微信配置任务失败", "启动微信任务失败，请重试", "恢复微信配置任务失败");
    return safe.includes(rawMessage) ? rawMessage : "插件操作失败，请重试";
  }
  if (code === "ai") {
    const chatErrors = ["仅桌宠窗口支持聊天", "聊天记录无效或过长，请清空后重试", "聊天消息无效或过长", "聊天内容含疑似凭据，请移除后再发送", "聊天记录过长，请清空后重试", "聊天请求标识无效", "AI配置已更新，请关闭聊天后重新打开", "聊天已停止", "回复为空，请重试"];
    if (chatErrors.includes(rawMessage)) return rawMessage;
    if (/^AI服务拒绝请求（HTTP (400|404|422)）：(参数 (model|instructions|tools|tool_choice|input|reasoning|max_output_tokens|temperature|top_p|store|stream|include|service_tier|text|prompt_cache_key) 不兼容|模型不可用或模型参数不兼容|请求参数不受支持|指令参数不兼容|请求被拒绝)$/.test(rawMessage)) return rawMessage;
    const safe = ["AI任务状态不可用", "AI请求标识无效", "请先填写或选择分析内容", "内容含疑似凭据，请先使用发送预览移除后再提交", "AI任务已在运行或并发已达上限", "AI请求已取消", "AI服务地址无效", "AI服务地址不能包含账号、密码、查询参数或片段", "AI服务须使用HTTPS；本地回环HTTP需明确开启", "AI协议无效", "模型名称只支持字母、数字、点、下划线、冒号及连字符", "AI配置字段或限额无效", "AI密钥格式无效", "最多保存20个AI服务配置", "首次添加须填写AI密钥", "AI服务已停用", "分析内容过长，请选择较短片段", "内容包含私钥或验证器凭据，请移除后再分析", "模型未完整返回结果，请缩短输入或调整输出上限", "模型响应未完成或被拒绝", "模型响应未完成或请求了未授权工具", "模型响应未完成或内容被拒绝", "模型返回了敏感内容，结果已拦截", "AI结果格式不合法，请重试或手动填写", "AI结果超过处理上限", "AI结果包含未允许的字段或无效值", "AI结果包含疑似凭据，结果已拦截", "AI请求超时，可重试或继续手动操作", "AI连接失败，请检查地址与网络", "AI认证失败，请检查密钥和权限", "AI服务限流或额度不足，请稍后重试", "AI服务发生重定向，请填写最终HTTPS地址", "AI协议、路径或模型不受支持，请检查配置", "AI服务暂不可用，请稍后重试", "AI响应超过大小限制", "AI服务返回无效响应", "AI结果为空，请重试或手动填写", "更改AI服务来源时须重新填写密钥"];
    safe.push("启用AI服务须填写密钥", "请选择1～20个AI配置", "所选AI配置已变化，请刷新后重试", "AI迁移包类型、版本或数量无效", "AI迁移配置字段无效", "请选择迁移预览中的有效AI配置", "导入后AI配置将超过20个，请先整理配置", "导入AI配置失败，未写入任何配置", "AI配置文件超过大小限制", "AI配置文件格式无效", "AI迁移状态不可用", "请先关闭其他AI迁移预览", "AI迁移预览已过期，请重新选择文件", "保存AI迁移包失败", "导出AI配置失败", "读取AI迁移配置失败", "导出AI迁移任务失败", "读取AI迁移任务失败");
    safe.push("AI配置已变更，请关闭辅助面板后重新打开", "AI服务拒绝请求（HTTP 400），请检查模型和请求参数", "AI接口不存在（HTTP 404），请检查服务地址和接口协议", "AI请求参数无效（HTTP 422），请检查模型和服务兼容性");
    safe.push("AI流式事件超过大小限制", "AI流式文本编码无效", "AI流式结果超过大小限制", "AI流式事件数量超过限制", "AI流式响应未完整结束", "AI流式事件格式无效", "AI流式服务返回错误，请重试", "AI流式响应包含拒绝或未授权工具", "AI流式完成事件无效", "截图超过大小限制，请裁剪后重试", "截图格式无效，请使用PNG或JPEG图片", "截图数据无效", "截图格式与实际内容不一致", "截图尺寸无效", "截图尺寸须在1600像素以内，请裁剪或缩小", "无法解码截图", "截图包含二维码，请裁剪或遮挡后重试", "处理截图失败", "生成图像测试失败", "请先完成图像能力测试并确认截图已裁剪遮挡", "保存图像测试结果失败", "服务模型目录格式不兼容，可直接填写模型名称", "服务未返回可用模型名称，可直接填写", "查询AI模型失败，请检查服务和网络", "服务不支持模型查询或认证失败，可直接填写模型名称", "读取AI模型目录失败", "AI模型目录超过大小限制");
    safe.push("模型名称格式无效；Gemini只接受单个模型标识", "模型响应包含未授权工具");
    safe.push("每个服务最多配置20个模型", "请使用已配置的模型ID", "请先将所选模型设为默认并完成图像测试", "AI配置不存在，请刷新设置");
    safe.push("此服务尚未保存密钥", "AI配置标识无效");
    return safe.includes(rawMessage) ? rawMessage : "AI操作失败，请检查配置或继续手动操作";
  }
  if (code === "esa-query") {
    return /^ESA 查询失败：(ListSites|DescribeSiteTimeSeriesData|DescribeSiteWafTimeSeriesData)（(?:网络连接失败|响应格式无效|HTTP [1-5]\d{2}，错误代码 [A-Za-z0-9._-]{1,80})）$/.test(rawMessage)
      ? rawMessage : "ESA 实时数据获取失败，请检查账号权限和网络后重试";
  }
  if (code === "codex-provider") {
    // The native provider layer forwards only exact, authored diagnostics
    // (see CODEX_PROVIDER_MESSAGES in src-tauri/src/core/error.rs), so the
    // message is already vetted and safe to show as is.
    return rawMessage || "模型供应商操作失败，请刷新后重试";
  }
  if (code === "codex-proxy") {
    return ["代理地址无效", "代理地址不能包含换行或控制字符", "代理地址不能超过 512 个字符",
      "代理地址缺少协议，请填写 http://127.0.0.1:10808 这样的完整地址",
      "请填写无账号密码的 HTTP/HTTPS 代理地址，例如 http://127.0.0.1:7890",
      "请先停止该账号的服务或实例，再修改代理", "保存账号代理任务失败", "保存账号代理失败",
      "读取本机代理配置失败，请手动填写代理地址", "本机代理配置超过读取限制",
      "请选择 1–1000 个有效账号后批量设置代理", "所选账号已不存在，请刷新列表后重试",
      "所选账号中有服务、实例或唤醒任务运行，请先停止后批量设置代理；未修改任何账号",
      "批量保存代理失败，未修改任何账号", "批量保存代理任务失败"].includes(rawMessage)
      ? rawMessage : "代理操作失败，请检查地址或手动填写";
  }
  if (code === "codex-model-catalog") {
    const safeMessages = [
      "官方模型目录认证过期，请重新登录服务账号", "官方模型目录访问被拒绝，请检查服务账号权限",
      "官方模型目录请求过于频繁，请稍后重试", "查询官方模型目录失败，请检查网络",
      "官方模型目录响应格式不兼容", "当前服务账号未返回模型目录", "服务账号均在冷却中，请稍后重试",
      "服务账号认证数据无效，请重新登录", "读取服务账号认证失败，请重新登录或刷新账号",
      "读取服务账号认证任务失败", "未找到官方 Codex 客户端，无法查询模型目录",
      "读取 Codex 客户端版本失败", "读取 Codex 客户端版本超时", "Codex 客户端版本无效",
      "读取官方模型目录失败", "官方模型目录响应超过限制",
    ];
    return safeMessages.includes(rawMessage) || /^官方模型目录返回 HTTP [1-5]\d{2}$/.test(rawMessage)
      ? rawMessage : "模型目录获取失败，请检查服务账号登录、权限与网络";
  }
  if (code === "notes") {
    // The native layer and preview route only emit authored diagnostics; keep the
    // text and scrub anything that looks like a pasted credential.
    return rawMessage
      .replace(/(password|secret|token|access[_-]?key|private[_-]?key|authorization|signature)(\s*[:=]\s*)[^,;\s]+/gi, "$1$2[已隐藏]")
      .slice(0, 240) || "备忘录操作失败，请重试";
  }
  if (code === "authenticator-locked") return "验证器已锁定，请重新解锁";
  if (code === "authenticator-error") {
    return rawMessage
      .replace(/otpauth:\/\/[^\s]+/gi, "[OTP 地址已隐藏]")
      .replace(/(password|secret|token|access[_-]?key|private[_-]?key|authorization|signature)(\s*[:=]\s*)[^,;\s]+/gi, "$1$2[已隐藏]")
      .slice(0, 240);
  }
  if (code === "unsupported-in-preview") {
    return rawMessage
      .replace(/(password|secret|token|access[_-]?key|private[_-]?key|authorization|signature)(\s*[:=]\s*)[^,;\s]+/gi, "$1$2[已隐藏]")
      .slice(0, 240);
  }
  if (code === "certificate") {
    return rawMessage
      .replace(/(password|secret|token|access[_-]?key|private[_-]?key|authorization|signature)(\s*[:=]\s*)[^,;\s]+/gi, "$1$2[已隐藏]")
      .slice(0, 240);
  }
  const messages: Record<Exclude<PlatformErrorCode, "codex-config" | "codex-launch" | "codex-login" | "codex-import" | "claude-workbench" | "oss-cname" | "local-plugin" | "ai" | "unsupported-in-preview" | "certificate" | "esa-query" | "authenticator-error" | "authenticator-locked" | "hardware-info" | "wsl-dashboard" | "codex-model-catalog" | "codex-provider" | "codex-proxy" | "browser" | "notes">, string> = {
    unknown: "操作失败，请稍后重试",
    validation: "输入参数无效，请检查后重试",
    authentication: "认证失败，请检查凭据或登录状态",
    permission: "权限不足，请检查当前账号权限",
    network: "网络或云服务暂时不可用，请稍后重试",
    "not-found": "目标资源不存在或已被移除",
    conflict: "操作冲突，请刷新后重试",
    "frp-port-conflict": "本机 FRP 面板端口已被占用，请先停止旧连接或占用该端口的进程",
    "codex-account-busy": "所选账号已有 Codex 实例或服务运行，请先停止后再启动 API 服务",
    "codex-gateway-port-conflict": "本地 API 端口已被占用，请换一个端口后重试",
    cancelled: "操作已取消",
  };
  return messages[code];
}

export class PlatformError extends Error {
  readonly kind = "platform-error" as const;
  constructor(
    message: string,
    readonly code: PlatformErrorCode = "unknown",
    readonly retryable = false,
  ) {
    super(publicPlatformMessage(code, message));
    this.name = "PlatformError";
  }
}

function classifyPlatformError(message: string): { code: PlatformErrorCode; retryable: boolean } {
  if (/仅在桌面端|仅在浏览器预览|仅支持 CloudHub 原生客户端|unsupported-in-preview/i.test(message)) return { code: "unsupported-in-preview", retryable: false };
  if (message.includes("所选账号已有实例或服务运行")) return { code: "codex-account-busy", retryable: false };
  if (message.includes("本地 API 端口被占用") || message.includes("无法监听")) return { code: "codex-gateway-port-conflict", retryable: false };
  if (/取消|cancelled|canceled/i.test(message)) return { code: "cancelled", retryable: false };
  if (/不存在|not found|未找到/i.test(message)) return { code: "not-found", retryable: false };
  if (/冲突|已存在|conflict|duplicate/i.test(message)) return { code: "conflict", retryable: false };
  if (/权限|无权|forbidden|unauthorized|notauthorized|accessdenied|permission/i.test(message)) return { code: "permission", retryable: false };
  if (/密钥|凭据|认证|签名|access key|authentication|invalid token/i.test(message)) return { code: "authentication", retryable: false };
  if (/参数|格式|不能为空|无效|invalid|must be|不能超过/i.test(message)) return { code: "validation", retryable: false };
  if (/超时|网络|连接|请求失败|timeout|network|connection|fetch failed/i.test(message)) return { code: "network", retryable: true };
  return { code: "unknown", retryable: false };
}

export function normalizePlatformError(reason: unknown): PlatformError {
  if (reason instanceof PlatformError) return reason;
  if (typeof reason === "object" && reason !== null && "kind" in reason && reason.kind === "unsupported-in-preview") {
    const unsupported = reason as UnsupportedInPreviewError;
    return new PlatformError(unsupported.message, "unsupported-in-preview", false);
  }
  if (typeof reason === "object" && reason !== null && "code" in reason && "message" in reason) {
    const structured = reason as { code?: PlatformErrorCode; message?: string; retryable?: boolean };
    const code = structured.code && ["codex-config", "codex-launch", "codex-login", "codex-import", "claude-workbench", "oss-cname", "local-plugin", "ai", "unknown", "unsupported-in-preview", "validation", "authentication", "permission", "network", "not-found", "conflict", "frp-port-conflict", "codex-account-busy", "codex-gateway-port-conflict", "codex-model-catalog", "codex-provider", "codex-proxy", "cancelled", "certificate", "esa-query", "authenticator-error", "authenticator-locked", "hardware-info", "wsl-dashboard", "browser", "notes"].includes(structured.code)
      ? structured.code : "unknown";
    return new PlatformError(String(structured.message), code, structured.retryable === true);
  }
  const message = reason instanceof Error ? reason.message : String(reason);
  const classified = classifyPlatformError(message);
  return new PlatformError(message, classified.code, classified.retryable);
}

export function platformErrorMessage(reason: unknown, fallback = "操作失败"): string {
  const error = normalizePlatformError(reason);
  return error.message || fallback;
}

function webApiPort(value: string | undefined): number {
  const port = Number(value || "1430");
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 1430;
}

const localWebApiPort = webApiPort(
  import.meta.env.VITE_CLOUDHUB_TOOLS_WEB_API_PORT
    || import.meta.env.VITE_ALIYUN_TOOLS_WEB_API_PORT,
);
const localWebApiBaseUrl = `http://127.0.0.1:${localWebApiPort}`;

export interface UnsupportedInPreviewError extends Error {
  kind: "unsupported-in-preview";
  feature?: string;
  hint?: string;
}

function buildUnsupported(payload: { error?: string; code?: string; details?: { feature?: string; hint?: string } }): UnsupportedInPreviewError {
  const error = new Error(payload.error || "Web API 调用未实现") as UnsupportedInPreviewError;
  error.kind = "unsupported-in-preview";
  if (payload.details?.feature) error.feature = payload.details.feature;
  if (payload.details?.hint) error.hint = payload.details.hint;
  return error;
}

export async function webApi<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(`${localWebApiBaseUrl}${path}`, init);
    const payload = await response.json().catch(() => ({}));
    if (response.status === 501 && payload?.code === "unsupported-in-preview") {
      throw buildUnsupported(payload);
    }
    if (!response.ok) {
      if (["authenticator-error", "authenticator-locked", "ai", "notes"].includes(payload?.code)) throw new PlatformError(payload.error || "操作失败", payload.code);
      throw new Error(payload.error || `Web API ${response.status}`);
    }
    return payload as T;
  } catch (reason) {
    throw normalizePlatformError(reason);
  }
}
