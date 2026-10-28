use rand::RngCore;
use reqwest::{Client, Url};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    task::JoinSet,
    time::{timeout, timeout_at, Instant},
};

const MIB: u64 = 1024 * 1024;
const QINIU_DOWNLOAD: &str = "https://devtools.qiniu.com/linux/amd64/qrsctl";
const ALIPAY_DOWNLOAD: &str = "https://gw.alipayobjects.com/os/volans-demo/93211a67-0eed-40ff-8a48-f6c137a88781/MiniProgramStudio-3.1.3.exe";
pub mod network_info;

fn download_only(base: &Url) -> bool {
    [QINIU_DOWNLOAD, ALIPAY_DOWNLOAD].contains(&base.as_str())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub node: String,
    pub base_url: String,
    pub duration_secs: u64,
    pub limit_mib: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub seconds: f64,
    pub mbps: f64,
    pub direction: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub node: String,
    pub endpoint: String,
    pub colo: String,
    pub status: String,
    pub phase: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub elapsed_secs: f64,
    pub duration_secs: u64,
    pub limit_mib: u64,
    pub download_mbps: Option<f64>,
    pub upload_mbps: Option<f64>,
    pub latency_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub traffic_bytes: u64,
    pub points: Vec<Point>,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}
pub struct Job {
    pub run: Mutex<Run>,
    pub cancel: AtomicBool,
    pub traffic: AtomicU64,
    pub started: Instant,
}
impl Job {
    pub fn new(config: &Config) -> Result<Self, String> {
        let endpoint = validate(config)?;
        Ok(Self {
            run: Mutex::new(Run {
                id: uuid::Uuid::new_v4().to_string(),
                node: config.node.clone(),
                endpoint: endpoint.to_string(),
                colo: String::new(),
                status: "running".into(),
                phase: "connecting".into(),
                started_at: chrono::Utc::now().timestamp_millis(),
                finished_at: None,
                elapsed_secs: 0.0,
                duration_secs: config.duration_secs,
                limit_mib: config.limit_mib,
                download_mbps: None,
                upload_mbps: None,
                latency_ms: None,
                jitter_ms: None,
                traffic_bytes: 0,
                points: vec![],
                warnings: vec![],
                error: None,
            }),
            cancel: AtomicBool::new(false),
            traffic: AtomicU64::new(0),
            started: Instant::now(),
        })
    }
    pub fn snapshot(&self) -> Result<Run, String> {
        let mut result = self.run.lock().map_err(|_| "测速状态不可用")?.clone();
        result.traffic_bytes = self.traffic.load(Ordering::Relaxed);
        if result.status == "running" {
            result.elapsed_secs = self.started.elapsed().as_secs_f64();
        }
        Ok(result)
    }
}

pub fn validate(config: &Config) -> Result<Url, String> {
    if ![5, 10, 15].contains(&config.duration_secs) || ![50, 200, 500].contains(&config.limit_mib) {
        return Err("测速时长或流量上限无效".into());
    }
    let raw = match config.node.as_str() {
        "cn-qiniu" => return Url::parse(QINIU_DOWNLOAD).map_err(|_| "测速节点无效".into()),
        "cn-alipay" => return Url::parse(ALIPAY_DOWNLOAD).map_err(|_| "测速节点无效".into()),
        "cloudflare" => "https://speed.cloudflare.com/",
        "custom" => config.base_url.trim(),
        _ => return Err("测速节点无效".into()),
    };
    let mut url = Url::parse(raw).map_err(|_| "测速节点必须是公网 HTTPS 地址")?;
    if raw.len() > 512
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("测速节点必须是无凭据、查询参数及片段的公网 HTTPS 地址".into());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_broadcast()
                && !ip.is_documentation()
                && a != 0
                && a < 224
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 198 && (b == 18 || b == 19))
                && !(a == 192 && b == 0)
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Global unicast only; exclude documentation and transition ranges.
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && (s[1] == 0xdb8 || s[1] < 0x200))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}
async fn client(url: &Url) -> Result<Client, String> {
    let host = url
        .host_str()
        .ok_or("测速节点无效")?
        .trim_matches(['[', ']']);
    let port = url.port_or_known_default().ok_or("测速节点无效")?;
    let addresses: Vec<SocketAddr> = timeout(
        Duration::from_secs(8),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| "测速节点解析超时")?
    .map_err(|_| "测速节点解析失败")?
    .collect();
    if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
        return Err("测速节点必须解析到公网地址".into());
    }
    // Pin the validated DNS result. No proxy, redirects, cookies or authentication.
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .user_agent("CloudHubTools-NetworkSpeed/1")
        .build()
        .map_err(|_| "无法创建测速连接".into())
}
async fn cancelled(job: &Job) {
    while !job.cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
fn endpoint(base: &Url, direction: &str, bytes: u64) -> Url {
    if download_only(base) {
        return base.clone();
    }
    let mut result = base
        .join(if direction == "download" {
            "__down"
        } else {
            "__up"
        })
        .expect("validated base URL");
    if direction == "download" {
        result
            .query_pairs_mut()
            .append_pair("bytes", &bytes.to_string())
            .append_pair("nonce", &uuid::Uuid::new_v4().to_string());
    }
    result
}
async fn bounded_body(mut response: reqwest::Response, max: usize) -> Result<(), String> {
    let mut bytes = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| "测速节点响应中断")? {
        bytes += chunk.len();
        if bytes > max {
            return Err("测速节点响应超过协议限制".into());
        }
    }
    Ok(())
}
async fn latency(job: &Job, client: &Client, base: &Url) -> Result<(), String> {
    job.run.lock().map_err(|_| "测速状态不可用")?.phase = "latency".into();
    let mut samples = vec![];
    for index in 0..7 {
        let began = Instant::now();
        let mut request = client
            .get(endpoint(base, "download", 0))
            .header("Accept-Encoding", "identity");
        if download_only(base) {
            request = request.header("Range", "bytes=0-0");
        } else {
            request = request.header("Cache-Control", "no-cache");
        }
        let response = request.send().await.map_err(|_| "测速节点连接失败或超时")?;
        if !response.status().is_success() {
            return Err("测速节点拒绝请求，请稍后重试或切换节点".into());
        }
        if let Some(colo) = response
            .headers()
            .get("cf-meta-colo")
            .and_then(|v| v.to_str().ok())
            .filter(|v| v.len() <= 12 && v.bytes().all(|b| b.is_ascii_alphanumeric()))
        {
            job.run.lock().map_err(|_| "测速状态不可用")?.colo = colo.into();
        }
        if download_only(base) {
            validate_range(&response, 1)?;
        }
        bounded_body(response, if download_only(base) { 1 } else { 0 }).await?;
        if index > 0 {
            samples.push(began.elapsed().as_secs_f64() * 1000.0);
        }
    }
    let jitter =
        samples.windows(2).map(|p| (p[1] - p[0]).abs()).sum::<f64>() / (samples.len() - 1) as f64;
    samples.sort_by(f64::total_cmp);
    let mut run = job.run.lock().map_err(|_| "测速状态不可用")?;
    run.latency_ms = Some((samples[2] + samples[3]) / 2.0);
    run.jitter_ms = Some(jitter);
    Ok(())
}
fn reserve(budget: &AtomicU64, wanted: u64) -> u64 {
    let mut old = budget.load(Ordering::Relaxed);
    loop {
        let size = old.min(wanted);
        if size == 0 {
            return 0;
        }
        match budget.compare_exchange_weak(old, old - size, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return size,
            Err(next) => old = next,
        }
    }
}
fn mbps(bytes: u64, seconds: f64) -> f64 {
    bytes as f64 * 8.0 / seconds.max(0.001) / 1_000_000.0
}

fn validate_range(response: &reqwest::Response, amount: u64) -> Result<(), String> {
    let valid = valid_content_range(
        response
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok()),
        amount,
    );
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT || !valid {
        return Err("国内节点未返回有效范围数据，请切换节点".into());
    }
    Ok(())
}
fn valid_content_range(value: Option<&str>, amount: u64) -> bool {
    amount > 0
        && value
            .and_then(|value| value.strip_prefix(&format!("bytes 0-{}/", amount - 1)))
            .and_then(|total| total.parse::<u64>().ok())
            .is_some_and(|total| total >= amount)
}

async fn worker(
    job: Arc<Job>,
    client: Client,
    base: Url,
    direction: &'static str,
    budget: Arc<AtomicU64>,
    measured: Arc<AtomicU64>,
    deadline: Instant,
) -> Result<(), String> {
    let mut size = 256 * 1024;
    while Instant::now() < deadline && !job.cancel.load(Ordering::Relaxed) {
        let amount = reserve(&budget, size);
        if amount == 0 {
            break;
        }
        let began = Instant::now();
        let request = async {
            if direction == "download" {
                let mut request = client
                    .get(endpoint(&base, direction, amount))
                    .header("Accept-Encoding", "identity");
                if download_only(&base) {
                    request = request.header("Range", format!("bytes=0-{}", amount - 1));
                } else {
                    request = request.header("Cache-Control", "no-cache");
                }
                let mut response = request.send().await.map_err(|_| "下载测速连接失败或超时")?;
                if !response.status().is_success()
                    || response.headers().contains_key("content-encoding")
                    || !download_only(&base) && response.headers().contains_key("age")
                {
                    return Err("下载测速节点拒绝请求或返回缓存/压缩内容".into());
                }
                if download_only(&base) {
                    validate_range(&response, amount)?;
                }
                let mut received = 0;
                while let Some(chunk) = response.chunk().await.map_err(|_| "下载测速中断")? {
                    let accepted = (chunk.len() as u64).min(amount - received);
                    job.traffic.fetch_add(accepted, Ordering::Relaxed);
                    measured.fetch_add(accepted, Ordering::Relaxed);
                    received += accepted;
                    if chunk.len() as u64 > accepted {
                        return Err("下载测速节点返回数据超出请求大小".into());
                    }
                }
                if received != amount {
                    return Err("下载测速节点返回的数据不完整".into());
                }
            } else {
                let mut payload = vec![0; amount as usize];
                rand::thread_rng().fill_bytes(&mut payload);
                // Conservative traffic estimate: cancelled requests may send only part of this body.
                job.traffic.fetch_add(amount, Ordering::Relaxed);
                let response = client
                    .post(endpoint(&base, direction, 0))
                    .header("Content-Type", "application/octet-stream")
                    .body(payload)
                    .send()
                    .await
                    .map_err(|_| "上传测速连接失败或超时")?;
                if !response.status().is_success() {
                    return Err("上传测速节点拒绝请求".into());
                }
                bounded_body(response, 4096).await?;
                measured.fetch_add(amount, Ordering::Relaxed);
            }
            Ok::<_, String>(())
        };
        tokio::select! {
            biased;
            _ = cancelled(&job) => break,
            result = timeout_at(deadline, request) => match result { Ok(result) => result?, Err(_) => break },
        }
        if began.elapsed() < Duration::from_millis(500) {
            size = (size * 2).min(4 * MIB);
        }
    }
    Ok(())
}
async fn transfer(
    job: &Arc<Job>,
    client: &Client,
    base: &Url,
    direction: &'static str,
) -> Result<(), String> {
    let (seconds, limit) = {
        let mut run = job.run.lock().map_err(|_| "测速状态不可用")?;
        run.phase = direction.into();
        let divisor = if run.node.starts_with("cn-") { 1 } else { 2 };
        (run.duration_secs, run.limit_mib * MIB / divisor)
    };
    let began = Instant::now();
    let budget = Arc::new(AtomicU64::new(limit));
    let measured = Arc::new(AtomicU64::new(0));
    let mut workers = JoinSet::new();
    for _ in 0..4 {
        workers.spawn(worker(
            job.clone(),
            client.clone(),
            base.clone(),
            direction,
            budget.clone(),
            measured.clone(),
            began + Duration::from_secs(seconds),
        ));
    }
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    tick.tick().await;
    let mut previous = (Instant::now(), 0);
    let mut failure = None;
    while !workers.is_empty() {
        tokio::select! {
            _ = cancelled(job) => { workers.abort_all(); break; },
            result = workers.join_next() => {
                match result { Some(Ok(Ok(()))) => {}, _ => {
                    failure = Some(match result { Some(Ok(Err(error))) => error, _ => "测速任务意外中断".into() });
                    workers.abort_all(); break;
                }}
            },
            _ = tick.tick() => {
                let count = measured.load(Ordering::Relaxed);
                let now = Instant::now();
                let mut run = job.run.lock().map_err(|_| "测速状态不可用")?;
                run.points.push(Point { seconds: job.started.elapsed().as_secs_f64(), mbps: mbps(count - previous.1, (now - previous.0).as_secs_f64()), direction: direction.into() });
                let speed = (count > 0).then(|| mbps(count, began.elapsed().as_secs_f64()));
                if direction == "download" { run.download_mbps = speed; } else { run.upload_mbps = speed; }
                previous = (now, count);
            }
        }
    }
    // Drop all request futures and wait for workers before publishing a terminal state.
    workers.abort_all();
    while workers.join_next().await.is_some() {}
    let count = measured.load(Ordering::Relaxed);
    let mut run = job.run.lock().map_err(|_| "测速状态不可用")?;
    let speed = (count > 0).then(|| mbps(count, began.elapsed().as_secs_f64()));
    if direction == "download" {
        run.download_mbps = speed;
    } else {
        run.upload_mbps = speed;
    }
    if budget.load(Ordering::Relaxed) == 0 {
        run.warnings.push(format!(
            "{}达到流量预算，测试提前结束；高带宽线路可提高上限重测",
            if direction == "download" {
                "下载"
            } else {
                "上传"
            }
        ));
    }
    if let Some(error) = failure {
        return Err(error);
    }
    if !job.cancel.load(Ordering::Relaxed) && count == 0 {
        return Err("测速时限内未完成有效数据传输，请切换节点或增加时长".into());
    }
    Ok(())
}
async fn measure(job: &Arc<Job>) -> Result<(), String> {
    let base = Url::parse(&job.snapshot()?.endpoint).map_err(|_| "测速节点无效")?;
    let prepare = async {
        let client = client(&base).await?;
        latency(job, &client, &base).await?;
        Ok::<_, String>(client)
    };
    let client = tokio::select! {
        biased;
        _ = cancelled(job) => return Ok(()),
        result = timeout(Duration::from_secs(70), prepare) => result.map_err(|_| "测速节点检测超时，请切换节点")??,
    };
    for direction in ["download", "upload"] {
        if job.cancel.load(Ordering::Relaxed) {
            break;
        }
        if direction == "upload" && download_only(&base) {
            job.run.lock().map_err(|_| "测速状态不可用")?.warnings.push("此国内 CDN 节点仅测下载和 HTTP 延迟，不提供上传测速；上传请切换 Cloudflare 或自建兼容节点".into());
            break;
        }
        transfer(job, &client, &base, direction).await?;
    }
    Ok(())
}
pub async fn execute(job: Arc<Job>) {
    let result = measure(&job).await;
    let mut run = match job.snapshot() {
        Ok(run) => run,
        Err(_) => return,
    };
    run.status = if job.cancel.load(Ordering::Relaxed) {
        "cancelled"
    } else if result.is_err() {
        "failed"
    } else {
        "completed"
    }
    .into();
    run.error = result.err();
    run.finished_at = Some(chrono::Utc::now().timestamp_millis());
    run.elapsed_secs = job.started.elapsed().as_secs_f64();
    run.traffic_bytes = job.traffic.load(Ordering::Relaxed);
    let record = run.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || {
        save(&crate::core::database::open_db()?, &record)
    })
    .await;
    if !matches!(saved, Ok(Ok(()))) {
        run.warnings.push("本次结果未能保存到本地历史".into());
    }
    if let Ok(mut current) = job.run.lock() {
        *current = run;
    }
}
pub fn save(conn: &Connection, run: &Run) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "保存测速历史失败")?;
    let json = serde_json::to_string(run).map_err(|_| "保存测速历史失败")?;
    tx.execute("INSERT INTO network_speed_history(id,started_at,json) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET json=excluded.json", params![run.id, run.started_at, json]).map_err(|_| "保存测速历史失败")?;
    tx.execute("DELETE FROM network_speed_history WHERE id NOT IN (SELECT id FROM network_speed_history ORDER BY started_at DESC,id DESC LIMIT 20)", []).map_err(|_| "保存测速历史失败")?;
    tx.commit().map_err(|_| "保存测速历史失败".into())
}
pub fn history(conn: &Connection) -> Result<Vec<Run>, String> {
    let mut statement = conn
        .prepare("SELECT json FROM network_speed_history ORDER BY started_at DESC,id DESC LIMIT 20")
        .map_err(|_| "读取测速历史失败")?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "读取测速历史失败")?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|_| "读取测速历史失败")?)
            .map_err(|_| "测速历史内容无效".into())
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            node: "cloudflare".into(),
            base_url: String::new(),
            duration_secs: 5,
            limit_mib: 50,
        }
    }
    #[test]
    fn validates_inputs_and_public_addresses() {
        let mut c = config();
        assert!(validate(&c).is_ok());
        c.duration_secs = 0;
        assert!(validate(&c).is_err());
        c.duration_secs = 5;
        c.node = "custom".into();
        for raw in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/?token=x",
            "https://example.com/#x",
            "file:///tmp",
        ] {
            c.base_url = raw.into();
            assert!(validate(&c).is_err());
        }
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "::ffff:127.0.0.1",
            "2001:db8::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_ip("1.1.1.1".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }
    #[tokio::test]
    async fn concurrent_reservations_never_exceed_limit() {
        let budget = Arc::new(AtomicU64::new(1000));
        let mut tasks = JoinSet::new();
        for _ in 0..8 {
            let budget = budget.clone();
            tasks.spawn(async move {
                let mut total = 0;
                loop {
                    let n = reserve(&budget, 63);
                    if n == 0 {
                        break;
                    }
                    total += n;
                    tokio::task::yield_now().await;
                }
                total
            });
        }
        let mut total = 0;
        while let Some(result) = tasks.join_next().await {
            total += result.unwrap();
        }
        assert_eq!(total, 1000);
        assert_eq!(budget.load(Ordering::Relaxed), 0);
    }
    #[test]
    fn keeps_twenty_history_records_and_upserts() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::core::database::NETWORK_SPEED_SCHEMA)
            .unwrap();
        for n in 0..25 {
            let mut run = Job::new(&config()).unwrap().snapshot().unwrap();
            run.id = format!("test-{n:02}");
            run.started_at = n;
            run.status = "completed".into();
            save(&conn, &run).unwrap();
        }
        let mut rows = history(&conn).unwrap();
        assert_eq!(rows.len(), 20);
        assert_eq!(rows[0].started_at, 24);
        assert_eq!(rows[19].started_at, 5);
        rows[0].status = "cancelled".into();
        save(&conn, &rows[0]).unwrap();
        assert_eq!(history(&conn).unwrap()[0].status, "cancelled");
    }
    #[test]
    fn domestic_nodes_require_matching_bounded_ranges() {
        assert!(valid_content_range(Some("bytes 0-65535/9764014"), 65536));
        for value in [
            None,
            Some("bytes 1-65536/9764014"),
            Some("bytes 0-65534/9764014"),
            Some("bytes 0-65535/100"),
            Some("bytes 0-65535/*"),
        ] {
            assert!(!valid_content_range(value, 65536));
        }
        assert!(!valid_content_range(Some("bytes 0-0/1"), 0));
        for id in ["cn-qiniu", "cn-alipay"] {
            let mut cfg = config();
            cfg.node = id.into();
            let base = validate(&cfg).unwrap();
            assert!(download_only(&base));
            assert_eq!(endpoint(&base, "download", 65536), base);
        }
        assert!(!download_only(&validate(&config()).unwrap()));
    }
    // Loopback is used only by these private worker tests, never accepted by the public API.
    async fn server(
        status: u16,
        declared: usize,
        actual: usize,
        stall: bool,
    ) -> (Url, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![];
            let mut buf = [0; 8192];
            loop {
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    return;
                }
                request.extend_from_slice(&buf[..n]);
                if let Some(end) = request.windows(4).position(|p| p == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&request[..end]).to_lowercase();
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length: ")
                                .and_then(|v| v.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            if stall {
                tokio::time::sleep(Duration::from_secs(60)).await;
                return;
            }
            let header = format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(header.as_bytes()).await;
            let _ = stream.write_all(&vec![7; actual]).await;
        });
        (url, task)
    }
    #[tokio::test]
    async fn download_counts_payload_and_rejects_truncation() {
        for (declared, actual, success) in [(65536, 65536, true), (65536, 1024, false)] {
            let (url, server) = server(200, declared, actual, false).await;
            let job = Arc::new(Job::new(&config()).unwrap());
            let measured = Arc::new(AtomicU64::new(0));
            let result = worker(
                job.clone(),
                Client::builder().no_proxy().build().unwrap(),
                url,
                "download",
                Arc::new(AtomicU64::new(65536)),
                measured.clone(),
                Instant::now() + Duration::from_secs(2),
            )
            .await;
            assert_eq!(result.is_ok(), success);
            assert_eq!(measured.load(Ordering::Relaxed), actual as u64);
            assert_eq!(job.traffic.load(Ordering::Relaxed), actual as u64);
            server.await.unwrap();
        }
    }
    #[tokio::test]
    async fn upload_counts_only_successful_acknowledgements() {
        for (status, expected) in [(200, 65536), (403, 0)] {
            let (url, server) = server(status, 0, 0, false).await;
            let job = Arc::new(Job::new(&config()).unwrap());
            let measured = Arc::new(AtomicU64::new(0));
            let result = worker(
                job.clone(),
                Client::builder().no_proxy().build().unwrap(),
                url,
                "upload",
                Arc::new(AtomicU64::new(65536)),
                measured.clone(),
                Instant::now() + Duration::from_secs(2),
            )
            .await;
            assert_eq!(result.is_ok(), status == 200);
            assert_eq!(measured.load(Ordering::Relaxed), expected);
            assert_eq!(job.traffic.load(Ordering::Relaxed), 65536);
            server.await.unwrap();
        }
    }
    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_request() {
        let (url, server) = server(200, 65536, 65536, true).await;
        let job = Arc::new(Job::new(&config()).unwrap());
        let cancelled_job = job.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            cancelled_job.cancel.store(true, Ordering::Relaxed);
        });
        let result = timeout(
            Duration::from_millis(800),
            worker(
                job.clone(),
                Client::builder().no_proxy().build().unwrap(),
                url,
                "download",
                Arc::new(AtomicU64::new(65536)),
                Arc::new(AtomicU64::new(0)),
                Instant::now() + Duration::from_secs(10),
            ),
        )
        .await;
        assert!(result.unwrap().is_ok());
        assert_eq!(job.traffic.load(Ordering::Relaxed), 0);
        server.abort();
    }
    #[tokio::test]
    #[ignore = "Live public endpoint; run explicitly with a 128 KiB payload budget"]
    async fn public_node_smoke() {
        let job = Arc::new(Job::new(&config()).unwrap());
        let base = validate(&config()).unwrap();
        let client = client(&base).await.unwrap();
        latency(&job, &client, &base).await.unwrap();
        for direction in ["download", "upload"] {
            let measured = Arc::new(AtomicU64::new(0));
            worker(
                job.clone(),
                client.clone(),
                base.clone(),
                direction,
                Arc::new(AtomicU64::new(65536)),
                measured.clone(),
                Instant::now() + Duration::from_secs(15),
            )
            .await
            .unwrap();
            assert_eq!(measured.load(Ordering::Relaxed), 65536);
        }
        assert!(job.snapshot().unwrap().latency_ms.unwrap() > 0.0);
        assert_eq!(job.traffic.load(Ordering::Relaxed), 131072);
    }
    #[tokio::test]
    #[ignore = "Live domestic CDN nodes; total download payload 128 KiB plus latency probes"]
    async fn domestic_nodes_smoke() {
        for id in ["cn-qiniu", "cn-alipay"] {
            let mut cfg = config();
            cfg.node = id.into();
            let job = Arc::new(Job::new(&cfg).unwrap());
            let base = validate(&cfg).unwrap();
            let client = client(&base).await.unwrap();
            latency(&job, &client, &base).await.unwrap();
            let measured = Arc::new(AtomicU64::new(0));
            worker(
                job.clone(),
                client,
                base,
                "download",
                Arc::new(AtomicU64::new(65536)),
                measured.clone(),
                Instant::now() + Duration::from_secs(15),
            )
            .await
            .unwrap();
            assert_eq!(measured.load(Ordering::Relaxed), 65536);
            assert!(job.snapshot().unwrap().latency_ms.unwrap() > 0.0);
            assert!(job.snapshot().unwrap().upload_mbps.is_none());
        }
    }
}
