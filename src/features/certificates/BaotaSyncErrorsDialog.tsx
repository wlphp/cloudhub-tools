import { SharedDialog } from "../../shared/SharedDialog";

export type BaotaSyncFailure = { panelId: number; panelName: string; reason: string };

function troubleshooting(reason: string): string {
  if (reason.includes("需要 HTTPS") || reason.includes("非 HTTPS")) return "在宝塔启用面板 SSL，编辑连接为实际 HTTPS 地址。若使用可信的自签名证书，再开启“允许不受信任 HTTPS 证书”；此选项不能用于 HTTP 地址。";
  if (reason.includes("名称")) return "按提示的站点 ID 在宝塔核对名称。名称缺失或含下划线、中文等非标准域名形式会被当前校验拒绝，与 HTTPS 无关。";
  if (reason.includes("超时")) return "确认面板可访问，检查网络、代理、防火墙和面板响应速度，再单独拉取该面板。";
  if (reason.includes("连接") || reason.includes("TLS")) return "先用浏览器确认面板地址和端口可访问；若 HTTPS 使用可信的自签名证书，检查“允许不受信任 HTTPS 证书”。仍失败时检查网络、代理及 TLS 配置。";
  if (reason.includes("HTTP 401") || reason.includes("HTTP 403")) return "检查 API 是否启用、密钥是否有效、当前出口 IP 是否在 API 白名单内，以及安全入口或反向代理限制。";
  if (reason.includes("格式") || reason.includes("标识") || reason.includes("分页")) return "检查面板版本与站点列表数据；在面板核对异常站点后重试。此类问题需要适配返回格式，忽略 HTTPS 证书不能解决。";
  return "单独选择此面板重新获取，核对 API 开关、密钥、IP 白名单及面板版本；本次失败不会清理未拉取到的本地站点记录。";
}

export function BaotaSyncErrorsDialog({ failures, onClose }: { failures: BaotaSyncFailure[]; onClose: () => void }) {
  return <SharedDialog title="站点拉取失败详情" subtitle={`共 ${failures.length} 个面板失败 · 已保留未拉取到的本地记录`} className="baota-sync-errors-dialog" closeLabel="关闭失败详情" onClose={onClose} footer={<button type="button" className="secondary" onClick={onClose}>关闭</button>}>
    <div className="baota-sync-error-head" aria-hidden="true"><span>面板</span><span>失败原因</span><span>排查建议</span></div>
    <ol className="baota-sync-error-list">{failures.map((failure, index) => <li key={failure.panelId}>
      <strong><span className="baota-sync-error-index">{index + 1}.</span> {failure.panelName}</strong>
      <p><span className="baota-sync-error-label">失败原因</span>{failure.reason}</p>
      <p><span className="baota-sync-error-label">排查建议</span>{troubleshooting(failure.reason)}</p>
    </li>)}</ol>
  </SharedDialog>;
}
