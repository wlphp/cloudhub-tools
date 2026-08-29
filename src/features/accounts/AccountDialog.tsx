import type { FormEvent } from "react";
import { Eye, EyeOff, X } from "lucide-react";
import { cloudProvider, cloudProviders, providerSyncDescription } from "../cloud/catalog";
import type { Draft } from "../../shared/types";

type AccountDialogProps = {
  open: boolean;
  draft: Draft;
  showSecret: boolean;
  verifying: boolean;
  onClose: () => void;
  onDraftChange: (draft: Draft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggleSecret: () => void;
  onVerify: () => void;
};

export function AccountDialog({
  open,
  draft,
  showSecret,
  verifying,
  onClose,
  onDraftChange,
  onSubmit,
  onToggleSecret,
  onVerify,
}: AccountDialogProps) {
  if (!open) return null;

  return (
    <div className="modal-backdrop">
      <form className="modal account-editor-modal" onSubmit={onSubmit}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">ACCOUNT</span>
            <h2>{draft.id ? "编辑云账号" : "添加云账号"}</h2>
          </div>
          <button type="button" className="close" title="关闭" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="account-editor-body">
          <p className="security-tip account-key-tip">
            <span>{cloudProvider(draft.cloud_type).secretLabel} 会加密保存在本机。当前支持{providerSyncDescription(draft.cloud_type)}。</span>
            {draft.cloud_type === "aliyun" && <a href="https://ram.console.aliyun.com/profile/access-keys?userCode=jdeqlgm5" target="_blank" rel="noreferrer">获取阿里云 AccessKey ↗</a>}
            {draft.cloud_type === "vultr" && <a href="https://my.vultr.com/settings/#settingsapi" target="_blank" rel="noreferrer">获取 Vultr API Key ↗</a>}
            {draft.cloud_type === "tencent" && <a href="https://console.cloud.tencent.com/cam/capi" target="_blank" rel="noreferrer">获取腾讯云密钥 ↗</a>}
            {draft.cloud_type === "volcengine" && <a href="https://console.volcengine.com/iam/keymanage/" target="_blank" rel="noreferrer">获取火山引擎密钥 ↗</a>}
            {draft.cloud_type === "oracle" && <a href="https://docs.oracle.com/iaas/Content/API/Concepts/apisigningkey.htm" target="_blank" rel="noreferrer">配置 OCI API Key ↗</a>}
          </p>
          <section className="account-editor-section" aria-labelledby="account-config-heading">
            <h3 id="account-config-heading">账号配置</h3>
            <label>账号名称<input required value={draft.account_name} onChange={(event) => onDraftChange({ ...draft, account_name: event.target.value })} placeholder="例如：公司主账号" /></label>
            <div className="form-grid">
              <label>云类型<select value={draft.cloud_type} onChange={(event) => onDraftChange({ ...draft, cloud_type: event.target.value, region_id: draft.region_id || cloudProvider(event.target.value).regionPlaceholder })}>{draft.cloud_type === "other" && <option value="other" disabled>未接入云（历史账号）</option>}{cloudProviders.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</select></label>
              <label>分组<input value={draft.group_name} onChange={(event) => onDraftChange({ ...draft, group_name: event.target.value })} placeholder="公司 / 个人 / 测试" /></label>
              <label>{draft.cloud_type === "baidu" ? "偏好地域（自动扫描全部 BCC 地域）" : "默认地域"}<input value={draft.region_id} onChange={(event) => onDraftChange({ ...draft, region_id: event.target.value })} placeholder={cloudProvider(draft.cloud_type).regionPlaceholder} /></label>
              <label>排序号<input type="number" min="0" value={draft.sort_order} onChange={(event) => onDraftChange({ ...draft, sort_order: Math.max(0, Number(event.target.value) || 0) })} placeholder="数字越小越靠前" /></label>
            </div>
          </section>
          <section className="account-editor-section" aria-labelledby="account-credential-heading">
            <h3 id="account-credential-heading">连接凭据</h3>
            <label>{cloudProvider(draft.cloud_type).idLabel}<input required={draft.cloud_type !== "vultr"} value={draft.access_key_id} onChange={(event) => onDraftChange({ ...draft, access_key_id: event.target.value })} placeholder={draft.cloud_type === "vultr" ? "留空将使用账号名称，仅用于本地识别" : undefined} /></label>
            {draft.cloud_type === "oracle" && <div className="form-grid"><label>Tenancy OCID<input required value={draft.tenancy_ocid} onChange={(event) => onDraftChange({ ...draft, tenancy_ocid: event.target.value })} placeholder="ocid1.tenancy..." /></label><label>Key Fingerprint<input required value={draft.key_fingerprint} onChange={(event) => onDraftChange({ ...draft, key_fingerprint: event.target.value })} placeholder="aa:bb:cc:..." /></label></div>}
            {draft.cloud_type === "azure" && <div className="form-grid"><label>Tenant ID<input required value={draft.tenant_id} onChange={(event) => onDraftChange({ ...draft, tenant_id: event.target.value })} placeholder="Microsoft Entra tenant GUID" /></label><label>Subscription ID<input required value={draft.subscription_id} onChange={(event) => onDraftChange({ ...draft, subscription_id: event.target.value })} placeholder="Azure subscription GUID" /></label></div>}
            {draft.cloud_type === "gcp" && <label>Project ID<input required value={draft.project_id} onChange={(event) => onDraftChange({ ...draft, project_id: event.target.value })} placeholder="Google Cloud project ID" /></label>}
            <label>{cloudProvider(draft.cloud_type).secretLabel}<span className="secret-input-wrap"><input required={!draft.id} type={showSecret ? "text" : "password"} value={draft.access_key_secret} onChange={(event) => onDraftChange({ ...draft, access_key_secret: event.target.value })} placeholder={draft.id ? "留空表示不修改" : `请输入 ${cloudProvider(draft.cloud_type).secretLabel}`} />{draft.cloud_type !== "oracle" && <button type="button" className="secret-eye" aria-label={showSecret ? `隐藏 ${cloudProvider(draft.cloud_type).secretLabel}` : `显示 ${cloudProvider(draft.cloud_type).secretLabel}`} onClick={onToggleSecret}>{showSecret ? <EyeOff size={17} /> : <Eye size={17} />}</button>}</span></label>
          </section>
          <section className="account-editor-section account-editor-options" aria-labelledby="account-options-heading">
            <h3 id="account-options-heading">其他设置</h3>
            <label>备注<textarea value={draft.remark} onChange={(event) => onDraftChange({ ...draft, remark: event.target.value })} rows={2} /></label>
            <label className="toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => onDraftChange({ ...draft, enabled: event.target.checked })} /><span>启用此账号</span></label>
          </section>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>取消</button>
          <button className="primary" type="submit">保存账号</button>
          {draft.id && ["vultr", "ctyun", "huawei", "baidu", "jdcloud", "ucloud", "qingcloud", "ksyun", "qiniu", "aws", "azure", "gcp"].includes(draft.cloud_type) && <button className="secondary" type="button" disabled={verifying} onClick={onVerify}>{verifying ? "验证中…" : "验证账号"}</button>}
        </div>
      </form>
    </div>
  );
}
