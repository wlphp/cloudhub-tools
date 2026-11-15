//! 桌宠语音识别：本地 whisper.cpp 推理、ggml 模型管理与常驻唤醒词监听。
//! 音频仅在内存中处理，不落盘、不写日志；未命中唤醒词的片段不会离开本机。
use base64::Engine as _;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::{chat_caller, chat_error, caller, read_settings, PetStore};
use crate::core::error::PlatformResult;

const MODELS_DIR: &str = "voice-models";
const MODEL_MIN_BYTES: u64 = 1024 * 1024;
const MODEL_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const AUDIO_MAX_BYTES: usize = 8 * 1024 * 1024;
const SAMPLE_RATE: usize = 16_000;
const HARD_LIMIT_SECONDS: usize = 130;
const WAKE_COMMAND_WINDOW: Duration = Duration::from_secs(10);
const VAD_FRAME: usize = 512;
const VAD_THRESHOLD: f32 = 0.02;
const NOISE_FLOOR_ALPHA: f32 = 0.05;
const NOISE_FLOOR_MIN: f32 = 0.002;
const NOISE_FLOOR_FACTOR: f32 = 2.5;
const DC_BLOCK_ALPHA: f32 = 0.01;
const SPEECH_START_FRAMES: usize = 3;
const SPEECH_END_FRAMES: usize = 25;
const PREROLL_FRAMES: usize = 25;
const MIN_SEGMENT_FRAMES: usize = 9;
const MAX_SEGMENT_FRAMES: usize = 15 * (SAMPLE_RATE / VAD_FRAME);
const DEVICE_STALL: Duration = Duration::from_secs(30);
const SETTINGS_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// whisper 引擎与常驻监听状态；随 MonitoringStore 管理，手动识别与唤醒循环共用同一把模型锁。
#[derive(Default)]
pub struct Engine {
    model: Mutex<Option<LoadedModel>>,
    listening: AtomicBool,
    generation: AtomicU64,
    manual_active: AtomicBool,
    download_name: Mutex<Option<String>>,
    download_cancel: AtomicBool,
}
struct LoadedModel {
    path: PathBuf,
    context: whisper_rs::WhisperContext,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelInfo {
    pub name: String,
    pub size_bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub models_dir: String,
    pub models: Vec<VoiceModelInfo>,
    pub catalog: Vec<VoiceModelInfo>,
    pub selected: Option<String>,
    pub ready: bool,
    pub listening: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningState {
    pub active: bool,
    pub error: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCommand {
    pub text: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceHeard {
    pub text: String,
}

/// 内置模型目录：名称与近似体积（用于界面展示与下载校验）。
const MODEL_CATALOG: [(&str, u64); 3] = [
    ("ggml-tiny.bin", 75 * 1024 * 1024),
    ("ggml-base.bin", 142 * 1024 * 1024),
    ("ggml-small.bin", 466 * 1024 * 1024),
];
const MODEL_SOURCE_NAMES: [&str; 2] = ["huggingface", "hf-mirror"];
const MODEL_SOURCES: [&str; 2] = [
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main",
    "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main",
];
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_EMIT_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelDownloadProgress {
    pub stage: String,
    pub source: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub bytes_per_second: u64,
}

fn models_dir() -> Result<PathBuf, String> {
    let dir = crate::core::paths::data_dir()?.join(MODELS_DIR);
    std::fs::create_dir_all(&dir).map_err(|_| "创建语音模型目录失败")?;
    Ok(dir)
}

fn scan_models(dir: &Path) -> Vec<VoiceModelInfo> {
    let mut models = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return models };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() { continue; }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if !valid_model_name(&name) { continue; }
        let size = meta.len();
        if size < MODEL_MIN_BYTES || size > MODEL_MAX_BYTES { continue; }
        models.push(VoiceModelInfo { name, size_bytes: size });
    }
    models.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    models
}

/// 仅允许纯文件名（无路径分隔符），防止越出模型目录。
pub fn valid_model_name(name: &str) -> bool {
    let name = name.trim();
    let lower = name.to_ascii_lowercase();
    !name.is_empty()
        && name.len() <= 120
        && (lower.ends_with(".bin") || lower.ends_with(".gguf"))
        && !name.chars().any(|c| c.is_control() || c == '/' || c == '\\')
        && !name.contains("..")
}

fn resolve_model(settings: &super::Settings) -> Result<(PathBuf, String), String> {
    let dir = models_dir()?;
    let models = scan_models(&dir);
    let name = if settings.voice.model_file.trim().is_empty() {
        models
            .first()
            .map(|m| m.name.clone())
            .ok_or("尚未放置语音模型，请下载 ggml 模型放入模型文件夹")?
    } else {
        let name = settings.voice.model_file.trim().to_string();
        if !models.iter().any(|m| m.name == name) {
            return Err("语音模型文件不存在，请检查语音设置".into());
        }
        name
    };
    Ok((dir.join(&name), name))
}

fn load_context(path: &Path) -> Result<whisper_rs::WhisperContext, String> {
    let meta = std::fs::metadata(path).map_err(|_| "语音模型文件不可读")?;
    if !meta.is_file() { return Err("语音模型文件不存在".into()); }
    if meta.len() < MODEL_MIN_BYTES || meta.len() > MODEL_MAX_BYTES {
        return Err("语音模型文件大小异常".into());
    }
    whisper_rs::WhisperContext::new_with_params(path, whisper_rs::WhisperContextParameters::default())
        .map_err(|_| "语音模型加载失败，请确认文件完整".into())
}

/// 峰值归一化：低增益麦克风电平过低时 whisper 无法解码（输出空结果），放大到固定峰值。
fn normalize_peaks(samples: &mut [f32]) {
    let peak = samples.iter().fold(0.0f32, |max, sample| max.max(sample.abs()));
    if peak > 0.001 && peak < 0.5 {
        let gain = 0.7 / peak;
        for sample in samples.iter_mut() {
            *sample *= gain;
        }
    }
}

/// 串行推理：换模型时重新加载，否则复用已加载上下文。
pub fn transcribe_samples(engine: &Engine, model: &Path, language: &str, samples: &mut [f32]) -> Result<String, String> {
    normalize_peaks(samples);
    let mut guard = engine.model.lock().map_err(|_| "语音引擎状态不可用")?;
    if guard.as_ref().is_none_or(|m| m.path != model) {
        let context = load_context(model)?;
        *guard = Some(LoadedModel { path: model.to_path_buf(), context });
    }
    let loaded = guard.as_ref().ok_or("语音模型未加载")?;
    let mut state = loaded.context.create_state().map_err(|_| "语音识别初始化失败")?;
    let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    let language = language.trim().to_ascii_lowercase();
    params.set_language(if language == "auto" { None } else { Some(language.as_str()) });
    params.set_translate(false);
    params.set_no_context(true);
    params.set_print_progress(false);
    params.set_print_special(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    state.full(params, samples).map_err(|_| "语音识别失败")?;
    let count = state.full_n_segments();
    let mut text = String::new();
    for index in 0..count {
        if let Some(segment) = state.get_segment(index) {
            if let Ok(part) = segment.to_str() {
                text.push_str(part.trim());
            }
        }
    }
    Ok(text)
}

fn decode_audio(audio: &str) -> Result<Vec<f32>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio.trim())
        .map_err(|_| "录音数据无效")?;
    if bytes.is_empty() || bytes.len() > AUDIO_MAX_BYTES { return Err("录音数据无效或过大".into()); }
    if bytes.len() % 2 != 0 { return Err("录音数据无效".into()); }
    let samples: Vec<f32> = bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
        .collect();
    if samples.len() < SAMPLE_RATE / 10 { return Err("录音过短".into()); }
    if samples.len() > SAMPLE_RATE * HARD_LIMIT_SECONDS { return Err("录音过长".into()); }
    Ok(samples)
}

fn current_status(app: &tauri::AppHandle) -> Result<VoiceStatus, String> {
    let settings = read_settings()?;
    let dir = models_dir()?;
    let models = scan_models(&dir);
    let selected = if settings.voice.model_file.trim().is_empty() {
        models.first().map(|m| m.name.clone())
    } else {
        let name = settings.voice.model_file.trim().to_string();
        models.iter().any(|m| m.name == name).then_some(name)
    };
    Ok(VoiceStatus {
        models_dir: dir.to_string_lossy().into_owned(),
        ready: selected.is_some(),
        selected,
        models,
        catalog: MODEL_CATALOG
            .iter()
            .map(|(name, size)| VoiceModelInfo { name: (*name).into(), size_bytes: *size })
            .collect(),
        listening: app.state::<PetStore>().voice.listening.load(Ordering::SeqCst),
    })
}

#[tauri::command]
pub fn pet_voice_status(window: tauri::WebviewWindow, app: tauri::AppHandle) -> PlatformResult<VoiceStatus> {
    caller(&window)?;
    Ok(current_status(&app)?)
}

#[tauri::command]
pub async fn pet_voice_transcribe(window: tauri::WebviewWindow, app: tauri::AppHandle, audio: String) -> PlatformResult<String> {
    chat_caller(&window)?;
    let settings = read_settings()?;
    let engine = app.state::<PetStore>().voice.clone();
    engine.manual_active.store(true, Ordering::SeqCst);
    let result: Result<String, String> = async {
        if !settings.voice.enabled { return Err("请先在桌宠设置中启用语音对话".into()); }
        let mut samples = decode_audio(&audio)?;
        let (model, _) = resolve_model(&settings)?;
        let task_engine = engine.clone();
        let language = settings.voice.language.clone();
        tauri::async_runtime::spawn_blocking(move || transcribe_samples(&task_engine, &model, &language, &mut samples))
            .await
            .map_err(|_| "语音识别任务失败".to_string())?
    }
    .await;
    engine.manual_active.store(false, Ordering::SeqCst);
    let text = result.map_err(chat_error)?;
    let text = text.trim().to_string();
    if text.is_empty() { return Err(chat_error("未识别到语音内容，请靠近麦克风再试一次".into())); }
    Ok(text)
}

#[tauri::command]
pub fn pet_voice_open_models_dir(window: tauri::WebviewWindow, app: tauri::AppHandle) -> PlatformResult<()> {
    caller(&window)?;
    let dir = models_dir()?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|_| "无法打开模型文件夹")?;
    Ok(())
}

fn send_download_progress(
    channel: &tauri::ipc::Channel<VoiceModelDownloadProgress>,
    stage: &'static str,
    source: &str,
    downloaded: u64,
    total: Option<u64>,
    speed: u64,
) {
    let _ = channel.send(VoiceModelDownloadProgress {
        stage: stage.into(),
        source: source.into(),
        downloaded_bytes: downloaded,
        total_bytes: total,
        bytes_per_second: speed,
    });
}

/// 按目录顺序尝试各下载源；任一源成功即保存，取消标志立即中断。
async fn download_model_file(
    engine: &std::sync::Arc<Engine>,
    name: &str,
    channel: &tauri::ipc::Channel<VoiceModelDownloadProgress>,
) -> Result<(), String> {
    let dir = models_dir()?;
    let destination = dir.join(name);
    if std::fs::metadata(&destination).is_ok_and(|meta| meta.is_file() && meta.len() >= MODEL_MIN_BYTES) {
        send_download_progress(channel, "done", "local", 0, None, 0);
        return Ok(());
    }
    let client = reqwest::Client::builder()
        .user_agent("CloudHubTools")
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
        .build()
        .map_err(|_| "下载客户端初始化失败")?;
    let part = dir.join(format!("{name}.part"));
    let mut last_error = String::new();
    for (index, base) in MODEL_SOURCES.iter().enumerate() {
        if engine.download_cancel.load(Ordering::SeqCst) {
            return Err("已取消下载".into());
        }
        let source = MODEL_SOURCE_NAMES[index];
        send_download_progress(channel, "connecting", source, 0, None, 0);
        match stream_model_download(&client, &format!("{base}/{name}"), &part, engine, channel, source).await {
            Ok(bytes) => {
                std::fs::rename(&part, &destination).map_err(|_| "保存语音模型失败")?;
                send_download_progress(channel, "done", source, bytes, Some(bytes), 0);
                return Ok(());
            }
            Err(error) => {
                let _ = std::fs::remove_file(&part);
                if engine.download_cancel.load(Ordering::SeqCst) {
                    return Err("已取消下载".into());
                }
                last_error = error;
            }
        }
    }
    if engine.download_cancel.load(Ordering::SeqCst) {
        Err("已取消下载".into())
    } else {
        Err(format!("模型下载失败，请检查网络后重试（{last_error}）"))
    }
}

async fn stream_model_download(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    engine: &std::sync::Arc<Engine>,
    channel: &tauri::ipc::Channel<VoiceModelDownloadProgress>,
    source: &str,
) -> Result<u64, String> {
    use tokio::io::AsyncWriteExt;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "下载连接失败，请检查网络")?
        .error_for_status()
        .map_err(|_| "下载源返回了错误状态")?;
    let total = response.content_length().filter(|size| *size > 0);
    if total.is_some_and(|size| size > MODEL_MAX_BYTES) {
        return Err("模型文件超过 2GB 安全限制".into());
    }
    let mut file = tokio::fs::File::create(part).await.map_err(|_| "无法创建模型临时文件")?;
    let mut downloaded: u64 = 0;
    let mut last_bytes: u64 = 0;
    let mut last_time = Instant::now();
    let mut last_emit = Instant::now();
    loop {
        let chunk = match tokio::time::timeout(DOWNLOAD_CHUNK_TIMEOUT, response.chunk()).await {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => break,
            Ok(Err(_)) => return Err("下载中断，请重试".into()),
            Err(_) => return Err("下载超时，网络不稳定".into()),
        };
        if engine.download_cancel.load(Ordering::SeqCst) {
            return Err("已取消下载".into());
        }
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MODEL_MAX_BYTES {
            return Err("模型文件超过 2GB 安全限制".into());
        }
        file.write_all(&chunk).await.map_err(|_| "写入模型临时文件失败")?;
        if last_emit.elapsed() >= DOWNLOAD_EMIT_INTERVAL {
            let elapsed = last_time.elapsed().as_secs_f64().max(0.001);
            send_download_progress(channel, "downloading", source, downloaded, total, ((downloaded - last_bytes) as f64 / elapsed) as u64);
            last_bytes = downloaded;
            last_time = Instant::now();
            last_emit = Instant::now();
        }
    }
    if total.is_some_and(|expected| downloaded != expected) {
        return Err("模型文件下载不完整".into());
    }
    file.flush().await.map_err(|_| "写入模型临时文件失败")?;
    Ok(downloaded)
}

/// 从内置目录下载 whisper ggml 模型到模型文件夹；同一时间仅允许一个下载任务。
#[tauri::command]
pub async fn pet_voice_download_model(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    name: String,
    on_progress: tauri::ipc::Channel<VoiceModelDownloadProgress>,
) -> PlatformResult<VoiceStatus> {
    caller(&window)?;
    let engine = app.state::<PetStore>().voice.clone();
    // 锁仅在领取下载位的块内持有，避免守卫跨越 await 使 Future 失去 Send。
    let model_name: String = {
        let mut slot = engine.download_name.lock().map_err(|_| "语音引擎状态不可用")?;
        if slot.is_some() {
            return Err("已有语音模型正在下载，请稍候".into());
        }
        let (found, _) = MODEL_CATALOG
            .iter()
            .find(|(entry, _)| *entry == name.trim())
            .ok_or("不支持的语音模型型号")?;
        *slot = Some((*found).to_string());
        (*found).to_string()
    };
    engine.download_cancel.store(false, Ordering::SeqCst);
    let outcome = download_model_file(&engine, &model_name, &on_progress).await;
    if let Ok(mut slot) = engine.download_name.lock() {
        *slot = None;
    }
    outcome?;
    Ok(current_status(&app)?)
}

/// 取消进行中的模型下载：下载循环检测到标志后清理临时文件并退出。
#[tauri::command]
pub fn pet_voice_cancel_model_download(window: tauri::WebviewWindow, app: tauri::AppHandle) -> PlatformResult<()> {
    caller(&window)?;
    app.state::<PetStore>().voice.download_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// 依据设置启停常驻监听：调用于应用初始化与设置保存之后。
pub fn sync_listener(app: &AppHandle) {
    let engine = app.state::<PetStore>().voice.clone();
    let want = read_settings()
        .map(|settings| settings.voice.enabled && settings.voice.wake_enabled)
        .unwrap_or(false);
    let running = engine.listening.load(Ordering::SeqCst);
    if !want {
        if running {
            engine.generation.fetch_add(1, Ordering::SeqCst);
            engine.listening.store(false, Ordering::SeqCst);
            let _ = app.emit("pet-voice-listening", ListeningState { active: false, error: None });
        }
        return;
    }
    if running { return; }
    let generation = engine.generation.fetch_add(1, Ordering::SeqCst) + 1;
    engine.listening.store(true, Ordering::SeqCst);
    let _ = std::thread::Builder::new().name("pet-voice-wake".into()).spawn({
        let app = app.clone();
        move || wake_loop(app, engine, generation)
    });
}

fn wake_loop(app: AppHandle, engine: Arc<Engine>, generation: u64) {
    let mut awake: Option<Instant> = None;
    let _ = app.emit("pet-voice-listening", ListeningState { active: true, error: None });
    loop {
        if !engine.listening.load(Ordering::SeqCst) || engine.generation.load(Ordering::SeqCst) != generation {
            break;
        }
        let Ok(settings) = read_settings() else {
            std::thread::sleep(Duration::from_secs(5));
            continue;
        };
        if !settings.voice.enabled || !settings.voice.wake_enabled {
            break;
        }
        match capture_session(&app, &engine, generation, &mut awake) {
            Ok(SessionEnd::Stopped) => break,
            Ok(SessionEnd::SettingsChanged) => continue,
            Err(error) => {
                if !engine.listening.load(Ordering::SeqCst) || engine.generation.load(Ordering::SeqCst) != generation {
                    break;
                }
                let _ = app.emit("pet-voice-listening", ListeningState { active: true, error: Some(error) });
                std::thread::sleep(Duration::from_secs(10));
            }
        }
    }
    engine.listening.store(false, Ordering::SeqCst);
    let _ = app.emit("pet-voice-listening", ListeningState { active: false, error: None });
}

enum SessionEnd {
    Stopped,
    SettingsChanged,
}

fn capture_session(app: &AppHandle, engine: &Arc<Engine>, generation: u64, awake: &mut Option<Instant>) -> Result<SessionEnd, String> {
    let settings = read_settings().map_err(|_| "读取桌宠设置失败".to_string())?;
    resolve_model(&settings)?;
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or("未检测到麦克风")?;
    let supported = device.default_input_config().map_err(|_| "麦克风不可用，请检查设备连接")?;
    let config: cpal::StreamConfig = supported.clone().into();
    let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(64);
    let stream = build_capture_stream(&device, config, supported.sample_format(), supported.channels() as usize, supported.sample_rate().0, tx)
        .map_err(|_| "麦克风启动失败，请检查设备与采样格式")?;
    stream.play().map_err(|_| "麦克风启动失败")?;
    let mut pending = PendingSegment::default();
    let mut buffer: Vec<f32> = Vec::with_capacity(VAD_FRAME * 4);
    let mut last_data = Instant::now();
    let mut last_settings = Instant::now();
    let result = loop {
        if !engine.listening.load(Ordering::SeqCst) || engine.generation.load(Ordering::SeqCst) != generation {
            break Ok(SessionEnd::Stopped);
        }
        if last_settings.elapsed() >= SETTINGS_CHECK_INTERVAL {
            last_settings = Instant::now();
            if let Ok(current) = read_settings() {
                if !current.voice.enabled
                    || !current.voice.wake_enabled
                    || current.voice.wake_word != settings.voice.wake_word
                    || current.voice.language != settings.voice.language
                    || current.voice.model_file != settings.voice.model_file
                {
                    break Ok(SessionEnd::SettingsChanged);
                }
            }
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => {
                last_data = Instant::now();
                buffer.extend(chunk);
                while buffer.len() >= VAD_FRAME {
                    let frame: Vec<f32> = buffer.drain(..VAD_FRAME).collect();
                    if let Some(mut segment) = pending.push(&frame) {
                        handle_segment(app, engine, &settings, awake, &mut segment);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last_data.elapsed() >= DEVICE_STALL {
                    break Err("麦克风无响应，请检查设备连接".into());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break Err("麦克风数据中断".into()),
        }
    };
    drop(stream);
    result
}

fn stream_error(_error: cpal::StreamError) {}

fn build_capture_stream(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    format: cpal::SampleFormat,
    channels: usize,
    native_rate: u32,
    tx: mpsc::SyncSender<Vec<f32>>,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    match format {
        cpal::SampleFormat::F32 => {
            let mut resampler = Resampler::new(native_rate);
            device.build_input_stream(&config, move |data: &[f32], _| feed(data, channels, &mut resampler, |sample| sample, &tx), stream_error, None)
        }
        cpal::SampleFormat::I16 => {
            let mut resampler = Resampler::new(native_rate);
            device.build_input_stream(&config, move |data: &[i16], _| feed(data, channels, &mut resampler, |sample| sample as f32 / 32768.0, &tx), stream_error, None)
        }
        cpal::SampleFormat::U8 => {
            let mut resampler = Resampler::new(native_rate);
            device
                .build_input_stream(&config, move |data: &[u8], _| feed(data, channels, &mut resampler, |sample| (sample as f32 - 128.0) / 128.0, &tx), stream_error, None)
        }
        _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
    }
}

fn feed<T: Copy>(data: &[T], channels: usize, resampler: &mut Resampler, convert: impl Fn(T) -> f32, tx: &mpsc::SyncSender<Vec<f32>>) {
    let mono: Vec<f32> = data
        .chunks_exact(channels.max(1))
        .map(|frame| convert(frame[0]))
        .collect();
    let mut out = Vec::new();
    resampler.push(&mono, &mut out);
    if !out.is_empty() {
        // 通道写满即丢弃：推理期间不积压，避免内存无限增长。
        let _ = tx.try_send(out);
    }
}

/// 任意块大小的线性插值重采样到 16kHz，带直流阻断（廉价麦克风常带直流偏置，抬高噪音底使 VAD 失真）。
struct Resampler {
    step: f64,
    frac: f64,
    prev: f32,
    next: f32,
    ready: bool,
    dc: f32,
}
impl Resampler {
    fn new(native_rate: u32) -> Self {
        Self {
            step: (SAMPLE_RATE as f64 / native_rate.max(1) as f64).clamp(1.0 / 32.0, 32.0),
            frac: 0.0,
            prev: 0.0,
            next: 0.0,
            ready: false,
            dc: 0.0,
        }
    }
    fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &raw in input {
            self.dc += DC_BLOCK_ALPHA * (raw - self.dc);
            let value = raw - self.dc;
            if !self.ready {
                self.ready = true;
                self.prev = value;
                self.next = value;
                continue;
            }
            self.prev = self.next;
            self.next = value;
            while self.frac < 1.0 {
                out.push(self.prev + (self.next - self.prev) * self.frac as f32);
                self.frac += self.step;
            }
            self.frac -= 1.0;
        }
    }
}

/// 能量 VAD：静音预滚 + 起音确认 + 静音收尾，阈值随噪音底自适应；返回完整语音段。
#[derive(Default)]
struct PendingSegment {
    preroll: Vec<f32>,
    samples: Vec<f32>,
    speech: usize,
    silence: usize,
    active: bool,
    noise_floor: f32,
}
impl PendingSegment {
    /// 起音阈值取噪音底估计的倍数且不低于绝对下限：安静麦克风不误触，嘈杂麦克风不常开。
    fn speech_threshold(&self) -> f32 {
        (self.noise_floor * NOISE_FLOOR_FACTOR).max(VAD_THRESHOLD)
    }
    fn push(&mut self, frame: &[f32]) -> Option<Vec<f32>> {
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32).sqrt();
        if !self.active {
            self.preroll.extend_from_slice(frame);
            let keep = PREROLL_FRAMES * VAD_FRAME;
            if self.preroll.len() > keep {
                self.preroll.drain(..self.preroll.len() - keep);
            }
            if rms >= self.speech_threshold() {
                self.speech += 1;
                if self.speech >= SPEECH_START_FRAMES {
                    self.active = true;
                    self.silence = 0;
                    self.samples = std::mem::take(&mut self.preroll);
                }
            } else {
                self.speech = 0;
                self.noise_floor = (self.noise_floor + NOISE_FLOOR_ALPHA * (rms - self.noise_floor)).max(NOISE_FLOOR_MIN);
            }
            return None;
        }
        self.samples.extend_from_slice(frame);
        if rms >= self.speech_threshold() {
            self.silence = 0;
        } else {
            self.silence += 1;
        }
        if self.silence >= SPEECH_END_FRAMES || self.samples.len() >= MAX_SEGMENT_FRAMES * VAD_FRAME {
            let samples = std::mem::take(&mut self.samples);
            self.active = false;
            self.speech = 0;
            self.silence = 0;
            self.preroll.clear();
            if samples.len() >= MIN_SEGMENT_FRAMES * VAD_FRAME {
                return Some(samples);
            }
        }
        None
    }
}

/// 语音意图：AI 只能从固定动作枚举中选择，解析失败一律回落 chat。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceIntent {
    pub action: String,
    pub text: String,
    pub summary: String,
}
const VOICE_ACTIONS: [&str; 7] = ["shutdown", "restart", "lock", "taskManager", "explorer", "weather", "openApp"];

fn intent_from_draft(draft: crate::core::ai::Draft, original: &str) -> VoiceIntent {
    let action = draft
        .fields
        .get("action")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if VOICE_ACTIONS.contains(&action.as_str()) {
        VoiceIntent { action, text: String::new(), summary: draft.summary }
    } else {
        VoiceIntent { action: "chat".into(), text: original.to_string(), summary: draft.summary }
    }
}

/// AI 意图分类：输入语音转写文本，返回白名单动作或 chat。可经 pet_chat_cancel 取消。
#[tauri::command]
pub async fn pet_voice_intent(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, crate::core::ai::RequestStore>,
    request_id: String,
    profile_id: String,
    revision: i64,
    text: String,
) -> PlatformResult<VoiceIntent> {
    let result: Result<VoiceIntent, String> = async {
        chat_caller(&window)?;
        if uuid::Uuid::parse_str(&request_id).is_err() { return Err("聊天请求标识无效".into()); }
        let text = text.trim().to_string();
        if text.is_empty() || text.chars().count() > 200 { return Err("语音指令无效或过长".into()); }
        if crate::core::ai::preview(&text)?.removed_lines > 0 {
            return Err("语音内容含疑似凭据，已停止处理".into());
        }
        let id = format!("pet:{request_id}");
        let (sender, mut receiver) = tokio::sync::watch::channel(false);
        store.begin(&id, &profile_id, sender)?;
        let _guard = super::ChatGuard { store: &store, id };
        let (profile, key) = crate::core::repositories::ai::load(&crate::core::storage::open_db()?, &profile_id)?;
        if profile.updated_at != revision { return Err("AI配置已更新，请关闭聊天后重新打开".into()); }
        let prompt_text = format!("用户说：{text}");
        let outcome = tokio::select! {
            biased;
            _ = receiver.changed() => Err("识别已停止".to_string()),
            result = crate::core::ai::request(&profile, &key, &crate::core::ai::Task::PetCommand, &prompt_text) => result,
        }?;
        Ok(intent_from_draft(outcome.0, &text))
    }
    .await;
    result.map_err(chat_error)
}

/// 唤醒词容错匹配：whisper 转写汉字存在随机同音字（小驼/小坨/小托），按等长滑窗
/// 逐字符比较，窗口内至多一字不同即视为命中，零依赖无数据表。返回窗口之后的剩余文本。
fn find_fuzzy_wake(text: &str, word: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let word_chars: Vec<char> = word.chars().collect();
    if word_chars.is_empty() || chars.len() < word_chars.len() { return None; }
    (0..=chars.len() - word_chars.len()).find_map(|start| {
        let window = &chars[start..start + word_chars.len()];
        let diff = window.iter().zip(word_chars.iter()).filter(|(x, y)| x != y).count();
        (diff <= 1).then(|| {
            let rest: String = chars[start + word_chars.len()..].iter().collect();
            rest.trim().to_string()
        })
    })
}

/// 归一化后做唤醒词容错子串匹配；指令取唤醒词之后的剩余文本。
/// 未命中的段落经 pet-voice-heard 上报（仅内存与界面展示，不落盘不写日志），便于排查唤醒词选词。
fn handle_segment(app: &AppHandle, engine: &Arc<Engine>, settings: &super::Settings, awake: &mut Option<Instant>, samples: &mut [f32]) {
    if engine.manual_active.load(Ordering::SeqCst) { return; }
    let Ok((model, _)) = resolve_model(settings) else { return };
    let Ok(transcript) = transcribe_samples(engine, &model, &settings.voice.language, samples) else { return };
    let text: String = transcript.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    if text.is_empty() { return; }
    let word: String = settings
        .voice
        .wake_word
        .trim()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    let after_wake = if word.is_empty() { None } else { find_fuzzy_wake(&text, &word) };
    match after_wake {
        Some(rest) if !rest.is_empty() => {
            *awake = None;
            let _ = app.emit("pet-voice-command", VoiceCommand { text: rest });
        }
        Some(_) => {
            *awake = Some(Instant::now() + WAKE_COMMAND_WINDOW);
            let _ = app.emit("pet-voice-awake", ());
        }
        None => {
            if let Some(until) = *awake {
                if Instant::now() <= until {
                    *awake = None;
                    let _ = app.emit("pet-voice-command", VoiceCommand { text });
                    return;
                }
            }
            let heard = transcript.trim().to_string();
            if !heard.is_empty() {
                let _ = app.emit("pet-voice-heard", VoiceHeard { text: heard });
            }
        }
    }
}
