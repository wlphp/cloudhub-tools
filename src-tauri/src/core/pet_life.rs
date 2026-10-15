//! Local, restart-safe companion reminders. No model calls or location tracking.
use chrono::{Datelike, NaiveDate, Timelike};
use serde::{Deserialize, Serialize};

pub const PROVINCES: &[&str] = &["北京市", "天津市", "河北省", "山西省", "内蒙古自治区", "辽宁省", "吉林省", "黑龙江省", "上海市", "江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省", "河南省", "湖北省", "湖南省", "广东省", "广西壮族自治区", "海南省", "重庆市", "四川省", "贵州省", "云南省", "西藏自治区", "陕西省", "甘肃省", "青海省", "宁夏回族自治区", "新疆维吾尔自治区"];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LifeSettings {
    pub enabled: bool,
    pub province: String,
    pub city: String,
    pub weather: bool,
    pub schedule: bool,
    pub work_start: String,
    pub lunch_start: String,
    pub lunch_end: String,
    pub work_end: String,
    pub leave_before: u32,
    pub ignore_holidays: bool,
    pub rest_dates: Vec<String>,
    pub work_dates: Vec<String>,
    pub water: bool,
    pub water_minutes: u32,
    pub water_roam: bool,
    pub stretch: bool,
    pub stretch_minutes: u32,
}
impl Default for LifeSettings {
    fn default() -> Self {
        Self { enabled: false, province: String::new(), city: String::new(), weather: false, schedule: true,
            work_start: "09:00".into(), lunch_start: "12:00".into(), lunch_end: "13:30".into(), work_end: "18:00".into(), leave_before: 10,
            ignore_holidays: true, rest_dates: vec![], work_dates: vec![], water: true, water_minutes: 60, water_roam: true, stretch: false, stretch_minutes: 90 }
    }
}
pub fn minute(s: &str) -> Option<u32> {
    if s.len() != 5 || s.as_bytes()[2] != b':' || !s.bytes().enumerate().all(|(i,c)| i == 2 || c.is_ascii_digit()) { return None; }
    let h = s[..2].parse::<u32>().ok()?;
    let m = s[3..].parse::<u32>().ok()?;
    (h < 24 && m < 60).then_some(h * 60 + m)
}
impl LifeSettings {
    pub fn validate(&self) -> Result<(), String> {
        let times = [&self.work_start, &self.lunch_start, &self.lunch_end, &self.work_end].map(|s| minute(s));
        if times.iter().any(Option::is_none) { return Err("作息时间须为 HH:mm".into()); }
        let t = times.map(Option::unwrap);
        if !(t[0] < t[1] && t[1] < t[2] && t[2] < t[3]) || self.leave_before > 60 || self.leave_before >= t[3] - t[2]
            || !(15..=240).contains(&self.water_minutes) || !(30..=240).contains(&self.stretch_minutes)
            || (!self.province.is_empty() && !PROVINCES.contains(&self.province.as_str()))
            || self.city.chars().count() > 24 || !self.city.chars().all(|c| ('\u{4e00}'..='\u{9fff}').contains(&c) || c == '·')
            || (self.enabled && self.weather && self.province.is_empty()) {
            return Err("生活提醒设置无效，请检查地区、时间顺序及提醒间隔".into());
        }
        if self.rest_dates.len() + self.work_dates.len() > 100 || self.rest_dates.iter().chain(&self.work_dates).any(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").is_err() || s.len() != 10)
            || self.rest_dates.iter().any(|s| self.work_dates.contains(s)) {
            return Err("自定义休息日与工作日无效或重复冲突，最多 100 天".into());
        }
        Ok(())
    }
}

// State Council 2026 calendar: https://www.gov.cn/zhengce/content/202511/content_7047090.htm
pub fn workday(date: NaiveDate, config: &LifeSettings) -> Option<bool> {
    let iso = date.format("%Y-%m-%d").to_string();
    if config.rest_dates.contains(&iso) { return Some(false); }
    if config.work_dates.contains(&iso) { return Some(true); }
    if config.ignore_holidays {
        if date.year() != 2026 { return None; }
        let md = date.month() * 100 + date.day();
        if [104, 214, 228, 509, 920, 1010].contains(&md) { return Some(true); }
        if (101..=103).contains(&md) || (215..=223).contains(&md) || (404..=406).contains(&md) || (501..=505).contains(&md)
            || (619..=621).contains(&md) || (925..=927).contains(&md) || (1001..=1007).contains(&md) { return Some(false); }
    }
    Some(date.weekday().number_from_monday() <= 5)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeNotice {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub created_at: i64,
    pub due_at: i64,
    pub expires_at: i64,
    pub acknowledged: bool,
    pub level: u32,
    pub url: Option<String>,
}
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LifeState {
    pub notices: Vec<LifeNotice>,
    pub weather_checked_at: i64,
    pub weather_attempt_at: i64,
    pub weather_error: Option<String>,
    pub region: String,
    pub calendar_year: i32,
    pub calendar_supported: bool,
}
impl LifeState {
    pub fn add(&mut self, notice: LifeNotice) {
        if !self.notices.iter().any(|n| n.id == notice.id) { self.notices.push(notice); }
    }
    pub fn action(&mut self, id: &str, action: &str, now: i64) -> Result<(), String> {
        let n = self.notices.iter_mut().find(|n| n.id == id && n.expires_at > now && !n.acknowledged).ok_or("提醒已过期或不存在")?;
        match action {
            "ack" => n.acknowledged = true,
            "snooze" => { n.due_at = now + 600; n.expires_at = n.expires_at.max(now + 1200); }
            _ => return Err("生活提醒操作无效".into()),
        }
        Ok(())
    }
}
pub fn notice(id: String, kind: &str, title: &str, detail: &str, now: i64) -> LifeNotice {
    LifeNotice { id, kind: kind.into(), title: title.into(), detail: detail.into(), created_at: now, due_at: now, expires_at: now + 900, acknowledged: false, level: 0, url: None }
}

pub fn tick(state: &mut LifeState, config: &LifeSettings, now: i64, quiet: bool) {
    let Some(local) = chrono::DateTime::from_timestamp(now, 0).map(|t| t.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap())) else { return; };
    state.calendar_year = local.year();
    state.calendar_supported = local.year() == 2026;
    // Keep IDs for the whole day and across restarts; never replay expired reminders.
    state.notices.retain(|n| n.created_at > now - 2 * 86400);
    if state.notices.len() > 200 { state.notices.drain(..state.notices.len() - 200); }
    if !config.enabled || workday(local.date_naive(), config) != Some(true) { return; }
    let m = local.hour() * 60 + local.minute();
    let (Some(start), Some(lunch), Some(resume), Some(end)) = (minute(&config.work_start), minute(&config.lunch_start), minute(&config.lunch_end), minute(&config.work_end)) else { return; };
    let today = local.format("%Y-%m-%d").to_string();
    let mut candidates = Vec::new();
    if config.schedule {
        for (at, kind, title, detail) in [
            (start, "work", "主人，早上好！", "新的一天开始啦，先理一理今天的安排，我陪你一起工作。"),
            (lunch, "lunch", "主人，该吃午饭啦", "先保存手头工作，好好吃饭，午休时间放松一下。"),
            (resume, "resume", "午休结束，欢迎回来", "伸个懒腰，慢慢进入下午的节奏。"),
            (end - config.leave_before, "leaveSoon", "快到下班时间啦", "记得保存文件、整理待办，收尾后安心回家。"),
            (end, "leave", "辛苦啦，主人！", "今天的工作告一段落，路上注意安全，回家好好休息。"),
        ] { if m >= at && m - at < 3 { candidates.push(notice(format!("{today}:{kind}"), kind, title, detail, now)); } }
    }
    // Work-period anchoring avoids drift and a burst of overdue reminders after sleep/restart.
    let elapsed = if m >= start && m < lunch { Some(m - start) } else if m >= resume && m < end.saturating_sub(config.leave_before) { Some(m - resume) } else { None };
    if let Some(elapsed) = elapsed {
        for (enabled, interval, kind, title, detail) in [
            (config.water, config.water_minutes, "water", "主人，该喝水啦！", "先放下手头的事情，喝几口水吧，我跑一圈陪你活动活动。"),
            (config.stretch, config.stretch_minutes, "stretch", "起来活动一下吧", "离开座位走一走，看看远处，让眼睛和肩颈休息一下。"),
        ] {
            if enabled && interval > 0 && elapsed >= interval && elapsed % interval < 1 {
                let period = if m < lunch { "am" } else { "pm" };
                candidates.push(notice(format!("{today}:{kind}:{period}:{}", elapsed / interval), kind, title, detail, now));
            }
        }
    }
    // Scheduled greetings take precedence over health nudges in the same minute.
    let mut shown = false;
    for mut n in candidates {
        if quiet || shown { n.acknowledged = true; }
        shown = true;
        state.add(n);
    }
}

pub fn parse_weather(value: &serde_json::Value, config: &LifeSettings, now: i64) -> Result<Vec<LifeNotice>, String> {
    if value.get("code").and_then(|v| v.as_i64()) != Some(0) { return Err("天气预警数据暂不可用".into()); }
    let list = value.pointer("/data/page/list").and_then(|v| v.as_array()).ok_or("天气预警数据格式已变化")?;
    if list.len() > 100 { return Err("天气预警响应超出限制".into()); }
    let mut result = Vec::new();
    for item in list {
        let title = item["title"].as_str().unwrap_or("");
        let id = item["alertid"].as_str().unwrap_or("");
        let issued = item["issuetime"].as_str().and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y/%m/%d %H:%M").ok())
            .and_then(|t| t.and_local_timezone(chrono::FixedOffset::east_opt(28800).unwrap()).single()).map(|t| t.timestamp());
        if title.chars().count() > 160 || !title.starts_with(&config.province) || title.contains("解除") || id.len() > 64 || id.is_empty()
            || !id.bytes().all(|b| b.is_ascii_digit() || b == b'_') { continue; }
        let city = config.city.trim_end_matches('市');
        let provincial = title.starts_with(&format!("{}气象", config.province));
        if !city.is_empty() && !title.contains(city) && !provincial { continue; }
        let Some(issued) = issued.filter(|at| *at <= now + 300 && now - *at <= 86400) else { continue; };
        let mut n = notice(format!("weather:{id}"), "weather", title, "中央气象台公开预警信号。请查看原文，按当地气象部门指引安排出行。", now);
        n.created_at = issued; n.expires_at = issued + 86400;
        n.level = if title.contains("红色") { 3 } else if title.contains("橙色") { 2 } else { 1 };
        n.url = Some(format!("https://www.nmc.cn/publish/alarm/{id}.html"));
        result.push(n);
    }
    Ok(result)
}

pub async fn fetch_weather(config: &LifeSettings, now: i64) -> Result<Vec<LifeNotice>, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(12)).redirect(reqwest::redirect::Policy::none())
        .user_agent("CloudHubTools/1.0").build().map_err(|_| "无法初始化天气查询")?;
    let mut result = Vec::new();
    for page in 1..=20 {
        let mut response = client.get("https://www.nmc.cn/rest/findAlarm").query(&[("pageNo", page), ("pageSize", 100)]).send().await
            .map_err(|_| "天气预警查询失败，请稍后重试")?.error_for_status().map_err(|_| "天气预警服务暂不可用")?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "天气预警读取失败")? {
            if bytes.len() + chunk.len() > 512 * 1024 { return Err("天气预警响应过大".into()); }
            bytes.extend_from_slice(&chunk);
        }
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "天气预警数据格式已变化")?;
        result.extend(parse_weather(&value, config, now)?);
        let pages = value.pointer("/data/page/totalPage").and_then(|v| v.as_u64()).ok_or("天气预警分页无效")?;
        if pages > 20 { return Err("预警数量过多，请到中央气象台查看完整信息".into()); }
        if page as u64 >= pages { return Ok(result); }
    }
    Err("天气预警查询未完成".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(s: &str) -> i64 { chrono::DateTime::parse_from_rfc3339(s).unwrap().timestamp() }
    fn settings() -> LifeSettings { LifeSettings { enabled: true, ..Default::default() } }
    #[tokio::test]
    #[ignore = "manual public endpoint smoke test"]
    async fn pet_life_live_weather() {
        let config = LifeSettings { province: "河北省".into(), city: "保定".into(), ..settings() };
        let now = chrono::Utc::now().timestamp();
        let notices = tokio::time::timeout(std::time::Duration::from_secs(35), fetch_weather(&config, now)).await.unwrap().unwrap();
        assert!(notices.iter().all(|n| n.title.contains("保定") || n.title.starts_with("河北省气象")));
    }
    #[test] fn pet_life_calendar_covers_holidays_makeup_and_unknown_years() {
        let s = settings();
        for (d, expected) in [("2026-10-01", Some(false)), ("2026-10-10", Some(true)), ("2026-02-23", Some(false)), ("2026-02-28", Some(true)), ("2026-10-17", Some(false)), ("2027-01-04", None)] {
            assert_eq!(workday(NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap(), &s), expected);
        }
    }
    #[test] fn pet_life_schedule_deduplicates_after_restart_and_does_not_replay_sleep() {
        let s = settings(); let mut state = LifeState::default();
        tick(&mut state, &s, at("2026-10-15T09:00:00+08:00"), false);
        let mut restored: LifeState = serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        tick(&mut restored, &s, at("2026-10-15T09:01:00+08:00"), false);
        assert_eq!(restored.notices.len(), 1);
        tick(&mut restored, &s, at("2026-10-15T11:21:00+08:00"), false);
        assert_eq!(restored.notices.len(), 1);
    }
    #[test] fn pet_life_custom_calendar_and_all_schedule_boundaries() {
        let mut s = settings();
        s.rest_dates = vec!["2026-10-15".into()];
        let mut state = LifeState::default();
        tick(&mut state, &s, at("2026-10-15T09:00:00+08:00"), false);
        assert!(state.notices.is_empty());
        s.rest_dates.clear(); s.work_dates = vec!["2027-01-04".into()];
        assert_eq!(workday(NaiveDate::from_ymd_opt(2027, 1, 4).unwrap(), &s), Some(true));
        for (time, kind) in [("09:00", "work"), ("12:00", "lunch"), ("13:30", "resume"), ("17:50", "leaveSoon"), ("18:00", "leave")] {
            tick(&mut state, &s, at(&format!("2026-10-15T{time}:00+08:00")), false);
            assert_eq!(state.notices.last().unwrap().kind, kind);
        }
    }
    #[test] fn pet_life_water_obeys_lunch_holidays_quiet_and_snooze() {
        let s = settings(); let mut state = LifeState::default();
        for time in ["2026-10-01T10:00:00+08:00", "2026-10-15T12:30:00+08:00", "2026-10-15T19:00:00+08:00"] { tick(&mut state, &s, at(time), false); }
        assert!(state.notices.is_empty());
        let now = at("2026-10-15T10:00:00+08:00"); tick(&mut state, &s, now, false);
        assert_eq!(state.notices[0].kind, "water");
        let id = state.notices[0].id.clone(); state.action(&id, "snooze", now).unwrap();
        assert_eq!(state.notices[0].due_at, now + 600);
        tick(&mut state, &s, now + 3600, true); assert!(state.notices[1].acknowledged);
    }
    #[test] fn pet_life_validation_rejects_bad_time_region_and_conflicting_dates() {
        let mut s = settings(); s.lunch_end = "08:00".into(); assert!(s.validate().is_err());
        s = settings(); s.city = "../test".into(); assert!(s.validate().is_err());
        s = settings(); s.rest_dates = vec!["2026-10-15".into()]; s.work_dates = s.rest_dates.clone(); assert!(s.validate().is_err());
        assert_eq!(minute("9:00"), None); assert_eq!(minute("24:00"), None);
    }
    #[test] fn pet_life_weather_matches_region_and_preserves_official_identity_only() {
        let s = LifeSettings { province: "河北省".into(), city: "保定".into(), ..settings() };
        let input = serde_json::json!({"code":0,"data":{"page":{"list":[
            {"alertid":"130600_20261015090000","title":"河北省保定市气象台发布暴雨红色预警信号","issuetime":"2026/10/15 09:00","url":"https://example.test"},
            {"alertid":"130100_20261015090000","title":"河北省石家庄市气象台发布暴雨红色预警信号","issuetime":"2026/10/15 09:00"},
            {"alertid":"130000_20261015090000","title":"河北省气象台发布大风蓝色预警信号","issuetime":"2026/10/15 09:00"},
            {"alertid":"130600_20261015080000","title":"河北省保定市气象台解除暴雨红色预警信号","issuetime":"2026/10/15 08:00"}
        ]}}});
        let notices = parse_weather(&input, &s, at("2026-10-15T10:00:00+08:00")).unwrap();
        assert_eq!(notices.len(), 2); assert_eq!(notices[0].level, 3); assert!(notices[0].url.as_ref().unwrap().starts_with("https://www.nmc.cn/publish/alarm/"));
        assert!(parse_weather(&serde_json::json!({"code":500}), &s, 0).is_err());
    }
}
