//! Deterministic alert lifecycle, independent of windows and vendor credentials.
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub key: String,
    pub title: String,
    pub detail: String,
    pub section: String,
    pub severity: String,
    pub active: bool,
    #[serde(default)]
    pub ignored: bool,
    pub first_seen: i64,
    pub updated_at: i64,
    pub snoozed_until: i64,
    pub notified_at: i64,
    pub occurrences: u32,
}

impl Alert {
    pub fn candidate(
        key: String,
        title: String,
        detail: String,
        section: &str,
        severity: &str,
    ) -> Self {
        Self {
            key,
            title,
            detail,
            section: section.into(),
            severity: severity.into(),
            active: true,
            ignored: false,
            first_seen: 0,
            updated_at: 0,
            snoozed_until: 0,
            notified_at: 0,
            occurrences: 0,
        }
    }
}

pub fn severity_rank(severity: &str) -> u8 {
    match severity { "emergency" => 3, "critical" => 2, _ => 1 }
}

pub fn panel_access_alert(id: i64, name: &str, consecutive_failures: u32) -> Option<Alert> {
    (consecutive_failures >= 2).then(|| Alert::candidate(
        format!("panel:{id}:connection"),
        format!("{} 面板访问异常", name.chars().take(90).collect::<String>()),
        "连续两次无法通过配置的接口访问面板。请检查本机网络、面板地址、权限与 API 白名单；此结果不等同于服务器已停机。".into(),
        "panels", "emergency",
    ))
}

pub fn panel_metric_alert(id: i64, name: &str, metric: &str, value: f64, limit: f64, consecutive: u32) -> Option<Alert> {
    if !["cpu", "disk"].contains(&metric) || !(0.0..=100.0).contains(&value) || !(50.0..=100.0).contains(&limit) || value < limit || consecutive < 2 {
        return None;
    }
    let disk = metric == "disk";
    Some(Alert::candidate(
        format!("panel:{id}:metric:{metric}"),
        format!("{} {}", name.chars().take(90).collect::<String>(), if disk { "磁盘空间不足" } else { "CPU 持续偏高" }),
        format!("当前使用率 {value:.1}%，阈值 {limit:.0}%；连续两次巡检超限。{}", if disk { "请及时释放空间或扩容，避免写入失败。" } else { "请核对进程与负载。" }),
        "panels", if disk { "emergency" } else { "warning" },
    ))
}

/// Only resolve exact keys successfully observed this cycle. Network failure is unknown.
pub fn reconcile(
    previous: &mut Vec<Alert>,
    candidates: Vec<Alert>,
    observed_keys: &[String],
    now: i64,
) -> Vec<Alert> {
    for old in previous.iter_mut() {
        if old.active
            && observed_keys.contains(&old.key)
            && !candidates.iter().any(|a| a.key == old.key)
        {
            old.active = false;
            old.updated_at = now;
            old.notified_at = 0;
        }
    }
    let candidate_keys: std::collections::HashSet<_> =
        candidates.iter().map(|a| a.key.clone()).collect();
    for mut next in candidates {
        if let Some(old) = previous.iter_mut().find(|a| a.key == next.key) {
            let changed = severity_rank(&next.severity) > severity_rank(&old.severity) || !old.active;
            if !old.active {
                old.first_seen = now;
                old.occurrences = old.occurrences.saturating_add(1);
            }
            old.active = true;
            old.title = next.title;
            old.detail = next.detail;
            old.severity = next.severity;
            old.updated_at = now;
            if changed {
                old.ignored = false;
                old.notified_at = 0;
                old.snoozed_until = 0;
            }
        } else {
            next.first_seen = now;
            next.updated_at = now;
            next.occurrences = 1;
            previous.push(next);
        }
    }
    let mut notifications = Vec::new();
    for alert in previous.iter_mut() {
        // One reminder per day, plus severity escalation and one recovery notice.
        if !alert.ignored && alert.snoozed_until <= now
            && (!alert.active || candidate_keys.contains(&alert.key))
            && (alert.notified_at == 0 || (alert.active && now - alert.notified_at >= 86_400))
        {
            notifications.push(alert.clone());
            alert.notified_at = now;
        }
    }
    previous.sort_by_key(|a| (std::cmp::Reverse(a.active && !a.ignored), std::cmp::Reverse(a.active), std::cmp::Reverse(severity_rank(&a.severity)), std::cmp::Reverse(a.updated_at)));
    previous.truncate(300);
    notifications
}

pub fn set_ignored(alerts: &mut [Alert], keys: &[String], ignored: bool) {
    for alert in alerts.iter_mut().filter(|a| a.active && keys.contains(&a.key)) {
        alert.ignored = ignored;
        if !ignored { alert.snoozed_until = 0; alert.notified_at = 0; }
    }
}

pub fn expiry_severity(expiry: i64, now: i64, days: i64) -> Option<&'static str> {
    if expiry <= 0 || expiry - now > days * 86_400 {
        None
    } else if expiry - now <= 7 * 86_400 {
        Some("critical")
    } else {
        Some("warning")
    }
}

/// Removing a resource or disabling a rule ends monitoring; it does not prove service recovery.
pub fn retire_missing(alerts: &mut [Alert], prefix: &str, retained_prefixes: &[String], now: i64) {
    for alert in alerts {
        if alert.active
            && alert.key.starts_with(prefix)
            && !retained_prefixes
                .iter()
                .any(|p| alert.key == *p || (p.ends_with(':') && alert.key.starts_with(p)))
        {
            alert.active = false;
            alert.detail = "资源记录已移除或此类监测已关闭，停止提醒；不代表服务已经恢复。".into();
            alert.updated_at = now;
            alert.notified_at = now;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(severity: &str) -> Alert {
        Alert::candidate(
            "panel:1:service:mysql".into(),
            "MySQL".into(),
            "服务停止".into(),
            "panels",
            severity,
        )
    }
    #[test]
    fn ignored_alerts_persist_and_only_reopen_on_escalation_or_new_occurrence() {
        let mut alerts = vec![];
        reconcile(&mut alerts, vec![item("warning")], &[], 100);
        set_ignored(&mut alerts, &[alerts_key()], true);
        let json = serde_json::to_string(&alerts).unwrap();
        let mut alerts: Vec<Alert> = serde_json::from_str(&json).unwrap();
        assert!(alerts[0].active && alerts[0].ignored);
        assert!(reconcile(&mut alerts, vec![item("warning")], &[], 90000).is_empty());
        assert_eq!(reconcile(&mut alerts, vec![item("critical")], &[], 90001).len(), 1);
        assert!(!alerts[0].ignored);
        set_ignored(&mut alerts, &[alerts_key()], true);
        assert!(reconcile(&mut alerts, vec![], &[alerts_key()], 90002).is_empty());
        assert!(!alerts[0].active);
        assert_eq!(reconcile(&mut alerts, vec![item("critical")], &[], 90003).len(), 1);
        set_ignored(&mut alerts, &[alerts_key()], true);
        set_ignored(&mut alerts, &[alerts_key()], false);
        assert_eq!(reconcile(&mut alerts, vec![item("critical")], &[], 90004).len(), 1);
        let mut old: serde_json::Value = serde_json::from_str(&json).unwrap();
        old[0].as_object_mut().unwrap().remove("ignored");
        assert!(!serde_json::from_value::<Vec<Alert>>(old).unwrap()[0].ignored);
    }
    fn alerts_key() -> String { "panel:1:service:mysql".into() }
    #[test]
    fn panel_access_and_disk_require_two_failures_and_reject_invalid_metrics() {
        assert!(panel_access_alert(1, "测试面板", 1).is_none());
        let alert = panel_access_alert(1, "测试面板", 2).unwrap();
        assert_eq!(alert.severity, "emergency");
        assert_eq!(alert.key, "panel:1:connection");
        assert!(alert.detail.contains("不等同于服务器已停机"));
        assert!(panel_metric_alert(1, "测试面板", "disk", 90., 90., 1).is_none());
        assert!(panel_metric_alert(1, "测试面板", "disk", 89., 90., 2).is_none());
        assert!(panel_metric_alert(1, "测试面板", "disk", f64::NAN, 90., 2).is_none());
        assert!(panel_metric_alert(1, "测试面板", "disk", 101., 90., 2).is_none());
        assert_eq!(panel_metric_alert(1, "测试面板", "disk", 90., 90., 2).unwrap().severity, "emergency");
        assert_eq!(panel_metric_alert(1, "测试面板", "cpu", 90., 90., 2).unwrap().severity, "warning");
    }
    #[test]
    fn emergency_escalation_resets_ignore_and_snooze_and_sorts_before_newer_alerts() {
        let mut alerts = vec![];
        reconcile(&mut alerts, vec![item("critical")], &[], 100);
        alerts[0].ignored = true;
        alerts[0].snoozed_until = 10000;
        assert_eq!(reconcile(&mut alerts, vec![item("emergency")], &[], 101).len(), 1);
        assert!(!alerts[0].ignored);
        assert_eq!(alerts[0].snoozed_until, 0);
        let other = Alert::candidate("asset:2".into(), "服务器".into(), "到期".into(), "resources", "warning");
        reconcile(&mut alerts, vec![other], &[], 102);
        assert_eq!(alerts[0].severity, "emergency");
        assert!(reconcile(&mut alerts, vec![item("emergency")], &[], 103).is_empty());
    }
    #[test]
    fn deduplicate_escalate_snooze_recover_and_reopen() {
        let mut alerts = vec![];
        assert_eq!(
            reconcile(&mut alerts, vec![item("warning")], &[], 100).len(),
            1
        );
        assert!(reconcile(&mut alerts, vec![item("warning")], &[], 101).is_empty());
        alerts[0].snoozed_until = 1000;
        assert!(reconcile(&mut alerts, vec![item("warning")], &[], 102).is_empty());
        assert_eq!(
            reconcile(&mut alerts, vec![item("critical")], &[], 103).len(),
            1
        );
        assert!(reconcile(&mut alerts, vec![], &[], 104).is_empty());
        assert!(alerts[0].active, "unknown source must not resolve a fault");
        assert_eq!(
            reconcile(&mut alerts, vec![], &["panel:1:service:mysql".into()], 105).len(),
            1
        );
        assert!(!alerts[0].active);
        assert!(reconcile(&mut alerts, vec![], &["panel:1:service:mysql".into()], 106).is_empty());
        assert_eq!(
            reconcile(&mut alerts, vec![item("critical")], &[], 107).len(),
            1
        );
        assert_eq!(alerts[0].occurrences, 2);
    }
    #[test]
    fn exact_observation_does_not_resolve_other_ids_or_repeat_unknown_faults() {
        let mut alerts = vec![];
        reconcile(
            &mut alerts,
            vec![Alert::candidate(
                "cert:10".into(),
                "证书".into(),
                "即将到期".into(),
                "certificates",
                "warning",
            )],
            &[],
            100,
        );
        assert!(reconcile(&mut alerts, vec![], &["cert:1".into()], 100 + 86401).is_empty());
        assert!(alerts[0].active);
        assert_eq!(
            reconcile(&mut alerts, vec![], &["cert:10".into()], 100 + 86402).len(),
            1
        );
        assert!(!alerts[0].active);
    }
    #[test]
    fn removing_monitored_resources_preserves_history_without_a_false_recovery_notice() {
        let mut alerts = vec![];
        reconcile(&mut alerts, vec![item("critical")], &[], 100);
        retire_missing(&mut alerts, "panel:", &["panel:10:".into()], 101);
        assert!(!alerts[0].active);
        assert!(alerts[0].detail.contains("不代表服务已经恢复"));
        assert!(reconcile(&mut alerts, vec![], &[], 102).is_empty());
    }
    #[test]
    fn expiry_unknown_boundary_and_escalation() {
        assert_eq!(expiry_severity(0, 100, 30), None);
        assert_eq!(expiry_severity(100 + 31 * 86400, 100, 30), None);
        assert_eq!(expiry_severity(100 + 30 * 86400, 100, 30), Some("warning"));
        assert_eq!(expiry_severity(100 + 7 * 86400, 100, 30), Some("critical"));
        assert_eq!(expiry_severity(99, 100, 30), Some("critical"));
    }
}
