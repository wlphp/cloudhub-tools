import { useEffect, useState } from "react";
import { CloudSun, Droplets, RefreshCw, Save } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { defaultPetLife, emptyPetLifeState, desktopPetClient as client, type PetLifeSettings as LifeSettings, type PetLifeState } from "../../platform/clients/desktopPet";
import { platformErrorMessage } from "../../platform/api";

const provinces = ["北京市", "天津市", "河北省", "山西省", "内蒙古自治区", "辽宁省", "吉林省", "黑龙江省", "上海市", "江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省", "河南省", "湖北省", "湖南省", "广东省", "广西壮族自治区", "海南省", "重庆市", "四川省", "贵州省", "云南省", "西藏自治区", "陕西省", "甘肃省", "青海省", "宁夏回族自治区", "新疆维吾尔自治区"];
export function PetLifeSettings({ value, onSave, disabled, petEnabled }: { value: LifeSettings; onSave: (value: LifeSettings) => Promise<void>; disabled: boolean; petEnabled: boolean }) {
  const [draft, setDraft] = useState<LifeSettings>({ ...defaultPetLife, ...value });
  const [state, setState] = useState<PetLifeState>(emptyPetLifeState);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [restText, setRestText] = useState(value?.restDates.join('\n') || "");
  const [workText, setWorkText] = useState(value?.workDates.join('\n') || "");
  useEffect(() => { setDraft({ ...defaultPetLife, ...value }); setRestText(value?.restDates.join('\n') || ""); setWorkText(value?.workDates.join('\n') || ""); }, [value]);
  useEffect(() => {
    let disposed = false;
    void client.lifeState().then(s => { if (!disposed && Array.isArray(s?.notices)) setState(s); }).catch(() => {});
    const sub = listen<PetLifeState>("pet-life-changed", e => { if (!disposed) setState(e.payload); });
    return () => { disposed = true; void sub.then(fn => fn()); };
  }, []);
  const change = (patch: Partial<LifeSettings>) => { setDraft(d => ({ ...d, ...patch })); setError(""); };
  const dirty = JSON.stringify(draft) !== JSON.stringify({ ...defaultPetLife, ...value });
  const check = (key: "enabled" | "weather" | "schedule" | "ignoreHolidays" | "water" | "waterRoam" | "stretch", label: string, description?: string) => <label className="pet-option"><span>{label}{description && <small>{description}</small>}</span><input type="checkbox" checked={draft[key]} onChange={e => change({ [key]: e.target.checked })} /></label>;
  async function run(action: () => Promise<void>) { setLoading(true); setError(""); try { await action(); } catch (e) { setError(platformErrorMessage(e)); } finally { setLoading(false); } }
  async function save() {
    const times = [draft.workStart, draft.lunchStart, draft.lunchEnd, draft.workEnd];
    if (times.some(t => !/^\d{2}:\d{2}$/.test(t)) || !(times[0] < times[1] && times[1] < times[2] && times[2] < times[3])) { setError("请按上班、午休开始、午休结束、下班的顺序设置时间。"); return; }
    if (draft.enabled && draft.weather && !draft.province) { setError("请先选择天气预警的省份。"); return; }
    await run(() => onSave(draft));
  }
  return <article className="pet-control-card pet-life-settings">
    <header><div><strong><CloudSun size={15} aria-hidden="true" />生活陪伴</strong><small>作息问候、天气预警和健康小提醒</small></div><span className={value?.enabled ? "pet-life-enabled" : "pet-life-muted"}>{value?.enabled ? "已开启" : "未开启"}</span></header>
    <details className="pet-settings-disclosure"><summary>地区与生活提醒</summary>
      <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset disabled={disabled || loading}>
          <div className="pet-life-options">{check("enabled", "开启生活提醒", "由桌宠显示气泡；免打扰时暂停。应用退出或休眠时不提醒。")}</div>
          {!petEnabled && <p className="pet-life-help">开启桌宠后显示生活提醒。</p>}
          <section className="pet-life-group" aria-label="地区与天气">
            <h4>地区与天气</h4><div className="pet-life-grid">
              <label>省份<select value={draft.province} onChange={e => change({ province: e.target.value, city: "" })}><option value="">请选择省份</option>{provinces.map(p => <option key={p}>{p}</option>)}</select></label>
              <label>城市 / 区县<input value={draft.city} maxLength={24} placeholder="如：保定（留空关注全省）" onChange={e => change({ city: e.target.value.trim() })} /></label>
            </div><div className="pet-life-options">{check("weather", "灾害天气预警", "中央气象台公开信号，每 15 分钟更新；城市名匹配并包含省级预警。")}</div>
            <p className="pet-life-help">地区手动填写，不读取定位；全国预警在本机筛选。作息统一使用北京时间。</p>
            <div className="pet-life-weather-status"><span>{state.weatherCheckedAt ? `${state.region} · ${state.notices.filter(n => n.kind === "weather" && n.expiresAt > Date.now() / 1000).length} 条预警 · 更新于 ${new Date(state.weatherCheckedAt * 1000).toLocaleString()}` : "尚未查询天气预警"}{state.weatherError && <small role="status">{state.weatherError}；旧记录不代表当前安全状态。</small>}</span><button type="button" className="secondary" disabled={dirty || !value?.enabled || !value?.weather} onClick={() => void run(async () => { setState(await client.lifeWeather()); })}><RefreshCw size={13} />查询预警</button></div>
          </section>
          <section className="pet-life-group" aria-label="工作日作息">
            <h4>工作日作息</h4><div className="pet-life-options">{check("schedule", "作息问候", "上班问好、午餐午休、午休结束、下班收尾与告别。")}</div>
            <div className="pet-life-grid">{([['workStart','上班时间'],['lunchStart','午休开始'],['lunchEnd','午休结束'],['workEnd','下午下班']] as const).map(([key,label]) => <label key={key}>{label}<input type="time" required value={draft[key]} onChange={e => change({ [key]: e.target.value })} /></label>)}
              <label>下班前提醒<select value={draft.leaveBefore} onChange={e => change({ leaveBefore: Number(e.target.value) })}>{[5,10,15,30].map(n => <option key={n} value={n}>提前 {n} 分钟</option>)}</select></label>
            </div><div className="pet-life-options">{check("ignoreHolidays", "忽略法定节假日", "中国大陆 2026 年放假与调休补班；关闭后按周一至周五。")}</div>
            {draft.ignoreHolidays && state.calendarYear > 0 && !state.calendarSupported && <p className="pet-error">尚未内置 {state.calendarYear} 年法定日历，作息和健康提醒暂停；可填写自定义工作日或关闭法定节假日过滤。</p>}
            <details className="pet-life-overrides"><summary>自定义休息与补班（覆盖法定日历）</summary><div className="pet-life-grid">
              <label>额外休息日<textarea rows={2} placeholder="2026-10-16，每行一个日期" value={restText} onChange={e => { setRestText(e.target.value); change({ restDates: e.target.value.split(/[\s,，]+/).filter(Boolean) }); }} /></label>
              <label>额外工作日<textarea rows={2} placeholder="2026-10-17，每行一个日期" value={workText} onChange={e => { setWorkText(e.target.value); change({ workDates: e.target.value.split(/[\s,，]+/).filter(Boolean) }); }} /></label>
            </div></details>
          </section>
          <section className="pet-life-group" aria-label="喝水与活动">
            <h4>喝水与活动</h4><div className="pet-life-options">{check("water", "喝水提醒", "仅在工作时段提醒，午休、下班和休息日暂停。")}</div>
            <div className="pet-life-grid"><label>喝水间隔<select value={draft.waterMinutes} onChange={e => change({ waterMinutes: Number(e.target.value) })}>{[15,30,45,60,90,120].map(n => <option key={n} value={n}>每 {n} 分钟</option>)}</select></label><div className="pet-life-options">{check("waterRoam", "喝水时跑一圈", "持续 12 秒；操作桌宠、打开面板或减少动态时停止。")}</div></div>
            <div className="pet-life-options">{check("stretch", "起身活动提醒", "可选：走动一下、远眺休息；与喝水同时到点时优先提醒喝水。")}</div>
            <div className="pet-life-grid"><label>活动间隔<select value={draft.stretchMinutes} onChange={e => change({ stretchMinutes: Number(e.target.value) })}>{[30,60,90,120].map(n => <option key={n} value={n}>每 {n} 分钟</option>)}</select></label></div>
          </section>
          {error && <p role="alert" className="pet-error">{error}</p>}
          <div className="pet-life-actions"><span>{dirty ? "有未保存的修改" : "设置已保存"}</span><button type="button" className="secondary" disabled={dirty || !value?.enabled || !petEnabled} onClick={() => void run(async () => { await client.lifeAction("", "testWater"); })}><Droplets size={14} />试试喝水提醒</button><button type="submit" className="secondary" disabled={!dirty}><Save size={14} />保存生活提醒</button></div>
        </fieldset>
      </form>
    </details>
  </article>;
}
