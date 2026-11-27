//! 账号测智：用户显式触发的多账号并行题目测试、结果隔离预览与本地历史保留。
//! 绝不持久化或回显任何访问令牌、API Key 或原始上游认证数据。

use super::gateway::{self, PelicanQuotaSnapshot, PELICAN_DELIVERY_INSTRUCTIONS};
use super::QuotaSnapshot;
use crate::core::{paths, repositories::codex_accounts as repository, storage::open_db};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, LazyLock, Mutex, Weak,
};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{watch, Notify, Semaphore};

pub const EVENT: &str = "codex://pelican-progress";
const PREVIEW_CHARS: usize = 1600;
const MAX_BATCH_ACCOUNTS: usize = 200;
pub const MAX_CONCURRENCY: usize = 10;
const STREAM_EMIT_INTERVAL: Duration = Duration::from_millis(150);
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_RETENTION_DAYS: u32 = 7;
const MAX_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;

static ROOT: LazyLock<Mutex<Option<PathBuf>>> = LazyLock::new(|| Mutex::new(None));
static BATCH_GATES: LazyLock<Mutex<HashMap<String, Weak<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static ACTIVE: LazyLock<Mutex<Option<Arc<ActiveBatch>>>> = LazyLock::new(|| Mutex::new(None));
static MAINTENANCE: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));
static PREVIEW_SERVER: LazyLock<tokio::sync::Mutex<Option<(u16, String)>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub account_ids: Vec<i64>,
    pub prompt: String,
    pub model: String,
    pub effort: String,
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
}

fn default_concurrency() -> usize {
    2
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub revision: u64,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub prompt: String,
    pub model: String,
    pub effort: String,
    pub concurrency: usize,
    pub delivery_instructions: String,
    pub items: Vec<Item>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub account_id: i64,
    pub account_email: String,
    pub status: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub reply_preview: Option<String>,
    pub has_html: bool,
    pub error: Option<String>,
    pub usage: Option<serde_json::Value>,
    pub response_id: Option<String>,
    pub response_model: Option<String>,
    pub quota: Option<QuotaUsage>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QuotaUsage {
    pub consumed_percent: Option<f64>,
    pub before_remaining_percent: Option<i32>,
    pub remaining_percent: Option<i32>,
    pub window_minutes: Option<i64>,
    pub reset_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub raw_reply: String,
    pub html: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub items: Vec<Batch>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionSettings {
    pub days: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSummary {
    pub deleted_count: usize,
}

pub trait RuntimeHooks: Send + Sync + 'static {
    fn emit(&self, batch: &Batch);
    fn closing(&self) -> bool;
    fn acquire_lease(&self, account_id: i64) -> Result<Box<dyn Send>, String>;
}

struct ActiveBatch {
    batch: Mutex<Batch>,
    last_stream_emit: Mutex<Instant>,
    retry_gate: Mutex<()>,
    accepting_retries: AtomicBool,
    pending_retries: AtomicUsize,
    retry_done: Notify,
    retry_semaphore: Mutex<Option<Arc<Semaphore>>>,
    cancel: watch::Sender<bool>,
    done: watch::Sender<bool>,
    hooks: Arc<dyn RuntimeHooks>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn lock_error() -> String {
    "测智任务状态不可用，请重试".into()
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 96
        || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err("记录标识无效".into());
    }
    Ok(())
}

fn same_quota_window(before: &PelicanQuotaSnapshot, after: &PelicanQuotaSnapshot) -> bool {
    if let (Some(bw), Some(aw)) = (before.window_minutes, after.window_minutes) {
        if bw != aw {
            return false;
        }
    }
    match (before.reset_at, after.reset_at) {
        (Some(br), Some(ar)) => ar + 60 >= br,
        _ => true,
    }
}

pub fn pelican_quota_usage(
    before: Option<&PelicanQuotaSnapshot>,
    after: Option<&PelicanQuotaSnapshot>,
) -> Option<QuotaUsage> {
    if before.is_none() && after.is_none() {
        return None;
    }
    let consumed_percent = match (before, after) {
        (Some(b), Some(a)) if same_quota_window(b, a) => {
            let consumed = b.remaining_percent as f64 - a.remaining_percent as f64;
            (consumed >= 0.0).then_some(consumed)
        }
        _ => None,
    };
    Some(QuotaUsage {
        consumed_percent,
        before_remaining_percent: before.map(|s| s.remaining_percent),
        remaining_percent: after.map(|s| s.remaining_percent),
        window_minutes: after.and_then(|s| s.window_minutes).or_else(|| before.and_then(|s| s.window_minutes)),
        reset_at: after.and_then(|s| s.reset_at),
    })
}

fn primary_snapshot_from_cached(quota: &QuotaSnapshot, now_ms: i64) -> Option<PelicanQuotaSnapshot> {
    let fetched_at = quota.fetched_at?;
    if (now_ms - fetched_at).abs() > 15 * 60 * 1000 {
        return None;
    }
    let window = quota
        .windows
        .iter()
        .find(|w| w.window_minutes == Some(300) || w.name.to_ascii_lowercase().contains("hour") || w.name.contains("5"))
        .or_else(|| quota.windows.first())?;
    if !window.used_percent.is_finite() || !(0.0..=100.0).contains(&window.used_percent) {
        return None;
    }
    if let Some(reset_at) = window.resets_at {
        if reset_at * 1000 <= now_ms {
            return None;
        }
    }
    let remaining = (100.0 - window.used_percent).round().clamp(0.0, 100.0) as i32;
    Some(PelicanQuotaSnapshot {
        used_percent: window.used_percent,
        remaining_percent: remaining,
        window_minutes: window.window_minutes.map(|m| m as i64),
        reset_at: window.resets_at,
    })
}

impl ActiveBatch {
    fn snapshot(&self) -> Result<Batch, String> {
        self.batch.lock().map(|b| b.clone()).map_err(|_| lock_error())
    }

    fn update(&self, change: impl FnOnce(&mut Batch)) -> Result<Batch, String> {
        let snapshot = {
            let mut batch = self.batch.lock().map_err(|_| lock_error())?;
            change(&mut batch);
            batch.revision += 1;
            batch.clone()
        };
        self.hooks.emit(&snapshot);
        Ok(snapshot)
    }

    fn update_stream_preview(&self, index: usize, preview: String) {
        let snapshot = {
            let Ok(mut batch) = self.batch.lock() else { return };
            if let Some(item) = batch.items.get_mut(index) {
                item.reply_preview = Some(preview);
            }
            batch.revision += 1;
            let Ok(mut last_emit) = self.last_stream_emit.lock() else { return };
            let current = Instant::now();
            if current.saturating_duration_since(*last_emit) < STREAM_EMIT_INTERVAL {
                return;
            }
            *last_emit = current;
            batch.clone()
        };
        self.hooks.emit(&snapshot);
    }

    fn storage_error(&self, error: String) {
        let _ = self.update(|batch| batch.error = Some(error));
    }
}

pub async fn start(hooks: Arc<dyn RuntimeHooks>, mut request: StartRequest) -> Result<Batch, String> {
    let mut seen = HashSet::new();
    request.account_ids.retain(|id| *id > 0 && seen.insert(*id));
    if request.account_ids.is_empty() {
        return Err("请至少选择一个测试账号".into());
    }
    if request.account_ids.len() > MAX_BATCH_ACCOUNTS {
        return Err("单次最多选择 200 个账号".into());
    }
    if !(1..=MAX_CONCURRENCY).contains(&request.concurrency) {
        return Err(format!("并发数需在 1–{MAX_CONCURRENCY} 之间"));
    }
    let prompt = request.prompt.trim().to_string();
    let model = request.model.trim().to_string();
    if prompt.is_empty()
        || prompt.len() > 100_000
        || !gateway::model_valid(&model)
        || !matches!(request.effort.as_str(), "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra")
    {
        return Err("测试参数无效，请检查提示词、模型名称与思考强度".into());
    }
    let batch = Batch {
        id: uuid::Uuid::new_v4().to_string(),
        revision: 1,
        created_at: now(),
        finished_at: None,
        status: "running".into(),
        prompt,
        model,
        effort: request.effort,
        concurrency: request.concurrency,
        delivery_instructions: PELICAN_DELIVERY_INSTRUCTIONS.into(),
        error: None,
        items: request
            .account_ids
            .into_iter()
            .map(|account_id| Item {
                id: uuid::Uuid::new_v4().to_string(),
                account_id,
                account_email: format!("账号 #{account_id}"),
                status: "queued".into(),
                started_at: None,
                finished_at: None,
                reply_preview: None,
                has_html: false,
                error: None,
                usage: None,
                response_id: None,
                response_model: None,
                quota: None,
            })
            .collect(),
    };
    let (cancel, _) = watch::channel(false);
    let (done, _) = watch::channel(false);
    let state = Arc::new(ActiveBatch {
        batch: Mutex::new(batch.clone()),
        last_stream_emit: Mutex::new(Instant::now()),
        retry_gate: Mutex::new(()),
        accepting_retries: AtomicBool::new(true),
        pending_retries: AtomicUsize::new(0),
        retry_done: Notify::new(),
        retry_semaphore: Mutex::new(None),
        cancel,
        done,
        hooks,
    });
    {
        let mut active = ACTIVE.lock().map_err(|_| lock_error())?;
        if active.as_ref().is_some_and(|job| !*job.done.borrow()) {
            return Err("已有正在运行的账号测智任务，请先等待完成或终止".into());
        }
        *active = Some(state.clone());
    }
    tauri::async_runtime::spawn(async move {
        run_batch(state).await;
    });
    Ok(batch)
}

pub async fn retry(hooks: Arc<dyn RuntimeHooks>, batch_id: String, item_id: String) -> Result<Batch, String> {
    validate_id(&batch_id)?;
    validate_id(&item_id)?;
    let _maintenance = MAINTENANCE.lock().await;
    if let Some(job) = find_active(&batch_id)? {
        let mut wait_for_done = None;
        let retry_slot = {
            let _gate = job.retry_gate.lock().map_err(|_| lock_error())?;
            let mut batch = job.batch.lock().map_err(|_| lock_error())?;
            let Some(index) = batch.items.iter().position(|item| item.id == item_id) else {
                return Err("未找到要重试的账号记录".into());
            };
            if !matches!(batch.items[index].status.as_str(), "failed" | "cancelled" | "interrupted") {
                return Err("仅失败、已终止或中断的记录支持重试".into());
            }
            if *job.done.borrow() || *job.cancel.borrow() || !job.accepting_retries.load(Ordering::Acquire) {
                wait_for_done = Some(job.done.subscribe());
                None
            } else {
                prepare_item_retry(&mut batch, &item_id)?;
                job.pending_retries.fetch_add(1, Ordering::AcqRel);
                Some((index, batch.clone()))
            }
        };
        if let Some((index, snapshot)) = retry_slot {
            job.hooks.emit(&snapshot);
            if let Err(error) = persist(&job).await {
                job.pending_retries.fetch_sub(1, Ordering::AcqRel);
                job.retry_done.notify_one();
                finish_failed(&job, index, error.clone()).await;
                return Err(error);
            }
            let semaphore = job
                .retry_semaphore
                .lock()
                .map_err(|_| lock_error())?
                .clone()
                .unwrap_or_else(|| Arc::new(Semaphore::new(1)));
            let worker = job.clone();
            tauri::async_runtime::spawn(async move {
                let attempt = worker.clone();
                let res = async move {
                    let batch = attempt.snapshot()?;
                    let item = batch.items.get(index).cloned().ok_or_else(|| "未找到测试项".to_string())?;
                    save_artifact(batch.id, item.id.clone(), Artifact { raw_reply: String::new(), html: None, preview_url: None }).await?;
                    run_item(attempt, semaphore, index, item).await;
                    Ok::<(), String>(())
                }
                .await;
                if let Err(error) = res {
                    finish_failed(&worker, index, error).await;
                }
                worker.pending_retries.fetch_sub(1, Ordering::AcqRel);
                worker.retry_done.notify_one();
            });
            return Ok(snapshot);
        }
        if let Some(mut done) = wait_for_done {
            if !*done.borrow() {
                let _ = tokio::time::timeout(Duration::from_secs(30), async {
                    while !*done.borrow() {
                        if done.changed().await.is_err() {
                            break;
                        }
                    }
                })
                .await;
            }
        }
    }
    let mut retry_batch = get(batch_id).await?;
    let index = prepare_item_retry(&mut retry_batch, &item_id)?;
    let (cancel, _) = watch::channel(false);
    let (done, _) = watch::channel(false);
    let state = Arc::new(ActiveBatch {
        batch: Mutex::new(retry_batch.clone()),
        last_stream_emit: Mutex::new(Instant::now()),
        retry_gate: Mutex::new(()),
        accepting_retries: AtomicBool::new(true),
        pending_retries: AtomicUsize::new(0),
        retry_done: Notify::new(),
        retry_semaphore: Mutex::new(None),
        cancel,
        done,
        hooks,
    });
    {
        let mut active = ACTIVE.lock().map_err(|_| lock_error())?;
        if active.as_ref().is_some_and(|job| !*job.done.borrow()) {
            return Err("已有正在运行的账号测智任务，请先等待完成或终止".into());
        }
        *active = Some(state.clone());
    }
    tauri::async_runtime::spawn(async move {
        run_retry(state, index).await;
    });
    Ok(retry_batch)
}

fn prepare_item_retry(batch: &mut Batch, item_id: &str) -> Result<usize, String> {
    let Some(index) = batch.items.iter().position(|item| item.id == item_id) else {
        return Err("未找到要重试的账号记录".into());
    };
    if !matches!(batch.items[index].status.as_str(), "failed" | "cancelled" | "interrupted") {
        return Err("仅失败、已终止或中断的记录支持重试".into());
    }
    batch.revision += 1;
    batch.status = "running".into();
    batch.finished_at = None;
    batch.error = None;
    let item = &mut batch.items[index];
    item.status = "queued".into();
    item.started_at = None;
    item.finished_at = None;
    item.reply_preview = None;
    item.has_html = false;
    item.error = None;
    item.usage = None;
    item.response_id = None;
    item.response_model = None;
    item.quota = None;
    Ok(index)
}

pub fn active() -> Result<Option<Batch>, String> {
    ACTIVE.lock().map_err(|_| lock_error())?.as_ref().map(|job| job.snapshot()).transpose()
}

fn find_active(id: &str) -> Result<Option<Arc<ActiveBatch>>, String> {
    let active = ACTIVE.lock().map_err(|_| lock_error())?;
    match active.as_ref() {
        Some(job) if job.snapshot()?.id == id => Ok(Some(job.clone())),
        _ => Ok(None),
    }
}

pub async fn get(batch_id: String) -> Result<Batch, String> {
    validate_id(&batch_id)?;
    if let Some(job) = find_active(&batch_id)? {
        return job.snapshot();
    }
    read_batch(batch_id).await
}

pub async fn history(offset: usize, limit: usize) -> Result<History, String> {
    read_history(offset, limit.clamp(1, 50)).await
}

pub async fn retention_settings() -> Result<RetentionSettings, String> {
    Ok(RetentionSettings { days: read_retention_days().await? })
}

pub async fn update_retention_days(days: u32) -> Result<RetentionSettings, String> {
    if !(1..=3650).contains(&days) {
        return Err("保留天数需为 1 至 3650 天".into());
    }
    write_retention_days(days).await?;
    Ok(RetentionSettings { days })
}

pub async fn cleanup_expired() -> Result<CleanupSummary, String> {
    let Ok(_maintenance) = MAINTENANCE.try_lock() else {
        return Ok(CleanupSummary { deleted_count: 0 });
    };
    let days = read_retention_days().await?;
    let active_id = ACTIVE
        .lock()
        .map_err(|_| lock_error())?
        .as_ref()
        .and_then(|job| job.snapshot().ok().map(|b| b.id));
    let deleted = cleanup_expired_at(days, now(), active_id).await?;
    Ok(CleanupSummary { deleted_count: deleted })
}

pub async fn clear_all() -> Result<CleanupSummary, String> {
    let _maintenance = MAINTENANCE.lock().await;
    {
        let active = ACTIVE.lock().map_err(|_| lock_error())?;
        if active.as_ref().is_some_and(|job| !*job.done.borrow()) {
            return Err("测试仍在运行，请先终止后再清理".into());
        }
    }
    let deleted_count = clear_all_stored().await?;
    *ACTIVE.lock().map_err(|_| lock_error())? = None;
    Ok(CleanupSummary { deleted_count })
}

pub async fn artifact(batch_id: String, item_id: String) -> Result<Artifact, String> {
    validate_id(&batch_id)?;
    validate_id(&item_id)?;
    let batch = get(batch_id.clone()).await?;
    if !batch.items.iter().any(|item| item.id == item_id) {
        return Err("未找到生成结果".into());
    }
    let mut loaded = read_artifact(batch_id.clone(), item_id.clone()).await?;
    if loaded.html.is_some() {
        loaded.preview_url = ensure_preview_url(&batch_id, &item_id).await.ok();
    }
    Ok(loaded)
}

pub async fn cancel(batch_id: String) -> Result<Batch, String> {
    validate_id(&batch_id)?;
    let Some(job) = find_active(&batch_id)? else {
        return get(batch_id).await;
    };
    let mut done = job.done.subscribe();
    if !*done.borrow() {
        job.update(|batch| {
            if matches!(batch.status.as_str(), "running" | "cancelling") {
                batch.status = "cancelling".into();
                job.cancel.send_replace(true);
            }
        })?;
        tokio::time::timeout(Duration::from_secs(40), async {
            while !*done.borrow() {
                done.changed().await.map_err(|_| lock_error())?;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| "终止超时，请重试".to_string())??;
    }
    job.snapshot()
}

pub async fn dismiss(batch_id: String) -> Result<(), String> {
    validate_id(&batch_id)?;
    cancel(batch_id.clone()).await?;
    let mut active = ACTIVE.lock().map_err(|_| lock_error())?;
    if active.as_ref().is_some_and(|job| job.snapshot().is_ok_and(|b| b.id == batch_id)) {
        *active = None;
    }
    Ok(())
}

pub async fn delete(batch_id: String) -> Result<(), String> {
    validate_id(&batch_id)?;
    if let Some(job) = find_active(&batch_id)? {
        if !*job.done.borrow() {
            return Err("测试仍在运行，请先终止后再删除".into());
        }
    }
    delete_stored(batch_id.clone()).await?;
    let mut active = ACTIVE.lock().map_err(|_| lock_error())?;
    if active.as_ref().is_some_and(|job| job.snapshot().is_ok_and(|b| b.id == batch_id)) {
        *active = None;
    }
    Ok(())
}

async fn persist(job: &ActiveBatch) -> Result<(), String> {
    save_batch(job.snapshot()?).await
}

async fn run_batch(job: Arc<ActiveBatch>) {
    let worker = job.clone();
    let result = tokio::spawn(async move { run_batch_inner(worker).await })
        .await
        .map_err(|_| "测试任务异常中断".to_string())
        .and_then(|r| r);
    if let Err(error) = result {
        job.storage_error(error);
        let _ = job.update(|batch| {
            batch.status = "interrupted".into();
            batch.finished_at = Some(now());
            for item in &mut batch.items {
                if matches!(item.status.as_str(), "queued" | "running") {
                    item.status = "interrupted".into();
                    item.finished_at = Some(now());
                }
            }
        });
        let _ = persist(&job).await;
    }
    job.done.send_replace(true);
}

async fn run_batch_inner(job: Arc<ActiveBatch>) -> Result<(), String> {
    persist(&job).await?;
    let batch = job.snapshot()?;
    let semaphore = Arc::new(Semaphore::new(batch.concurrency.clamp(1, MAX_CONCURRENCY)));
    *job.retry_semaphore.lock().map_err(|_| lock_error())? = Some(semaphore.clone());
    let mut tasks = tokio::task::JoinSet::new();
    for (index, item) in batch.items.into_iter().enumerate() {
        let job_clone = job.clone();
        let sem = semaphore.clone();
        tasks.spawn(async move {
            run_item(job_clone, sem, index, item).await;
        });
    }
    while let Some(res) = tasks.join_next().await {
        if res.is_err() {
            job.storage_error("测试任务异常中断".into());
        }
    }
    finalize_loop(&job).await?;
    persist(&job).await
}

async fn run_retry(job: Arc<ActiveBatch>, index: usize) {
    let worker = job.clone();
    let result = tokio::spawn(async move {
        persist(&worker).await?;
        let semaphore = Arc::new(Semaphore::new(worker.snapshot()?.concurrency.clamp(1, MAX_CONCURRENCY)));
        *worker.retry_semaphore.lock().map_err(|_| lock_error())? = Some(semaphore.clone());
        let item = worker.snapshot()?.items[index].clone();
        save_artifact(worker.snapshot()?.id, item.id.clone(), Artifact { raw_reply: String::new(), html: None, preview_url: None }).await?;
        run_item(worker.clone(), semaphore, index, item).await;
        finalize_loop(&worker).await?;
        persist(&worker).await
    })
    .await
    .map_err(|_| "测试任务异常中断".to_string())
    .and_then(|r| r);
    if let Err(error) = result {
        job.storage_error(error);
        let _ = job.update(|batch| {
            batch.status = "interrupted".into();
            batch.finished_at = Some(now());
            if let Some(item) = batch.items.get_mut(index) {
                if matches!(item.status.as_str(), "queued" | "running") {
                    item.status = "interrupted".into();
                    item.finished_at = Some(now());
                }
            }
        });
        let _ = persist(&job).await;
    }
    job.done.send_replace(true);
}

async fn finalize_loop(job: &ActiveBatch) -> Result<(), String> {
    loop {
        let retry_done = job.retry_done.notified();
        let finalized = {
            let _retry_gate = job.retry_gate.lock().map_err(|_| lock_error())?;
            if job.pending_retries.load(Ordering::Acquire) != 0 {
                false
            } else {
                job.accepting_retries.store(false, Ordering::Release);
                job.update(|batch| {
                    batch.status = if *job.cancel.borrow() { "cancelled" } else { "completed" }.into();
                    batch.finished_at = Some(now());
                    for item in &mut batch.items {
                        if matches!(item.status.as_str(), "queued" | "running") {
                            item.status = "interrupted".into();
                            item.finished_at = Some(now());
                            item.error = Some("测试任务异常中断".into());
                        }
                    }
                })?;
                true
            }
        };
        if finalized {
            return Ok(());
        }
        retry_done.await;
    }
}

async fn acquire_or_cancel(
    semaphore: Arc<Semaphore>,
    mut cancel: watch::Receiver<bool>,
) -> Option<tokio::sync::OwnedSemaphorePermit> {
    if *cancel.borrow() {
        return None;
    }
    tokio::select! {
        biased;
        _ = cancel.changed() => None,
        permit = semaphore.acquire_owned() => permit.ok(),
    }
}

async fn run_item(job: Arc<ActiveBatch>, semaphore: Arc<Semaphore>, index: usize, item: Item) {
    let cancel = job.cancel.subscribe();
    let _permit = match acquire_or_cancel(semaphore, cancel.clone()).await {
        Some(permit) if !*cancel.borrow() && !job.hooks.closing() => permit,
        _ => {
            finish_cancelled(&job, index).await;
            return;
        }
    };
    let account_id = item.account_id;
    let item_id = item.id.clone();
    let hooks = job.hooks.clone();
    let loaded = tokio::task::spawn_blocking(move || -> Result<(String, Option<PelicanQuotaSnapshot>, Box<dyn Send>), String> {
        let lease = hooks.acquire_lease(account_id)?;
        let conn = open_db()?;
        let summary = repository::get(&conn, account_id)?;
        if summary.auth_mode != "chatgpt" || summary.is_web_session {
            return Err("该账号为 API Key 或仅网页会话账号，不支持账号测智".into());
        }
        let email = summary.email.filter(|e| !e.trim().is_empty()).unwrap_or(summary.label);
        let before = primary_snapshot_from_cached(&summary.quota, now());
        Ok((email, before, lease))
    })
    .await
    .map_err(|_| "读取测试账号失败".to_string())
    .and_then(|r| r);

    let (email, before_quota, _lease) = match loaded {
        Ok(value) => value,
        Err(error) => {
            finish_failed(&job, index, error).await;
            return;
        }
    };

    let batch = match job.update(|batch| {
        batch.items[index].account_email = email;
        batch.items[index].status = "running".into();
        batch.items[index].started_at = Some(now());
    }) {
        Ok(batch) => batch,
        Err(_) => return,
    };
    if let Err(error) = persist(&job).await {
        job.storage_error(error.clone());
        finish_failed(&job, index, error).await;
        return;
    }

    let partial = Arc::new(Mutex::new((String::new(), Instant::now())));
    let partial_delta = partial.clone();
    let delta_job = job.clone();
    let on_delta = move |delta: &str| {
        let preview = if let Ok(mut state) = partial_delta.lock() {
            state.0.push_str(delta);
            if state.1.elapsed() < STREAM_EMIT_INTERVAL {
                None
            } else {
                state.1 = Instant::now();
                Some(preview_text(&state.0))
            }
        } else {
            None
        };
        if let Some(preview) = preview {
            delta_job.update_stream_preview(index, preview);
        }
    };

    let (item_cancel_tx, item_cancel_rx) = watch::channel(*cancel.borrow());
    let mut parent_cancel = cancel.clone();
    let closing_hooks = job.hooks.clone();
    let cancel_forwarder = tokio::spawn(async move {
        loop {
            if *parent_cancel.borrow() || closing_hooks.closing() {
                let _ = item_cancel_tx.send(true);
                break;
            }
            tokio::select! {
                _ = parent_cancel.changed() => {}
                _ = tokio::time::sleep(Duration::from_millis(150)) => {}
            }
        }
    });

    let result = gateway::pelican_chat(
        account_id,
        batch.model.clone(),
        batch.prompt.clone(),
        batch.effort.clone(),
        item_cancel_rx,
        on_delta,
    )
    .await;
    cancel_forwarder.abort();

    let raw_reply = match &result {
        Ok(output) => output.reply.clone(),
        Err(_) => partial.lock().map(|s| s.0.clone()).unwrap_or_default(),
    };
    let html = extract_html(&raw_reply);
    let has_html = html.is_some();
    let preview = preview_text(&raw_reply);
    let artifact_res = save_artifact(batch.id.clone(), item_id, Artifact { raw_reply, html, preview_url: None }).await;
    if let Err(error) = &artifact_res {
        job.storage_error(error.clone());
    }
    let was_cancelled = *cancel.borrow() || job.hooks.closing();
    let _ = job.update(|batch| {
        let item = &mut batch.items[index];
        item.finished_at = Some(now());
        item.reply_preview = Some(preview);
        item.has_html = has_html && artifact_res.is_ok();
        match result {
            Ok(output) => {
                item.status = if artifact_res.is_ok() { "completed" } else { "failed" }.into();
                item.error = artifact_res.err();
                item.quota = pelican_quota_usage(before_quota.as_ref(), output.quota.as_ref());
                item.usage = output.usage;
                item.response_id = output.response_id;
                item.response_model = output.response_model;
            }
            Err(error) => {
                let cancelled_err = was_cancelled || error == "PELICAN_CANCELLED";
                item.status = if cancelled_err { "cancelled" } else { "failed" }.into();
                item.error = Some(humanize_error(&error));
            }
        }
    });
    if let Err(error) = persist(&job).await {
        job.storage_error(error);
    }
}

fn humanize_error(code: &str) -> String {
    if code == "PELICAN_TIMEOUT" {
        return "请求超时，可手动重测".into();
    }
    if code == "PELICAN_CANCELLED" {
        return "已终止".into();
    }
    if code == "PELICAN_RESPONSE_TOO_LARGE" {
        return "响应超过大小上限，已停止接收".into();
    }
    if let Some(rest) = code.strip_prefix("PELICAN_STREAM_INCOMPLETE") {
        let detail = rest.trim_start_matches(':').trim();
        return if detail.is_empty() {
            "响应未完整结束，已保留收到的内容".into()
        } else {
            format!("响应未完整结束（{detail}），已保留收到的内容")
        };
    }
    code.to_string()
}

async fn finish_cancelled(job: &ActiveBatch, index: usize) {
    let _ = job.update(|batch| {
        batch.items[index].status = "cancelled".into();
        batch.items[index].finished_at = Some(now());
    });
}

async fn finish_failed(job: &ActiveBatch, index: usize, error: String) {
    let _ = job.update(|batch| {
        batch.items[index].status = "failed".into();
        batch.items[index].finished_at = Some(now());
        batch.items[index].error = Some(error);
    });
    if let Err(error) = persist(job).await {
        job.storage_error(error);
    }
}

fn preview_text(reply: &str) -> String {
    reply.chars().take(PREVIEW_CHARS).collect()
}

pub fn extract_html(reply: &str) -> Option<String> {
    let mut fence = false;
    let mut block = String::new();
    let mut eligible = false;
    for line in reply.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            if fence {
                if eligible {
                    if let Some(document) = extract_document(block.trim()) {
                        return Some(document);
                    }
                }
                fence = false;
                block.clear();
            } else {
                let language = trimmed.trim_start_matches('`').trim().to_ascii_lowercase();
                eligible = matches!(language.as_str(), "html" | "svg" | "xml" | "");
                fence = true;
            }
        } else if fence {
            block.push_str(line);
            block.push('\n');
        }
    }
    if fence {
        return None;
    }
    extract_document(reply.trim())
}

fn extract_document(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    if let Some(start) = lower.find("<html").filter(|idx| tag_boundary(&lower[*idx + 5..])) {
        if let Some(end) = lower.rfind("</html>").filter(|end| *end > start) {
            let start = lower[..start].rfind("<!doctype html").unwrap_or(start);
            return Some(text[start..end + 7].to_string());
        }
        return None;
    }
    if let Some(start) = lower.find("<svg").filter(|idx| tag_boundary(&lower[*idx + 4..])) {
        if let Some(end) = lower.rfind("</svg>").filter(|end| *end > start) {
            return Some(text[start..end + 6].to_string());
        }
    }
    None
}

fn tag_boundary(suffix: &str) -> bool {
    suffix.chars().next().is_some_and(|ch| ch.is_ascii_whitespace() || ch == '>')
}

// --- 隔离浏览器预览（本地临时随机端口 + HTTP CSP + 无网络/弹窗锁定） ---

const PREVIEW_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const PREVIEW_RESET_STYLE: &str = "html,body{margin:0;width:100%;height:100%}body>svg:only-child{display:block;width:100%;height:100%}";
const PREVIEW_LOCKDOWN: &str = "(()=>{for(const k of['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','RTCDataChannel','WebTransport']){try{Object.defineProperty(globalThis,k,{value:undefined,writable:false,configurable:false})}catch(_){}}for(const k of['alert','confirm','prompt','print']){try{Object.defineProperty(globalThis,k,{value:()=>undefined,writable:false,configurable:false})}catch(_){}}})()";

fn build_preview_document(html: &str) -> String {
    let trimmed = html.trim();
    let lower = trimmed.to_ascii_lowercase();
    let head_payload = format!("<meta charset=\"utf-8\"><style>{PREVIEW_RESET_STYLE}</style><script>{PREVIEW_LOCKDOWN}</script>");
    if let Some(head_start) = lower.find("<head").filter(|idx| tag_boundary(&lower[*idx + 5..])) {
        if let Some(rel_end) = trimmed[head_start..].find('>') {
            let split = head_start + rel_end + 1;
            return format!("{}{head_payload}{}", &trimmed[..split], &trimmed[split..]);
        }
    }
    if let Some(html_start) = lower.find("<html").filter(|idx| tag_boundary(&lower[*idx + 5..])) {
        if let Some(rel_end) = trimmed[html_start..].find('>') {
            let split = html_start + rel_end + 1;
            return format!("{}<head>{head_payload}</head>{}", &trimmed[..split], &trimmed[split..]);
        }
    }
    format!("<!DOCTYPE html><html><head>{head_payload}</head><body>{trimmed}</body></html>")
}

async fn ensure_preview_url(batch_id: &str, item_id: &str) -> Result<String, String> {
    validate_id(batch_id)?;
    validate_id(item_id)?;
    let (port, secret) = {
        let mut slot = PREVIEW_SERVER.lock().await;
        if let Some(existing) = slot.as_ref() {
            existing.clone()
        } else {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .map_err(|_| "无法启动本地隔离预览端口".to_string())?;
            let port = listener.local_addr().map_err(|_| "无法读取本地预览地址".to_string())?.port();
            let secret = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            let expected_secret = secret.clone();
            tokio::spawn(async move {
                loop {
                    let Ok((mut stream, _)) = listener.accept().await else { break };
                    let secret_ref = expected_secret.clone();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 2048];
                        let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await else {
                            return;
                        };
                        let head = String::from_utf8_lossy(&buf[..n]);
                        let first_line = head.lines().next().unwrap_or("");
                        let path = first_line
                            .strip_prefix("GET ")
                            .and_then(|rest| rest.split_whitespace().next())
                            .map(|raw| raw.split('?').next().unwrap_or(raw))
                            .unwrap_or("");
                        let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
                        let valid = parts.len() == 5
                            && parts[0] == "pelican-preview"
                            && parts[1] == secret_ref
                            && parts[4] == "result.html"
                            && validate_id(parts[2]).is_ok()
                            && validate_id(parts[3]).is_ok();
                        if !valid {
                            let _ = stream
                                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                                .await;
                            return;
                        }
                        let loaded = read_artifact(parts[2].to_string(), parts[3].to_string()).await;
                        let Some(html) = loaded.ok().and_then(|art| art.html) else {
                            let _ = stream
                                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                                .await;
                            return;
                        };
                        let body = build_preview_document(&html);
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nContent-Security-Policy: {PREVIEW_CSP}\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    });
                }
            });
            *slot = Some((port, secret.clone()));
            (port, secret)
        }
    };
    Ok(format!("http://127.0.0.1:{port}/pelican-preview/{secret}/{batch_id}/{item_id}/result.html"))
}

pub async fn start_browser_preview(batch_id: String, item_id: String) -> Result<String, String> {
    let item_artifact = artifact(batch_id.clone(), item_id.clone()).await?;
    if item_artifact.html.is_none() {
        return Err("无可显示的 HTML 内容".to_string());
    }
    ensure_preview_url(&batch_id, &item_id).await
}

// --- SQLite 与独立文件存储 ---

fn with_batch_gate<T>(id: &str, op: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    validate_id(id)?;
    let gate = {
        let mut gates = BATCH_GATES.lock().map_err(|_| "无法访问测试记录锁".to_string())?;
        gates.retain(|_, g| g.strong_count() > 0);
        if let Some(existing) = gates.get(id).and_then(Weak::upgrade) {
            existing
        } else {
            let created = Arc::new(Mutex::new(()));
            gates.insert(id.to_string(), Arc::downgrade(&created));
            created
        }
    };
    let _guard = gate.lock().map_err(|_| "无法锁定测试记录".to_string())?;
    op()
}

fn safe_dir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => Err("测试记录目录不安全".into()),
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|_| "创建测试记录目录失败".to_string())
        }
        Err(_) => Err("读取测试记录目录失败".into()),
    }
}

fn open_history_db(root: &Path) -> Result<Connection, String> {
    let db_path = root.join("history.sqlite3");
    if fs::symlink_metadata(&db_path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("测试记录数据库路径不安全".into());
    }
    let conn = Connection::open(db_path).map_err(|_| "打开测试记录数据库失败".to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|_| "配置测试记录数据库失败".to_string())?;
    Ok(conn)
}

fn store_root() -> Result<PathBuf, String> {
    let mut cached = ROOT.lock().map_err(|_| "测试记录存储不可用".to_string())?;
    if let Some(path) = cached.as_ref() {
        return Ok(path.clone());
    }
    let dir = paths::data_dir()?.join("codex_pelican");
    safe_dir(&dir)?;
    safe_dir(&dir.join("artifacts"))?;
    let conn = open_history_db(&dir)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS batches (
             id TEXT PRIMARY KEY,
             created_at INTEGER NOT NULL,
             finished_at INTEGER,
             revision INTEGER NOT NULL,
             status TEXT NOT NULL,
             snapshot TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS batches_created ON batches(created_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS batches_status ON batches(status);
         CREATE TABLE IF NOT EXISTS settings (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         INSERT OR IGNORE INTO settings(key, value) VALUES('retention_days', '7');",
    )
    .map_err(|_| "初始化测试记录数据库失败".to_string())?;
    let _ = conn.execute(
        "UPDATE batches SET status='interrupted', finished_at=?1, revision=revision+1 WHERE status IN ('running','cancelling')",
        [now()],
    );
    let canonical = dir.canonicalize().unwrap_or(dir);
    *cached = Some(canonical.clone());
    Ok(canonical)
}

async fn blocking<T: Send + 'static>(
    op: impl FnOnce(PathBuf) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::time::timeout(IO_TIMEOUT, tokio::task::spawn_blocking(move || op(store_root()?)))
        .await
        .map_err(|_| "读写测试记录超时，请重试".to_string())?
        .map_err(|_| "测试记录后台任务失败".to_string())?
}

fn project_recovered(mut batch: Batch, status: String, finished_at: Option<i64>, revision: u64) -> Batch {
    batch.status = status.clone();
    batch.finished_at = finished_at.or(batch.finished_at);
    batch.revision = batch.revision.max(revision);
    if status == "interrupted" {
        for item in &mut batch.items {
            if matches!(item.status.as_str(), "queued" | "running") {
                item.status = "interrupted".into();
                item.finished_at = batch.finished_at.or(Some(now()));
            }
        }
    }
    batch
}

async fn save_batch(batch: Batch) -> Result<(), String> {
    blocking(move |root| {
        with_batch_gate(&batch.id, || {
            let conn = open_history_db(&root)?;
            let snapshot = serde_json::to_string(&batch).map_err(|_| "序列化测试记录失败".to_string())?;
            conn.execute(
                "INSERT INTO batches(id, created_at, finished_at, revision, status, snapshot)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                   finished_at=excluded.finished_at,
                   revision=excluded.revision,
                   status=excluded.status,
                   snapshot=excluded.snapshot
                 WHERE excluded.revision >= batches.revision",
                params![batch.id, batch.created_at, batch.finished_at, batch.revision as i64, batch.status, snapshot],
            )
            .map_err(|_| "保存测试记录失败".to_string())?;
            Ok(())
        })
    })
    .await
}

async fn read_batch(batch_id: String) -> Result<Batch, String> {
    blocking(move |root| {
        let conn = open_history_db(&root)?;
        let row: Option<(String, Option<i64>, i64, String)> = conn
            .query_row(
                "SELECT status, finished_at, revision, snapshot FROM batches WHERE id=?1",
                [&batch_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|_| "读取测试记录失败".to_string())?;
        let Some((status, finished_at, revision, snapshot)) = row else {
            return Err("未找到测试记录".into());
        };
        let parsed: Batch = serde_json::from_str(&snapshot).map_err(|_| "解析测试记录失败".to_string())?;
        Ok(project_recovered(parsed, status, finished_at, revision.max(0) as u64))
    })
    .await
}

async fn read_history(offset: usize, limit: usize) -> Result<History, String> {
    blocking(move |root| {
        let conn = open_history_db(&root)?;
        let mut stmt = conn
            .prepare(
                "SELECT status, finished_at, revision, snapshot FROM batches
                 ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2",
            )
            .map_err(|_| "查询测试历史失败".to_string())?;
        let rows = stmt
            .query_map(params![(limit + 1) as i64, offset as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|_| "查询测试历史失败".to_string())?;
        let mut items = Vec::new();
        for row in rows {
            let (status, finished_at, revision, snapshot) = row.map_err(|_| "读取测试历史失败".to_string())?;
            if let Ok(parsed) = serde_json::from_str::<Batch>(&snapshot) {
                items.push(project_recovered(parsed, status, finished_at, revision.max(0) as u64));
            }
        }
        let has_more = items.len() > limit;
        if has_more {
            items.truncate(limit);
        }
        Ok(History { items, has_more })
    })
    .await
}

fn artifact_dir(root: &Path, batch_id: &str) -> Result<PathBuf, String> {
    validate_id(batch_id)?;
    let artifacts = root.join("artifacts");
    safe_dir(&artifacts)?;
    Ok(artifacts.join(batch_id))
}

async fn save_artifact(batch_id: String, item_id: String, value: Artifact) -> Result<(), String> {
    blocking(move |root| {
        validate_id(&item_id)?;
        with_batch_gate(&batch_id, || {
            let dir = artifact_dir(&root, &batch_id)?;
            safe_dir(&dir)?;
            let file = dir.join(format!("{item_id}.json"));
            if fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("结果文件路径不安全".into());
            }
            let encoded = serde_json::to_vec(&value).map_err(|_| "序列化生成结果失败".to_string())?;
            if encoded.len() as u64 > MAX_ARTIFACT_BYTES {
                return Err("生成结果超过存储限制".into());
            }
            let temp = dir.join(format!("{item_id}.tmp"));
            fs::write(&temp, encoded).map_err(|_| "写入生成结果失败".to_string())?;
            fs::rename(&temp, &file).map_err(|_| "提交生成结果失败".to_string())
        })
    })
    .await
}

async fn read_artifact(batch_id: String, item_id: String) -> Result<Artifact, String> {
    blocking(move |root| {
        validate_id(&item_id)?;
        let file = artifact_dir(&root, &batch_id)?.join(format!("{item_id}.json"));
        let meta = fs::symlink_metadata(&file).map_err(|_| "未找到生成结果".to_string())?;
        if meta.file_type().is_symlink() || meta.len() > MAX_ARTIFACT_BYTES {
            return Err("结果文件不可读".into());
        }
        let bytes = fs::read(&file).map_err(|_| "读取生成结果失败".to_string())?;
        serde_json::from_slice(&bytes).map_err(|_| "解析生成结果失败".to_string())
    })
    .await
}

async fn read_retention_days() -> Result<u32, String> {
    blocking(|root| {
        let conn = open_history_db(&root)?;
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key='retention_days'", [], |r| r.get(0))
            .optional()
            .map_err(|_| "读取清理设置失败".to_string())?;
        Ok(raw.and_then(|v| v.parse::<u32>().ok()).filter(|d| (1..=3650).contains(d)).unwrap_or(DEFAULT_RETENTION_DAYS))
    })
    .await
}

async fn write_retention_days(days: u32) -> Result<(), String> {
    blocking(move |root| {
        let conn = open_history_db(&root)?;
        conn.execute(
            "INSERT INTO settings(key, value) VALUES('retention_days', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [days.to_string()],
        )
        .map_err(|_| "保存清理设置失败".to_string())?;
        Ok(())
    })
    .await
}

fn remove_batch_artifacts(root: &Path, batch_id: &str) {
    if let Ok(dir) = artifact_dir(root, batch_id) {
        if fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

async fn delete_stored(batch_id: String) -> Result<(), String> {
    blocking(move |root| {
        with_batch_gate(&batch_id, || {
            let conn = open_history_db(&root)?;
            conn.execute("DELETE FROM batches WHERE id=?1", [&batch_id])
                .map_err(|_| "删除测试记录失败".to_string())?;
            remove_batch_artifacts(&root, &batch_id);
            Ok(())
        })
    })
    .await
}

async fn clear_all_stored() -> Result<usize, String> {
    blocking(|root| {
        let conn = open_history_db(&root)?;
        let count = conn.execute("DELETE FROM batches", []).map_err(|_| "清理测试记录失败".to_string())?;
        let artifacts = root.join("artifacts");
        if fs::symlink_metadata(&artifacts).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
            let _ = fs::remove_dir_all(&artifacts);
            let _ = fs::create_dir_all(&artifacts);
        }
        Ok(count)
    })
    .await
}

async fn cleanup_expired_at(days: u32, now_ms: i64, active_id: Option<String>) -> Result<usize, String> {
    blocking(move |root| {
        let cutoff = now_ms - (days as i64) * 86_400_000;
        let conn = open_history_db(&root)?;
        let mut stmt = conn
            .prepare("SELECT id FROM batches WHERE created_at < ?1 AND status NOT IN ('running','cancelling')")
            .map_err(|_| "查询过期测试记录失败".to_string())?;
        let ids: Vec<String> = stmt
            .query_map([cutoff], |r| r.get::<_, String>(0))
            .map_err(|_| "查询过期测试记录失败".to_string())?
            .filter_map(Result::ok)
            .filter(|id| active_id.as_deref() != Some(id.as_str()))
            .collect();
        for id in &ids {
            let _ = conn.execute("DELETE FROM batches WHERE id=?1", [id]);
            remove_batch_artifacts(&root, id);
        }
        Ok(ids.len())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_html_handles_standalone_fenced_and_svg_documents_only_when_complete() {
        assert_eq!(
            extract_html("<!DOCTYPE html><html><body>ok</body></html>"),
            Some("<!DOCTYPE html><html><body>ok</body></html>".into())
        );
        assert_eq!(
            extract_html("Here:\n```html\n<html><body>fenced</body></html>\n```"),
            Some("<html><body>fenced</body></html>".into())
        );
        assert_eq!(
            extract_html("<svg viewBox=\"0 0 10 10\"><circle r=\"4\"/></svg>"),
            Some("<svg viewBox=\"0 0 10 10\"><circle r=\"4\"/></svg>".into())
        );
        assert_eq!(extract_html("```html\n<html><body>unclosed"), None);
        assert_eq!(extract_html("plain reasoning reply without html"), None);
    }

    #[test]
    fn quota_usage_computes_delta_within_same_window_and_ignores_reset() {
        let before = PelicanQuotaSnapshot {
            used_percent: 20.0,
            remaining_percent: 80,
            window_minutes: Some(300),
            reset_at: Some(2_000),
        };
        let after = PelicanQuotaSnapshot {
            used_percent: 27.0,
            remaining_percent: 73,
            window_minutes: Some(300),
            reset_at: Some(2_000),
        };
        let usage = pelican_quota_usage(Some(&before), Some(&after)).unwrap();
        assert_eq!(usage.remaining_percent, Some(73));
        assert_eq!(usage.consumed_percent, Some(7.0));

        let reset_after = PelicanQuotaSnapshot {
            used_percent: 2.0,
            remaining_percent: 98,
            window_minutes: Some(300),
            reset_at: Some(5_000),
        };
        let after_reset = pelican_quota_usage(Some(&before), Some(&reset_after)).unwrap();
        assert_eq!(after_reset.remaining_percent, Some(98));
        assert_eq!(after_reset.consumed_percent, None);
    }

    #[test]
    fn validate_id_rejects_traversal_and_special_chars() {
        assert!(validate_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_id("../secret").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("").is_err());
    }
}
