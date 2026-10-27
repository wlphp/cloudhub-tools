use crate::core::{
    database::open_db,
    error::PlatformResult,
    lan::{self, discovery, fingerprint, repository, Device, Interface, Scan},
};
use serde::Serialize;
use std::{
    net::Ipv4Addr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::State;

#[derive(Default)]
pub struct LanStore {
    job: Mutex<Option<Arc<Job>>>,
}
struct Job {
    scan: Mutex<Scan>,
    cancel: AtomicBool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    devices: Vec<Device>,
    history: Vec<Scan>,
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        Err("仅主窗口可以操作局域网设备".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn lan_interfaces(window: tauri::WebviewWindow) -> PlatformResult<Vec<Interface>> {
    main_window(&window)?;
    Ok(tauri::async_runtime::spawn_blocking(discovery::interfaces)
        .await
        .map_err(|_| "读取网卡任务失败")??)
}
#[tauri::command]
pub(crate) fn lan_status(
    window: tauri::WebviewWindow,
    state: State<'_, LanStore>,
) -> PlatformResult<Option<Scan>> {
    main_window(&window)?;
    let job = state.job.lock().map_err(|_| "扫描状态不可用")?.clone();
    Ok(match job {
        Some(job) => Some(job.scan.lock().map_err(|_| "扫描状态不可用")?.clone()),
        None => None,
    })
}
#[tauri::command]
pub(crate) async fn lan_start(
    window: tauri::WebviewWindow,
    state: State<'_, LanStore>,
    interface_id: String,
    source_ip: String,
    network_key: String,
    range: String,
    ports: Vec<u16>,
) -> PlatformResult<Scan> {
    main_window(&window)?;
    let interface = tauri::async_runtime::spawn_blocking(discovery::interfaces)
        .await
        .map_err(|_| "读取网卡任务失败")??
        .into_iter()
        .find(|i| i.id == interface_id && i.ip == source_ip && i.network_key == network_key)
        .ok_or("网络已变化，请刷新网卡后重试")?;
    let targets = discovery::targets(&range, &interface)?;
    let mut ports = ports;
    ports.sort_unstable();
    ports.dedup();
    if ports.is_empty() || ports.len() > 32 || ports.contains(&0) {
        return Err("请选择 1–32 个有效 TCP 端口".into());
    }
    let scan = Scan {
        id: uuid::Uuid::new_v4().to_string(),
        network_key,
        interface_id,
        range,
        status: "running".into(),
        completed: 0,
        total: targets.len(),
        started_at: lan::now(),
        finished_at: None,
        devices: vec![],
        warnings: vec![],
    };
    let job = Arc::new(Job {
        scan: Mutex::new(scan.clone()),
        cancel: AtomicBool::new(false),
    });
    {
        let mut current = state.job.lock().map_err(|_| "扫描状态不可用")?;
        if let Some(active) = current.as_ref() {
            if active.scan.lock().map_err(|_| "扫描状态不可用")?.status == "running" {
                return Err("已有扫描正在运行，请先停止".into());
            }
        }
        *current = Some(job.clone());
    }
    tauri::async_runtime::spawn(async move {
        let worker = job.clone();
        let outcome =
            tauri::async_runtime::spawn(
                async move { run(worker, interface, targets, ports).await },
            )
            .await;
        if outcome.is_err() {
            if let Ok(mut s) = job.scan.lock() {
                s.status = "failed".into();
                s.finished_at = Some(lan::now());
                s.warnings.push("扫描任务异常结束，请重试".into());
            }
        }
    });
    Ok(scan)
}

async fn probe(
    job: &Arc<Job>,
    interface: &Interface,
    source: Ipv4Addr,
    targets: Vec<Ipv4Addr>,
    ports: Vec<u16>,
) -> bool {
    let mut workers = tokio::task::JoinSet::new();
    let mut addresses = targets.into_iter();
    let mut last_network_check = std::time::Instant::now();
    let mut changed = false;
    loop {
        if job.cancel.load(Ordering::Relaxed) {
            workers.abort_all();
            while workers.join_next().await.is_some() {}
            break;
        }
        while workers.len() < 16 {
            let Some(ip) = addresses.next() else {
                break;
            };
            let ports = ports.clone();
            workers.spawn(async move {
                let ping = tokio::task::spawn_blocking(move || {
                    let start = std::time::Instant::now();
                    (
                        discovery::ping(ip, source),
                        start.elapsed().as_millis() as u64,
                    )
                });
                let mut probes = tokio::task::JoinSet::new();
                for port in ports {
                    probes.spawn(async move { (port, discovery::tcp(ip, source, port).await) });
                }
                let mut d = Device {
                    ip: ip.to_string(),
                    last_seen: lan::now(),
                    ..Device::default()
                };
                let mut response = ip == source;
                while let Some(result) = probes.join_next().await {
                    if let Ok((port, (alive, open, elapsed))) = result {
                        if alive {
                            response = true;
                            d.latency_ms =
                                Some(d.latency_ms.map_or(elapsed, |old| old.min(elapsed)));
                        }
                        if open {
                            d.ports.push(port);
                            d.evidence.push(format!("TCP {port} 开放"));
                        }
                    }
                }
                if let Ok((true, elapsed)) = ping.await {
                    response = true;
                    d.evidence.push("ICMP 响应".into());
                    if d.latency_ms.is_none() {
                        d.latency_ms = Some(elapsed);
                    }
                }
                if response && d.evidence.is_empty() {
                    d.evidence.push(if ip == source {
                        "本机地址".into()
                    } else {
                        "TCP 拒绝连接响应".into()
                    });
                }
                d.ports.sort_unstable();
                if response {
                    fingerprint::identify(&mut d, source).await;
                }
                (response, d)
            });
        }
        if workers.is_empty() {
            break;
        }
        tokio::select! {
            result = workers.join_next() => {
                if let Some(result) = result {
                    if let Ok(mut s) = job.scan.lock() {
                        s.completed += 1;
                        match result { Ok((true, mut d)) => { discovery::classify(&mut d, &interface.gateway, &interface.ip); s.devices.push(d); }, Ok(_) => {}, Err(_) => { if !s.warnings.iter().any(|w| w == "部分地址探测失败") { s.warnings.push("部分地址探测失败".into()); } } }
                    }
                }
            },
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {},
        }
        if last_network_check.elapsed().as_secs() >= 15 {
            let expected = interface.clone();
            changed = !tauri::async_runtime::spawn_blocking(move || {
                discovery::interfaces().map(|rows| {
                    rows.iter().any(|i| {
                        i.id == expected.id
                            && i.ip == expected.ip
                            && i.network_key == expected.network_key
                    })
                })
            })
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false);
            last_network_check = std::time::Instant::now();
            if changed {
                job.cancel.store(true, Ordering::Relaxed);
            }
        }
    }
    changed
}

async fn run(job: Arc<Job>, interface: Interface, targets: Vec<Ipv4Addr>, ports: Vec<u16>) {
    let source: Ipv4Addr = match interface.ip.parse() {
        Ok(v) => v,
        Err(_) => {
            if let Ok(mut s) = job.scan.lock() {
                s.status = "failed".into();
                s.finished_at = Some(lan::now());
                s.warnings.push("网卡地址无效，请刷新网卡后重试".into());
            }
            return;
        }
    };
    let mut changed = probe(&job, &interface, source, targets, ports).await;
    let lookup = interface.clone();
    let neighbors =
        tauri::async_runtime::spawn_blocking(move || discovery::neighbors(&lookup)).await;
    #[cfg(windows)]
    let names = if !changed && !job.cancel.load(Ordering::Relaxed) {
        let ips = job
            .scan
            .lock()
            .map(|s| {
                s.devices
                    .iter()
                    .filter_map(|d| d.ip.parse().ok())
                    .collect::<Vec<Ipv4Addr>>()
            })
            .unwrap_or_default();
        tauri::async_runtime::spawn_blocking(move || discovery::hostnames(&ips))
            .await
            .unwrap_or_default()
    } else {
        std::collections::HashMap::<String, String>::new()
    };
    if !changed {
        let expected = interface.clone();
        changed = !tauri::async_runtime::spawn_blocking(move || {
            discovery::interfaces().map(|rows| {
                rows.iter().any(|i| {
                    i.id == expected.id
                        && i.ip == expected.ip
                        && i.network_key == expected.network_key
                })
            })
        })
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(false);
    }
    // Cache entries enrich responding devices; stale ARP is never counted as online evidence.
    if let Ok(mut s) = job.scan.lock() {
        match neighbors {
            Ok(Ok(rows)) => {
                for d in &mut s.devices {
                    if let Some((mac, hostname)) = rows.get(&d.ip) {
                        d.mac = mac.clone();
                        d.hostname = hostname.clone();
                        discovery::classify(d, &interface.gateway, &interface.ip);
                        d.evidence.sort();
                        d.evidence.dedup();
                    }
                }
            }
            _ => s.warnings.push("未能读取邻居表，MAC 信息可能缺失".into()),
        }
        #[cfg(windows)]
        for d in &mut s.devices {
            if let Some(name) = names.get(&d.ip) {
                d.hostname = name.clone();
            }
        }
        if changed {
            s.warnings
                .push("网络连接发生变化，扫描已停止；本次结果未写入台账".into());
        }
        s.devices
            .sort_by_key(|d| d.ip.parse::<Ipv4Addr>().map(u32::from).unwrap_or(0));
    }
    // Keep status running through persistence, preventing a new scan/annotation race.
    let mut final_scan = match job.scan.lock() {
        Ok(s) => s.clone(),
        Err(_) => return,
    };
    final_scan.status = if changed {
        "failed"
    } else if job.cancel.load(Ordering::Relaxed) {
        "cancelled"
    } else {
        "completed"
    }
    .into();
    final_scan.finished_at = Some(lan::now());
    if !changed {
        let saved = final_scan.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            repository::save_scan(&mut open_db()?, &saved)
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            final_scan.status = "failed".into();
            final_scan
                .warnings
                .push("扫描结果未能保存到本地台账，请重试".into());
        }
    }
    if let Ok(mut s) = job.scan.lock() {
        *s = final_scan;
    }
}

#[tauri::command]
pub(crate) fn lan_cancel(
    window: tauri::WebviewWindow,
    state: State<'_, LanStore>,
    id: String,
) -> PlatformResult<()> {
    main_window(&window)?;
    if let Some(job) = state.job.lock().map_err(|_| "扫描状态不可用")?.as_ref() {
        if job.scan.lock().map_err(|_| "扫描状态不可用")?.id == id {
            job.cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn lan_ledger(
    window: tauri::WebviewWindow,
    network_key: String,
) -> PlatformResult<Ledger> {
    main_window(&window)?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        Ok::<_, String>(Ledger {
            devices: repository::devices(&conn, &network_key)?,
            history: repository::history(&conn, &network_key)?,
        })
    })
    .await
    .map_err(|_| "读取台账任务失败")??)
}
#[tauri::command]
pub(crate) fn lan_annotate(
    window: tauri::WebviewWindow,
    state: State<'_, LanStore>,
    input: repository::Annotation,
) -> PlatformResult<()> {
    main_window(&window)?;
    let guard = state.job.lock().map_err(|_| "扫描状态不可用")?;
    if let Some(job) = guard.as_ref() {
        if job.scan.lock().map_err(|_| "扫描状态不可用")?.status == "running" {
            return Err("请等待扫描完成后修改台账".into());
        }
    }
    Ok(repository::annotate(&open_db()?, &input)?)
}
#[tauri::command]
pub(crate) async fn lan_export(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    network_key: String,
    format: String,
) -> PlatformResult<Option<String>> {
    main_window(&window)?;
    if format != "csv" && format != "json" {
        return Err("导出格式无效".into());
    }
    Ok(tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let rows = repository::devices(&open_db()?, &network_key)?;
        let content = if format == "json" {
            serde_json::to_string_pretty(&rows).map_err(|_| "导出数据序列化失败")?
        } else {
            let mut csv = String::from(
                "\u{feff}IP,MAC,主机名,厂商,类型,操作系统,系统识别状态,型号,MAC类型,识别依据,别名,备注,标签,收藏,端口,最近发现时间\r\n",
            );
            for d in rows {
                let os = if d.manual_os.is_empty() { d.os.clone() } else { d.manual_os.clone() };
                let os_status = if !d.manual_os.is_empty() { "手动标记" } else if d.os.is_empty() { "未识别" } else if d.os_status == "identified" { "已识别（本机）" } else { "推测" };
                let kind = if d.manual_kind.is_empty() {
                    d.kind
                } else {
                    d.manual_kind
                };
                let cells = [
                    d.ip,
                    d.mac,
                    d.hostname,
                    d.vendor,
                    kind,
                    os,
                    os_status.into(),
                    d.model,
                    d.mac_kind,
                    d.evidence.join(";"),
                    d.alias,
                    d.note,
                    d.tags,
                    d.favorite.to_string(),
                    d.ports
                        .iter()
                        .map(u16::to_string)
                        .collect::<Vec<_>>()
                        .join(";"),
                    d.last_seen.to_string(),
                ];
                csv.push_str(
                    &cells
                        .iter()
                        .map(|v| repository::csv_cell(v))
                        .collect::<Vec<_>>()
                        .join(","),
                );
                csv.push_str("\r\n");
            }
            csv
        };
        let Some(file) = app
            .dialog()
            .file()
            .set_title("导出局域网设备台账")
            .set_file_name(format!("局域网设备.{}", format))
            .add_filter("设备台账", &[format.as_str()])
            .blocking_save_file()
        else {
            return Ok::<_, String>(None);
        };
        let mut path = file.into_path().map_err(|_| "导出路径无效")?;
        if path.extension().is_none() {
            path.set_extension(&format);
        }
        if !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case(&format))
        {
            return Err("请使用所选导出格式的扩展名".into());
        }
        std::fs::write(&path, content).map_err(|_| "导出失败，请检查保存目录权限")?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| "导出台账任务失败")??)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Arc<Job>, Interface) {
        let i = Interface {
            id: "fixture".into(),
            name: "fixture".into(),
            ip: "127.0.0.1".into(),
            prefix: 8,
            gateway: String::new(),
            network: "fixture".into(),
            network_key: "a".repeat(64),
            suggested_range: String::new(),
        };
        let s = Scan {
            id: "fixture".into(),
            network_key: i.network_key.clone(),
            interface_id: i.id.clone(),
            range: i.ip.clone(),
            status: "running".into(),
            completed: 0,
            total: 1024,
            started_at: lan::now(),
            finished_at: None,
            devices: vec![],
            warnings: vec![],
        };
        (
            Arc::new(Job {
                scan: Mutex::new(s),
                cancel: AtomicBool::new(false),
            }),
            i,
        )
    }
    #[tokio::test]
    async fn cancellation_bounds_work_and_does_not_probe_remaining_addresses() {
        let (job, i) = fixture();
        let cancel = job.clone();
        let stop = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            cancel.cancel.store(true, Ordering::Relaxed);
        });
        let changed = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            probe(
                &job,
                &i,
                Ipv4Addr::LOCALHOST,
                vec![Ipv4Addr::LOCALHOST; 1024],
                vec![9],
            ),
        )
        .await
        .expect("cancel must stop pending work");
        stop.await.unwrap();
        assert!(!changed);
        assert!(job.scan.lock().unwrap().completed < 1024);
    }
    #[tokio::test]
    async fn invalid_interface_finalizes_failure_without_touching_storage() {
        let (job, mut i) = fixture();
        i.ip = "invalid".into();
        run(job.clone(), i, vec![], vec![22]).await;
        let s = job.scan.lock().unwrap();
        assert_eq!(s.status, "failed");
        assert!(s.finished_at.is_some());
    }
}
