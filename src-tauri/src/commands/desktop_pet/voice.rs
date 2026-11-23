//! 桌宠语音识别：本地 whisper.cpp 推理、ggml 模型管理与常驻唤醒词监听。
//! 音频在内存中处理；开启云端识别时，人声片段会发送给所选服务商。
use base64::Engine as _;
use serde::Serialize;
use std::{
    io::Write as _,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::{chat_caller, chat_error, caller, read_settings, PetStore};
use crate::core::error::PlatformResult;

mod mimo;
pub(super) use mimo::profile_available as mimo_profile_available;

const MODELS_DIR: &str = "voice-models";
const MODEL_MIN_BYTES: u64 = 1024 * 1024;
const MODEL_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const AUDIO_MAX_BYTES: usize = 8 * 1024 * 1024;
const SAMPLE_RATE: usize = 16_000;
const HARD_LIMIT_SECONDS: usize = 130;
const WAKE_COMMAND_WINDOW: Duration = Duration::from_secs(20);
const VAD_FRAME: usize = 512;
const VAD_THRESHOLD: f32 = 0.02;
/// 噪声底自适应：抬升快（外放声立即跟随），回落慢（抬升后的阈值不会被短暂安静几秒内拉回）。
const NOISE_FLOOR_ALPHA: f32 = 0.05;
const NOISE_FLOOR_DECAY_ALPHA: f32 = 0.002;
const NOISE_FLOOR_MIN: f32 = 0.002;
const NOISE_FLOOR_FACTOR: f32 = 2.5;
const DC_BLOCK_ALPHA: f32 = 0.01;
const SPEECH_START_FRAMES: usize = 3;
/// 静音收尾帧数（约 0.5 秒）：说完话到开始识别的固定等待，太长拖慢响应，太短易截断尾音。
const SPEECH_END_FRAMES: usize = 15;
/// 相邻语音段的最大拼接间隔：词间停顿被 VAD 切段后，仍在窗口内的段会合并后统一识别。
/// 600ms 覆盖常见词间停顿（<500ms），比 1s 减少"说完词干等"的固定延迟。
const SEGMENT_MERGE_GAP: Duration = Duration::from_millis(600);
const PREROLL_FRAMES: usize = 25;
const MIN_SEGMENT_FRAMES: usize = 9;
const MAX_SEGMENT_FRAMES: usize = 15 * (SAMPLE_RATE / VAD_FRAME);
/// 采集启动后的环境噪声校准帧数（约 3 秒）：先量底噪再启用语音检测。
const CALIBRATION_FRAMES: usize = 96;
/// 长噪声段抬高噪声底的上限：阈值最高 0.06（= 0.024 × 2.5），外放声（典型 RMS ≤ 0.056）被挡住而说话音量（≥ 0.08）仍触发。
const NOISE_FLOOR_BUMP_CAP: f32 = 0.024;
const NOISE_FLOOR_BUMP_RATIO: f32 = 0.85;
const DEVICE_STALL: Duration = Duration::from_secs(30);
const SETTINGS_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// whisper 引擎与常驻监听状态；随 MonitoringStore 管理，手动识别与唤醒循环共用同一把模型锁。
#[derive(Default)]
pub struct Engine {
    model: Mutex<Option<LoadedModel>>,
    listener_lifecycle: Mutex<()>,
    listening: AtomicBool,
    generation: AtomicU64,
    manual_active: AtomicBool,
    conversation: Mutex<VoiceConversation>,
    speech_lock: Mutex<()>,
    speech_generation: AtomicU64,
    speech_tail: Mutex<Option<Instant>>,
    speech_requests: tokio::sync::Mutex<()>,
    prepared_speech: Mutex<Vec<PreparedSpeech>>,
    download_name: Mutex<Option<String>>,
    download_cancel: AtomicBool,
    /// 运行诊断：实际采集设备名与分段计数（不含任何转写文本，便于界面直读）。
    active_device: Mutex<String>,
    listening_error: Mutex<Option<String>>,
    last_result: Mutex<Option<WakeResult>>,
    segments: AtomicU64,
    matched: AtomicU64,
    /// 云端空结果退避：连续空段落计数与暂停云端识别的截止时刻。
    cloud_empty_streak: AtomicU32,
    cloud_skip_until: Mutex<Option<Instant>>,
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
    pub device: String,
    pub devices: Vec<String>,
    pub active_device: String,
    pub listening_error: Option<String>,
    pub last_result: Option<WakeResult>,
    pub segments: u64,
    pub matched: u64,
    /// 讯飞凭据是否已配置（仅布尔状态，不回传凭据内容）。
    pub xfyun_configured: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningState {
    pub active: bool,
    pub error: Option<String>,
}
#[derive(Clone, Serialize)]
struct VoiceActivityEvent {
    generation: u64,
    active: bool,
}

struct VoiceActivity<'a> {
    app: &'a AppHandle,
    event: &'static str,
    generation: u64,
}

impl<'a> VoiceActivity<'a> {
    fn start(app: &'a AppHandle, event: &'static str, generation: u64) -> Self {
        let _ = app.emit(event, VoiceActivityEvent { generation, active: true });
        Self { app, event, generation }
    }
}

impl Drop for VoiceActivity<'_> {
    fn drop(&mut self) {
        let _ = self.app.emit(self.event, VoiceActivityEvent { generation: self.generation, active: false });
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCommand {
    pub text: String,
    pub woke: bool,
    pub command_id: u64,
}

#[derive(Default)]
struct VoiceConversation {
    command_id: u64,
    until: Option<Instant>,
}

impl VoiceConversation {
    fn advance(&mut self, until: Option<Instant>) -> u64 {
        self.command_id += 1;
        self.until = until;
        self.command_id
    }

    fn refresh(&mut self, command_id: u64, now: Instant) {
        if self.command_id == command_id && self.until.is_some() {
            self.until = Some(now + WAKE_COMMAND_WINDOW);
        }
    }

    fn accepts_follow_up(&self, now: Instant) -> bool {
        self.until.is_some_and(|until| now <= until)
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceHeard {
    pub text: String,
}
/// 监听过程中的瞬时识别失败；仅内存与界面展示，不落盘不写日志。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceError {
    pub message: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WakeResult {
    Transcribing,
    Unclear,
    Unmatched,
    Awakened,
    Command,
    Failed,
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
/// 云端语音识别单段超时：超时后自动回落本地 whisper。
const CLOUD_ASR_TIMEOUT: Duration = Duration::from_secs(6);
/// 云端空结果退避：连续 N 段空结果（判定为噪声）后暂停云端识别一段时间，
/// 避免环境噪声排队占用云端配额与识别循环，延误紧随其后的真实指令。
const CLOUD_EMPTY_BACKOFF_AFTER: u32 = 3;
const CLOUD_EMPTY_BACKOFF: Duration = Duration::from_secs(30);
/// 讯飞语音听写（流式版）接口地址：签名串与请求 host 必须与此一致，换地址需同步调整签名。
const XFYUN_IAT_HOST: &str = "iat-api.xfyun.cn";
const XFYUN_IAT_PATH: &str = "/v2/iat";
/// 16k16bit 下 1280 字节一帧（40ms 音频）；官方建议 40ms 间隔，为降低识别延迟按 10ms 发送。
const XFYUN_FRAME_BYTES: usize = 1280;
const XFYUN_FRAME_INTERVAL: Duration = Duration::from_millis(10);
/// 讯飞单次会话整体超时（含分帧发送节奏）：超时后回落本地识别。
const XFYUN_SESSION_TIMEOUT: Duration = Duration::from_secs(25);
/// 讯飞凭据在 client_preferences 中的加密存储键（AES-GCM 密文，不参与偏好导出与同步）。
const XFYUN_CREDENTIALS_KEY: &str = "desktop-pet-voice-xfyun-v1";

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
        if !super::valid_model_name(&name) { continue; }
        let size = meta.len();
        if size < MODEL_MIN_BYTES || size > MODEL_MAX_BYTES { continue; }
        models.push(VoiceModelInfo { name, size_bytes: size });
    }
    models.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    models
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
    // whisper 默认单线程推理，1.5 秒音频要转 30 秒；按可用核心并行后回到秒级。
    params.set_n_threads(std::thread::available_parallelism().map(|count| count.get() as i32).unwrap_or(4).min(8));
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

/// 枚举可用的麦克风设备名（支持采集的设备），供语音设置选择。
fn input_device_names() -> Vec<String> {
    let host = cpal::default_host();
    host.devices()
        .map(|devices| {
            devices
                .filter_map(|device| {
                    device.default_input_config().ok().and_then(|_| device.name().ok()).filter(|name| !name.is_empty())
                })
                .collect()
        })
        .unwrap_or_default()
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
    let engine = &app.state::<PetStore>().voice;
    Ok(VoiceStatus {
        models_dir: dir.to_string_lossy().into_owned(),
        ready: selected.is_some(),
        selected,
        models,
        catalog: MODEL_CATALOG
            .iter()
            .map(|(name, size)| VoiceModelInfo { name: (*name).into(), size_bytes: *size })
            .collect(),
        listening: engine.listening.load(Ordering::SeqCst),
        device: settings.voice.device.trim().to_string(),
        devices: input_device_names(),
        active_device: engine.active_device.lock().map(|active| active.clone()).unwrap_or_default(),
        listening_error: engine.listening_error.lock().ok().and_then(|error| error.clone()),
        last_result: engine.last_result.lock().ok().and_then(|result| *result),
        segments: engine.segments.load(Ordering::SeqCst),
        matched: engine.matched.load(Ordering::SeqCst),
        xfyun_configured: xfyun_configured(),
    })
}

#[tauri::command]
pub fn pet_voice_status(window: tauri::WebviewWindow, app: tauri::AppHandle) -> PlatformResult<VoiceStatus> {
    caller(&window)?;
    Ok(current_status(&app)?)
}

#[cfg(windows)]
const WINDOWS_SPEECH_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$text = $reader.ReadToEnd()
$reader.Dispose()
$locale = [Globalization.CultureInfo]::GetCultureInfo($env:CLOUDHUB_PET_SPEECH_LOCALE)
$gender = $env:CLOUDHUB_PET_SPEECH_GENDER
$pitch = $env:CLOUDHUB_PET_SPEECH_PITCH
$rate = $env:CLOUDHUB_PET_SPEECH_RATE
$prepare = $env:CLOUDHUB_PET_SPEECH_PREPARE -eq '1'

# Windows Settings installs voices in the Windows Runtime catalog. Keep the classic
# synthesizer available for voices supplied only through the legacy catalog.
if ($gender -ne 'NotSet') {
    $synth = $null
    $audio = $null
    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        $synthType = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]
        $audioType = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]
        $voices = @($synthType::AllVoices | Where-Object {
            ($_.Language -split '-')[0] -eq $locale.TwoLetterISOLanguageName
        } | Sort-Object -Property @{ Expression = { $_.Language -eq $locale.Name }; Descending = $true },
            @{ Expression = { $_.Gender -eq $gender }; Descending = $true }, Id)
        if ($voices.Count -gt 0) {
            $voice = $voices[0]
            if ($env:CLOUDHUB_PET_SPEECH_ALTERNATE -eq '1' -and $voices.Count -gt 1 -and
                $voices[1].Gender -eq $voice.Gender -and $voices[1].Language -eq $voice.Language) {
                $voice = $voices[1]
            }
            $synth = $synthType::new()
            $synth.Voice = $voice
            $synth.Options.AudioPitch = 1 + ([int]$pitch.TrimEnd('%') / 100)
            $synth.Options.SpeakingRate = 1 + ([int]$rate.TrimEnd('%') / 100)
            $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
                $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
                $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
            } | Select-Object -First 1
            $operation = $synth.SynthesizeTextToStreamAsync($text)
            $task = $asTask.MakeGenericMethod($audioType).Invoke($null, @($operation))
            $audio = $task.GetAwaiter().GetResult()
        }
    } catch {
        # Some systems expose only classic speech voices or lack runtime controls.
    } finally {
        if ($null -ne $synth) { $synth.Dispose() }
    }
    if ($null -ne $audio) {
        try {
            $stream = [IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($audio.GetInputStreamAt(0))
            try {
                if ($prepare) {
                    $stream.CopyTo([Console]::OpenStandardOutput())
                } else {
                    $player = [Media.SoundPlayer]::new($stream)
                    try { $player.PlaySync() } finally { $player.Dispose() }
                }
            } finally {
                $stream.Dispose()
            }
        } finally {
            $audio.Dispose()
        }
        exit 0
    }
}

Add-Type -AssemblyName System.Speech
$speech = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$wave = $null
try {
    if ($prepare) {
        $wave = [IO.MemoryStream]::new()
        $speech.SetOutputToWaveStream($wave)
    } else {
        $speech.SetOutputToDefaultAudioDevice()
    }
    if ($gender -eq 'NotSet') {
        $speech.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet,
            [System.Speech.Synthesis.VoiceAge]::NotSet, 0, $locale)
        $speech.Speak($text)
    } else {
        $voices = @($speech.GetInstalledVoices() | Where-Object {
            $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $locale.TwoLetterISOLanguageName
        } | ForEach-Object { $_.VoiceInfo })
        $voice = $voices | Sort-Object -Property @{ Expression = { $_.Culture.Name -eq $locale.Name }; Descending = $true },
            @{ Expression = { $_.Gender -eq $gender }; Descending = $true } | Select-Object -First 1
        if ($null -eq $voice) { exit 3 }
        $speech.SelectVoice($voice.Name)
        $escaped = [Security.SecurityElement]::Escape([regex]::Replace($text, '[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]', ''))
        $language = $voice.Culture.Name
        $speech.SpeakSsml("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='$language'><prosody pitch='$pitch' rate='$rate'>$escaped</prosody></speak>")
    }
    if ($prepare) {
        $speech.SetOutputToNull()
        $wave.WriteTo([Console]::OpenStandardOutput())
    }
} finally {
    $speech.Dispose()
    if ($null -ne $wave) { $wave.Dispose() }
}
"#;

struct PreparedSpeech {
    id: uuid::Uuid,
    generation: u64,
    voice: super::VoiceSettings,
    text: String,
    audio: mimo::PcmVoice,
}

#[tauri::command]
pub async fn pet_voice_speak(window: tauri::WebviewWindow, app: AppHandle, text: Option<String>, interrupt: bool, preview_preset: Option<super::SpeechPreset>, prepare_id: Option<uuid::Uuid>, prepared_id: Option<uuid::Uuid>) -> PlatformResult<()> {
    chat_caller(&window)?;
    let engine = app.state::<PetStore>().voice.clone();
    let generation = if interrupt || text.is_none() || preview_preset.is_some() {
        let generation = engine.speech_generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut prepared) = engine.prepared_speech.lock() { prepared.clear(); }
        generation
    } else {
        engine.speech_generation.load(Ordering::SeqCst)
    };
    if preview_preset.is_none() {
        let Some(text) = text.as_deref() else { return Ok(()) };
        if text.trim().is_empty() { return Ok(()) }
        if text.chars().count() > 16_000 { return Err(chat_error("语音播报文本过长".into())); }
    }
    let text = text.unwrap_or_default();
    if let Some(id) = prepare_id {
        if !interrupt && preview_preset.is_none() && prepared_id.is_none() {
            prepare_speech(&engine, generation, id, text).await.map_err(chat_error)?;
        }
        return Ok(());
    }
    speak_native(&app, &engine, generation, text, preview_preset, prepared_id).await.map_err(chat_error)
}

async fn prepare_speech(engine: &Arc<Engine>, generation: u64, id: uuid::Uuid, text: String) -> Result<(), String> {
    let settings = read_settings()?;
    if settings.quiet || !settings.voice.enabled || !settings.voice.speak { return Ok(()); }
    let audio = if let Some(voice) = settings.voice.speech_preset.mimo_voice() {
        let synthesis = mimo::synthesize(&settings.voice.speech_mimo_profile_id, voice, &text, &settings.voice.language);
        tokio::pin!(synthesis);
        loop {
            tokio::select! {
                result = &mut synthesis => break result?,
                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                    if engine.speech_generation.load(Ordering::SeqCst) != generation { return Ok(()); }
                }
            }
        }
    } else {
        #[cfg(windows)]
        {
            let input = speech_text(&text, &settings.voice.language);
            let voice = settings.voice.clone();
            let engine = engine.clone();
            tauri::async_runtime::spawn_blocking(move || prepare_windows(&engine, generation, &voice, &input))
                .await.map_err(|_| "声音预合成任务失败")??
        }
        #[cfg(not(windows))]
        return Ok(());
    };
    if let Ok(mut prepared) = engine.prepared_speech.lock() {
        if engine.speech_generation.load(Ordering::SeqCst) == generation {
            prepared.retain(|item| item.generation == generation && item.id != id);
            if prepared.len() == 2 { prepared.remove(0); }
            prepared.push(PreparedSpeech { id, generation, voice: settings.voice, text, audio });
        }
    }
    Ok(())
}

async fn speak_native(app: &AppHandle, engine: &Arc<Engine>, generation: u64, text: String, preview_preset: Option<super::SpeechPreset>, prepared_id: Option<uuid::Uuid>) -> Result<(), String> {
    let _request = engine.speech_requests.lock().await;
    if engine.speech_generation.load(Ordering::SeqCst) != generation { return Ok(()); }
    let settings = read_settings()?;
    if settings.quiet || (preview_preset.is_none() && (!settings.voice.enabled || !settings.voice.speak)) { return Ok(()); }
    let _activity = VoiceActivity::start(app, "pet-voice-playing", generation);
    let prepared = prepared_id.and_then(|id| {
        let mut prepared = engine.prepared_speech.lock().ok()?;
        let index = prepared.iter().position(|item| item.id == id && item.generation == generation
            && item.voice == settings.voice && item.text == text)?;
        Some(prepared.remove(index).audio)
    });
    if let Some(audio) = prepared {
        let app = app.clone();
        let playback_engine = engine.clone();
        let played = tauri::async_runtime::spawn_blocking(move || mimo::play(&playback_engine, generation, audio, &app)).await;
        if matches!(played, Ok(Ok(()))) { return Ok(()); }
        if engine.speech_generation.load(Ordering::SeqCst) != generation { return Ok(()); }
    }
    let preset = preview_preset.unwrap_or(settings.voice.speech_preset);
    if let Some(voice) = preset.mimo_voice() {
        let content = if preview_preset.is_some() { "嗯，我在。有什么需要我帮忙的吗？" } else { &text };
        let synthesis = mimo::synthesize(&settings.voice.speech_mimo_profile_id, voice, content, &settings.voice.language);
        tokio::pin!(synthesis);
        let audio = loop {
            tokio::select! {
                result = &mut synthesis => break result,
                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                    if engine.speech_generation.load(Ordering::SeqCst) != generation { return Ok(()); }
                }
            }
        };
        if engine.speech_generation.load(Ordering::SeqCst) != generation { return Ok(()); }
        let result = match audio {
            Ok(audio) => {
                let engine = engine.clone();
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || mimo::play(&engine, generation, audio, &app))
                    .await.map_err(|_| "播放小米 MiMo 音频失败".to_string())?
            }
            Err(error) => Err(error),
        };
        if engine.speech_generation.load(Ordering::SeqCst) != generation { return Ok(()); }
        match result {
            Ok(()) => return Ok(()),
            Err(error) if preview_preset.is_some() || !cfg!(windows) => return Err(error),
            Err(error) => {
                let _ = app.emit("pet-voice-playback-error", VoiceError { message: format!("{error}，已切换到系统语音") });
            }
        }
    }
    #[cfg(windows)]
    {
        let engine = engine.clone();
        tauri::async_runtime::spawn_blocking(move || speak_windows(&engine, generation, &text, preview_preset))
            .await.map_err(|_| "系统语音播报任务失败".to_string())?
    }
    #[cfg(not(windows))]
    {
        Err("当前系统不支持原生系统语音播报".into())
    }
}

#[tauri::command]
pub fn pet_voice_continue(window: tauri::WebviewWindow, app: AppHandle, command_id: u64) -> PlatformResult<()> {
    chat_caller(&window)?;
    let engine = &app.state::<PetStore>().voice;
    if engine.listening.load(Ordering::SeqCst) {
        if let Ok(mut conversation) = engine.conversation.lock() {
            conversation.refresh(command_id, Instant::now());
        }
    }
    Ok(())
}

fn speech_text(text: &str, language: &str) -> String {
    let dot = if language == "en" { " dot " } else { " 点 " };
    let mut result = String::with_capacity(text.len());
    let mut start = 0;
    for (index, ch) in text.char_indices().chain(std::iter::once((text.len(), '\0'))) {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '/') { continue; }
        let original = &text[start..index];
        let domain = original.trim_end_matches('.');
        let looks_like_domain = domain.rsplit_once('.').is_some_and(|(prefix, suffix)| {
            !prefix.is_empty() && !prefix.contains('/') && suffix.len() >= 2
                && suffix.bytes().all(|letter| letter.is_ascii_alphabetic())
                && prefix.split('.').all(|label| !label.is_empty() && label.bytes().any(|letter| letter.is_ascii_alphanumeric()))
        });
        if original.eq_ignore_ascii_case("ICP/IP") {
            result.push_str(if language == "en" { "I C P, I P" } else { "I C P，I P" });
        } else if looks_like_domain {
            result.push_str(&domain.replace('.', dot));
            result.push_str(&original[domain.len()..]);
        } else {
            result.push_str(original);
        }
        if index < text.len() && ch != '`' { result.push(ch); }
        start = index + ch.len_utf8();
    }
    result
}

#[cfg(windows)]
fn windows_speech_child(voice: &super::VoiceSettings, preset: super::SpeechPreset, prepare: bool) -> Result<std::process::Child, String> {
    use std::{os::windows::process::CommandExt, process::{Command, Stdio}};
    use super::SpeechPreset;
    let error = || "Windows 语音播报失败，请检查默认播放设备和系统语音包".to_string();
    let locale = if voice.language == "en" { "en-US" } else { "zh-CN" };
    let (gender, pitch, rate) = match preset {
        SpeechPreset::System | SpeechPreset::MimoBingtang | SpeechPreset::MimoMoli => ("NotSet", "+0%", "+0%"),
        SpeechPreset::Warm => ("Female", "+12%", "-8%"),
        SpeechPreset::Clear => ("Female", "+0%", "+4%"),
        SpeechPreset::Bright => ("Female", "+28%", "+14%"),
        SpeechPreset::Steady => ("Male", "-20%", "-16%"),
    };
    let program = std::env::var_os("SystemRoot").map(PathBuf::from).ok_or_else(error)?
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    // 播报内容仅通过 stdin 交给固定脚本，避免将对话内容放在命令行或诊断日志中。
    Command::new(program)
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SPEECH_SCRIPT])
        .env("CLOUDHUB_PET_SPEECH_LOCALE", locale)
        .env("CLOUDHUB_PET_SPEECH_GENDER", gender)
        .env("CLOUDHUB_PET_SPEECH_PITCH", pitch)
        .env("CLOUDHUB_PET_SPEECH_RATE", rate)
        .env("CLOUDHUB_PET_SPEECH_ALTERNATE", if preset == SpeechPreset::Bright { "1" } else { "0" })
        .env("CLOUDHUB_PET_SPEECH_PREPARE", if prepare { "1" } else { "0" })
        .creation_flags(0x0800_0000)
        .stdin(Stdio::piped()).stdout(if prepare { Stdio::piped() } else { Stdio::null() }).stderr(Stdio::null())
        .spawn().map_err(|_| error())
}

#[cfg(windows)]
fn prepare_windows(engine: &Engine, generation: u64, voice: &super::VoiceSettings, text: &str) -> Result<mimo::PcmVoice, String> {
    use std::io::Read;
    let error = || "无法预合成 Windows 语音".to_string();
    let mut child = windows_speech_child(voice, voice.speech_preset, true)?;
    let stdout = child.stdout.take().ok_or_else(error)?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(16 * 1024 * 1024).read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(12);
    let result = (|| {
        child.stdin.take().ok_or_else(error)?.write_all(text.as_bytes()).map_err(|_| error())?;
        loop {
            if engine.speech_generation.load(Ordering::SeqCst) != generation || Instant::now() >= deadline {
                return Err(error());
            }
            if let Some(status) = child.try_wait().map_err(|_| error())? {
                return if status.success() { Ok(()) } else { Err(error()) };
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    })();
    if result.is_err() { let _ = child.kill(); let _ = child.wait(); }
    let bytes = reader.join().map_err(|_| error())?.map_err(|_| error())?;
    result?;
    mimo::parse_wave(&bytes).ok_or_else(error)
}

#[cfg(windows)]
fn speak_windows(engine: &Engine, generation: u64, text: &str, preview_preset: Option<super::SpeechPreset>) -> Result<(), String> {
    let error = || "Windows 语音播报失败，请检查默认播放设备和系统语音包".to_string();
    let _speech = engine.speech_lock.lock().map_err(|_| error())?;
    if engine.speech_generation.load(Ordering::SeqCst) != generation { return Ok(()) }
    let settings = read_settings()?;
    if settings.quiet || (preview_preset.is_none() && (!settings.voice.enabled || !settings.voice.speak)) { return Ok(()) }
    let text = match (preview_preset, settings.voice.language.as_str()) {
        (Some(_), "en") => "Hello, I'm your desktop companion. I'll be here whenever you need me.",
        (Some(_), _) => "你好，我是你的桌面伙伴。有需要的时候，随时叫我。",
        (None, _) => text,
    };
    let text = speech_text(text, &settings.voice.language);
    let mut child = windows_speech_child(&settings.voice, preview_preset.unwrap_or(settings.voice.speech_preset), false)?;
    log_event("playback requested");

    let deadline = Instant::now() + Duration::from_secs(180);
    let result = (|| {
        child.stdin.take().ok_or_else(error)?.write_all(text.as_bytes()).map_err(|_| error())?;
        loop {
            if engine.speech_generation.load(Ordering::SeqCst) != generation {
                return Ok("playback canceled");
            }
            if let Some(status) = child.try_wait().map_err(|_| error())? {
                return if status.success() {
                    Ok("playback completed")
                } else if status.code() == Some(3) {
                    Err("缺少对应语言的系统播报语音，请在 Windows 语音设置中按需安装".into())
                } else {
                    Err(error())
                };
            }
            if Instant::now() >= deadline { return Err(error()); }
            std::thread::sleep(Duration::from_millis(60));
        }
    })();
    if !matches!(result, Ok("playback completed")) {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Ok(mut tail) = engine.speech_tail.lock() {
        *tail = Some(Instant::now() + Duration::from_millis(350));
    }
    log_event(result.as_ref().copied().unwrap_or("playback failed"));
    result.map(|_| ())
}

#[cfg(windows)]
fn acknowledge_wake(app: &AppHandle, engine: &Arc<Engine>, settings: &super::Settings, has_command: bool) {
    if !settings.voice.speak || settings.quiet { return; }
    let generation = engine.speech_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let message = if has_command { "我在。" } else { "我在，请说。" };
    let engine = engine.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(message) = speak_native(&app, &engine, generation, message.into(), None, None).await {
            log_event("wake playback unavailable");
            let _ = app.emit("pet-voice-playback-error", VoiceError { message });
        }
    });
}

fn capturing_playback(engine: &Engine) -> bool {
    engine.speech_lock.try_lock().is_err()
        || engine.speech_tail.lock().is_ok_and(|tail| tail.is_some_and(|until| until > Instant::now()))
}

#[tauri::command]
pub async fn pet_voice_transcribe(window: tauri::WebviewWindow, app: tauri::AppHandle, audio: String) -> PlatformResult<Option<String>> {
    chat_caller(&window)?;
    let started = Instant::now();
    let settings = read_settings()?;
    let engine = app.state::<PetStore>().voice.clone();
    engine.manual_active.store(true, Ordering::SeqCst);
    let result: Result<String, String> = async {
        if !settings.voice.enabled { return Err("请先在桌宠设置中启用语音对话".into()); }
        let mut samples = decode_audio(&audio)?;
        // 手动听写与常驻监听共用同一云端识别选择：云端优先（更快更准），失败或空结果静默回落本地。
        if settings.voice.cloud_asr_enabled
            && (settings.voice.cloud_provider == "xfyun" || !settings.voice.cloud_profile_id.trim().is_empty())
        {
            let cloud_settings = settings.clone();
            let mut cloud_samples = samples.clone();
            let cloud = match tauri::async_runtime::spawn_blocking(move || {
                if cloud_settings.voice.cloud_provider == "xfyun" {
                    cloud_segment_transcript_xfyun(&cloud_settings, &mut cloud_samples)
                } else {
                    cloud_segment_transcript(&cloud_settings, &mut cloud_samples)
                }
            })
            .await
            {
                Ok(inner) => inner,
                Err(_) => Err("云端识别任务失败".to_string()),
            };
            match cloud {
                Ok(text) if !text.trim().is_empty() => {
                    log_event("manual cloud transcribed");
                    return Ok(text);
                }
                Ok(_) => log_event("manual cloud empty"),
                Err(error) => log_event(&format!("manual cloud error: {error}")),
            }
        }
        let (model, _) = resolve_model(&settings)?;
        let task_engine = engine.clone();
        let language = settings.voice.language.clone();
        tauri::async_runtime::spawn_blocking(move || transcribe_samples(&task_engine, &model, &language, &mut samples))
            .await
            .map_err(|_| "语音识别任务失败".to_string())?
    }
    .await;
    engine.manual_active.store(false, Ordering::SeqCst);
    let (status, detail) = match &result {
        Ok(text) if text.trim().is_empty() => ("未识别", None),
        Ok(text) if !has_voice_command_content(text) => ("文字过短", Some(text.as_str())),
        Ok(text) => ("已识别", Some(text.as_str())),
        Err(_) => ("识别失败", None),
    };
    super::activity::record(&app, super::activity::Kind::Voice, started, "手动语音输入", status, detail);
    let text = result.map_err(chat_error)?;
    let text = text.trim().to_string();
    if text.is_empty() { return Err(chat_error("未识别到语音内容，请靠近麦克风再试一次".into())); }
    Ok(has_voice_command_content(&text).then_some(text))
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

/// 云端失败响应的日志摘要：截断并压平换行；错误路径的响应体不含转写文本。
/// 监听事件诊断日志：仅设备名、分段计数与结果种类，不含任何转写文本；超过 256KB 自动重建。
fn log_event(message: &str) {    let Ok(dir) = crate::core::paths::data_dir() else { return };
    let path = dir.join("pet-voice.log");
    let open = || std::fs::OpenOptions::new().append(true).create(true).open(&path);
    let mut file = match open() { Ok(file) => file, Err(_) => return };
    if file.metadata().map(|meta| meta.len() > 256 * 1024).unwrap_or(false) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        file = match open() { Ok(file) => file, Err(_) => return };
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = writeln!(file, "[{stamp}] {message}");
}

fn report_listening(app: &AppHandle, engine: &Engine, active: bool, error: Option<String>) {
    if let Ok(mut current) = engine.listening_error.lock() {
        *current = error.clone();
    }
    let _ = app.emit("pet-voice-listening", ListeningState { active, error });
}

/// 依据设置启停常驻监听：调用于应用初始化与设置保存之后。
pub fn sync_listener(app: &AppHandle) {
    let engine = app.state::<PetStore>().voice.clone();
    let Ok(_lifecycle) = engine.listener_lifecycle.lock() else { return };
    let want = match read_settings() {
        Ok(settings) => settings.voice.enabled && settings.voice.wake_enabled,
        Err(error) => {
            // 设置读取失败时监听绝不能静默不启动：上报事件与终端日志，便于排查。
            eprintln!("pet-voice: 设置读取失败，常驻监听未启动：{error}");
            log_event(&format!("sync settings error: {error}"));
            report_listening(app, &engine, false, Some(format!("语音监听未启动：{error}")));
            false
        }
    };
    let running = engine.listening.load(Ordering::SeqCst);
    log_event(&format!("sync want={want} running={running}"));
    if !want {
        if running {
            engine.generation.fetch_add(1, Ordering::SeqCst);
            engine.listening.store(false, Ordering::SeqCst);
            if let Ok(mut active) = engine.active_device.lock() { active.clear(); }
            report_listening(app, &engine, false, None);
        }
        return;
    }
    if running { return; }
    let generation = engine.generation.fetch_add(1, Ordering::SeqCst) + 1;
    engine.listening.store(true, Ordering::SeqCst);
    eprintln!("pet-voice: 常驻监听启动（generation {generation}）");
    let worker_engine = engine.clone();
    let spawned = std::thread::Builder::new().name("pet-voice-wake".into()).spawn({
        let app = app.clone();
        move || {
            let engine = worker_engine;
            // 线程崩溃必须复位 listening 并上报，否则徽标常亮而监听已死，无从排查。
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| wake_loop(app.clone(), engine.clone(), generation)));
            if outcome.is_err() {
                let Ok(_lifecycle) = engine.listener_lifecycle.lock() else { return };
                if engine.generation.load(Ordering::SeqCst) != generation { return; }
                engine.listening.store(false, Ordering::SeqCst);
                if let Ok(mut active) = engine.active_device.lock() { active.clear(); }
                report_listening(&app, &engine, false, Some("语音监听异常退出，请重新保存语音设置以重启".into()));
            }
        }
    });
    if spawned.is_err() {
        engine.listening.store(false, Ordering::SeqCst);
        report_listening(app, &engine, false, Some("语音监听线程启动失败".into()));
    }
}

fn wake_loop(app: AppHandle, engine: Arc<Engine>, generation: u64) {
    log_event(&format!("listener start gen={generation}"));
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
        match capture_session(&app, &engine, generation, &settings) {
            Ok(SessionEnd::Stopped) => break,
            Ok(SessionEnd::SettingsChanged) => {
                log_event("session settings changed, recapturing");
                continue;
            }
            Err(error) => {
                {
                    let Ok(_lifecycle) = engine.listener_lifecycle.lock() else { break };
                    if engine.generation.load(Ordering::SeqCst) != generation { break; }
                    if let Ok(mut active) = engine.active_device.lock() { active.clear(); }
                    log_event(&format!("capture error: {error}"));
                    report_listening(&app, &engine, true, Some(error));
                }
                std::thread::sleep(Duration::from_secs(10));
            }
        }
    }
    log_event("listener stop");
    let Ok(_lifecycle) = engine.listener_lifecycle.lock() else { return };
    if engine.generation.load(Ordering::SeqCst) != generation { return; }
    engine.listening.store(false, Ordering::SeqCst);
    if let Ok(mut active) = engine.active_device.lock() { active.clear(); }
    report_listening(&app, &engine, false, None);
}

enum SessionEnd {
    Stopped,
    SettingsChanged,
}

fn capture_session(app: &AppHandle, engine: &Arc<Engine>, generation: u64, settings: &super::Settings) -> Result<SessionEnd, String> {
    resolve_model(settings)?;
    let host = cpal::default_host();
    // 用户在语音设置中选择的麦克风优先；未选择时跟随系统默认设备（可能被虚拟音频软件抢占）。
    let wanted = settings.voice.device.trim();
    // 兼容旧版本下拉框把文本"系统默认"当作设备名存进设置的配置，与空值同样视为跟随系统默认。
    let wanted = if wanted == "系统默认" { "" } else { wanted };
    let device = if wanted.is_empty() {
        host.default_input_device().ok_or("未检测到麦克风")?
    } else {
        host.devices()
            .map_err(|_| "无法枚举麦克风设备")?
            .find(|candidate| candidate.name().map(|name| name == wanted).unwrap_or(false))
            .ok_or(format!("找不到麦克风“{wanted}”，请在语音设置中重新选择"))?
    };
    eprintln!("pet-voice: 输入设备：{}", device.name().unwrap_or_else(|_| "未知".into()));
    let resolved_name = device.name().unwrap_or_default();
    log_event(&format!("capture device={resolved_name}"));
    let supported = device.default_input_config().map_err(|_| "麦克风不可用，请检查设备连接")?;
    let config: cpal::StreamConfig = supported.clone().into();
    eprintln!("pet-voice: 采集参数 {}Hz {}声道 {:?}，正在启动数据流", config.sample_rate.0, config.channels, supported.sample_format());
    // 识别期间继续缓存采集回调交付的数据，队列满时丢弃新数据以保持内存有界。
    let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(960);
    let stream = build_capture_stream(&device, config, supported.sample_format(), supported.channels() as usize, supported.sample_rate().0, tx)
        .map_err(|_| "麦克风启动失败，请检查设备与采样格式")?;
    stream.play().map_err(|_| "麦克风启动失败")?;
    {
        let _lifecycle = engine.listener_lifecycle.lock().map_err(|_| "语音监听状态不可用")?;
        if engine.generation.load(Ordering::SeqCst) != generation { return Ok(SessionEnd::Stopped); }
        if let Ok(mut active) = engine.active_device.lock() { *active = resolved_name; }
        if let Ok(mut result) = engine.last_result.lock() { *result = None; }
        if let Ok(mut conversation) = engine.conversation.lock() { conversation.advance(None); }
        engine.segments.store(0, Ordering::SeqCst);
        engine.matched.store(0, Ordering::SeqCst);
        report_listening(app, engine, true, None);
    }
    eprintln!("pet-voice: 麦克风采集已开始");
    log_event("stream started");
    let mut pending = PendingSegment { calibrating: CALIBRATION_FRAMES, ..Default::default() };
    // 词间停顿会被 VAD 切成多个段：间隔在窗口内的段合并后再识别，避免“小…驼”只转写一半。
    let mut merged: Option<(Vec<f32>, Instant, f32)> = None;
    let mut capturing = None;
    let mut buffer: Vec<f32> = Vec::with_capacity(VAD_FRAME * 4);
    let mut last_data = Instant::now();
    let mut last_settings = Instant::now();
    let result = loop {
        if !engine.listening.load(Ordering::SeqCst) || engine.generation.load(Ordering::SeqCst) != generation {
            break Ok(SessionEnd::Stopped);
        }
        if last_settings.elapsed() >= SETTINGS_CHECK_INTERVAL {
            last_settings = Instant::now();
            let current = read_settings().map_err(|_| "读取桌宠语音设置失败".to_string())?;
            if current.voice != settings.voice {
                break Ok(SessionEnd::SettingsChanged);
            }
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => {
                last_data = Instant::now();
                if capturing_playback(engine) {
                    buffer.clear();
                    merged = None;
                    pending = PendingSegment { noise_floor: pending.noise_floor, calibrating: pending.calibrating, ..Default::default() };
                    capturing = None;
                    continue;
                }
                buffer.extend(chunk);
                while buffer.len() >= VAD_FRAME {
                    let frame: Vec<f32> = buffer.drain(..VAD_FRAME).collect();
                    let segment = pending.push(&frame);
                    if capturing.is_none() && (pending.active || segment.is_some()) {
                        capturing = Some(VoiceActivity::start(app, "pet-voice-capturing", generation));
                    }
                    if let Some((segment, avg_rms)) = segment {
                        // 已有合并段过期或拼接后超长：先把旧缓冲送去识别，再接收新段。
                        if merged.as_ref().is_some_and(|(samples, last, _)| {
                            last.elapsed() > SEGMENT_MERGE_GAP || samples.len() + segment.len() > MAX_SEGMENT_FRAMES * VAD_FRAME
                        }) {
                            flush_segment(app, engine, generation, settings, &mut pending, &mut merged);
                        }
                        if let Some((samples, last, seen_avg)) = &mut merged {
                            samples.extend_from_slice(&segment);
                            *seen_avg = seen_avg.max(avg_rms);
                            *last = Instant::now();
                        } else {
                            merged = Some((segment, Instant::now(), avg_rms));
                        }
                    }
                }
                if merged.as_ref().is_some_and(|(_, last, _)| last.elapsed() >= SEGMENT_MERGE_GAP) {
                    flush_segment(app, engine, generation, settings, &mut pending, &mut merged);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if merged.as_ref().is_some_and(|(_, last, _)| last.elapsed() >= SEGMENT_MERGE_GAP) {
                    flush_segment(app, engine, generation, settings, &mut pending, &mut merged);
                }
                if last_data.elapsed() >= DEVICE_STALL {
                    break Err("麦克风无响应，请检查设备连接".into());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break Err("麦克风数据中断".into()),
        }
        if !pending.active && merged.is_none() {
            capturing = None;
        }
    };
    // 结束采集时丢弃旧会话缓存，避免在关闭监听或更换识别设置后继续上传。
    result
}

/// 将合并完成的语音段送识别；判定为环境噪声时按段均 RMS 抬升噪声底，让阈值跟随外放等持续环境声。
fn flush_segment(app: &AppHandle, engine: &Arc<Engine>, generation: u64, settings: &super::Settings, pending: &mut PendingSegment, merged: &mut Option<(Vec<f32>, Instant, f32)>) {
    let Some((mut buffered, heard_at, avg_rms)) = merged.take() else { return };
    if matches!(handle_segment(app, engine, generation, settings, heard_at, &mut buffered), SegmentOutcome::Noise) {
        pending.noise_floor = pending.noise_floor.max((avg_rms * NOISE_FLOOR_BUMP_RATIO).min(NOISE_FLOOR_BUMP_CAP));
        log_event(&format!("noise floor raised to {:.4}", pending.noise_floor));
    }
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
        let _ = tx.try_send(out);
    }
}

/// 任意块大小的线性插值重采样到 16kHz，带直流阻断（廉价麦克风常带直流偏置，抬高噪音底使 VAD 失真）
/// 与 150Hz 高通（桌面震动、风扇、麦克风爆音等低频隆隆声会触发 VAD 并持续抬高噪声底，
/// 使正常音量的唤醒词低于阈值而失效；语音共振峰在 250Hz~3kHz 不受影响）。
struct Resampler {
    step: f64,
    frac: f64,
    prev: f32,
    next: f32,
    ready: bool,
    dc: f32,
    hp_in: f32,
    hp_out: f32,
    hp_alpha: f32,
}
impl Resampler {
    fn new(native_rate: u32) -> Self {
        let rc = 1.0 / (std::f64::consts::TAU * 150.0);
        Self {
            // 每输出一个样本，输入位置应前进 native_rate / SAMPLE_RATE 个样本。
            step: native_rate.max(1) as f64 / SAMPLE_RATE as f64,
            frac: 0.0,
            prev: 0.0,
            next: 0.0,
            ready: false,
            dc: 0.0,
            hp_in: 0.0,
            hp_out: 0.0,
            hp_alpha: (rc / (rc + 1.0 / native_rate.max(1) as f64)) as f32,
        }
    }
    fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &raw in input {
            self.dc += DC_BLOCK_ALPHA * (raw - self.dc);
            let dc_free = raw - self.dc;
            self.hp_out = self.hp_alpha * (self.hp_out + dc_free - self.hp_in);
            self.hp_in = dc_free;
            let value = self.hp_out;
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

/// 能量 VAD：静音预滚 + 起音确认 + 静音收尾，阈值随噪音底自适应；返回完整语音段及其均 RMS。
/// 启动前先校准约 3 秒环境底噪，避免外放音频等持续环境声把检测器淹没。
#[derive(Default)]
struct PendingSegment {
    preroll: Vec<f32>,
    samples: Vec<f32>,
    speech: usize,
    silence: usize,
    active: bool,
    noise_floor: f32,
    calibrating: usize,
    active_rms_sum: f64,
    active_frames: u32,
}
impl PendingSegment {
    /// 起音阈值取噪音底估计的倍数且不低于绝对下限：安静麦克风不误触，嘈杂麦克风不常开。
    fn speech_threshold(&self) -> f32 {
        (self.noise_floor * NOISE_FLOOR_FACTOR).max(VAD_THRESHOLD)
    }
    fn push(&mut self, frame: &[f32]) -> Option<(Vec<f32>, f32)> {
        let rms = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32).sqrt();
        if self.calibrating > 0 {
            self.calibrating -= 1;
            self.noise_floor = (self.noise_floor + NOISE_FLOOR_ALPHA * (rms - self.noise_floor)).max(NOISE_FLOOR_MIN);
            return None;
        }
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
                    self.active_rms_sum = 0.0;
                    self.active_frames = 0;
                    self.samples = std::mem::take(&mut self.preroll);
                }
            } else {
                self.speech = 0;
                let alpha = if rms < self.noise_floor { NOISE_FLOOR_DECAY_ALPHA } else { NOISE_FLOOR_ALPHA };
                self.noise_floor = (self.noise_floor + alpha * (rms - self.noise_floor)).max(NOISE_FLOOR_MIN);
            }
            return None;
        }
        self.samples.extend_from_slice(frame);
        self.active_rms_sum += (rms * rms) as f64;
        self.active_frames += 1;
        if rms >= self.speech_threshold() {
            self.silence = 0;
        } else {
            self.silence += 1;
        }
        if self.silence >= SPEECH_END_FRAMES || self.samples.len() >= MAX_SEGMENT_FRAMES * VAD_FRAME {
            let samples = std::mem::take(&mut self.samples);
            let avg_rms = if self.active_frames > 0 { (self.active_rms_sum / self.active_frames as f64).sqrt() as f32 } else { 0.0 };
            self.active = false;
            self.speech = 0;
            self.silence = 0;
            self.active_rms_sum = 0.0;
            self.active_frames = 0;
            self.preroll.clear();
            if samples.len() >= MIN_SEGMENT_FRAMES * VAD_FRAME {
                return Some((samples, avg_rms));
            }
        }
        None
    }
}

/// 语音意图：AI 只能从固定动作枚举中选择，解析失败一律回落 chat。
/// shell_enabled 时额外允许 shell 动作（单条 CMD 命令，需本地校验通过且用户确认）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceIntent {
    pub action: String,
    pub command: Option<String>,
    pub text: String,
    pub summary: String,
}
const VOICE_ACTIONS: [&str; 7] = ["shutdown", "restart", "lock", "taskManager", "explorer", "weather", "openApp"];

fn intent_from_draft(draft: crate::core::ai::Draft, original: &str, shell_enabled: bool) -> VoiceIntent {
    let action = draft
        .fields
        .get("action")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if VOICE_ACTIONS.contains(&action.as_str()) {
        VoiceIntent { action, command: None, text: String::new(), summary: draft.summary }
    } else if shell_enabled && action == "shell" {
        // 命令先过本地校验：黑名单或格式不合法时回落 chat，避免把无效命令弹给用户。
        let command = draft.fields.get("command").and_then(|value| value.as_str()).unwrap_or("").trim().to_string();
        match super::shell::validate(&command).map(|valid| valid.to_string()) {
            Ok(valid) => VoiceIntent { action, command: Some(valid), text: String::new(), summary: draft.summary },
            Err(_) => VoiceIntent { action: "chat".into(), command: None, text: original.to_string(), summary: draft.summary },
        }
    } else {
        VoiceIntent { action: "chat".into(), command: None, text: original.to_string(), summary: draft.summary }
    }
}

/// AI 意图分类：输入语音转写文本，返回白名单动作或 chat。可经 pet_chat_cancel 取消。
/// shell_enabled 由前端按设置传入：开启时提示词才包含 shell 动作，未开启时模型无从选择。
#[tauri::command]
pub async fn pet_voice_intent(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, crate::core::ai::RequestStore>,
    request_id: String,
    profile_id: String,
    revision: i64,
    text: String,
    shell_enabled: bool,
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
        let task = if shell_enabled { crate::core::ai::Task::PetShell } else { crate::core::ai::Task::PetCommand };
        let outcome = tokio::select! {
            biased;
            _ = receiver.changed() => Err("识别已停止".to_string()),
            result = crate::core::ai::request(&profile, &key, &task, &prompt_text) => result,
        }?;
        Ok(intent_from_draft(outcome.0, &text, shell_enabled))
    }
    .await;
    result.map_err(chat_error)
}

fn has_voice_command_content(text: &str) -> bool {
    text.chars().filter(|character| character.is_alphanumeric()).nth(3).is_some()
}

/// 匹配用字符归一化：汉字转无声调拼音（同音字如"驼/坨/陀"一致），字母转小写。
fn match_letters(character: char) -> String {
    use pinyin::ToPinyin;
    match character.to_pinyin() {
        Some(pinyin) => pinyin.plain().to_string(),
        None => character.to_lowercase().collect(),
    }
}

/// 忽略大小写与标点来查找唤醒词，用原文偏移保留后续指令中的空格与标点。
/// 文本与唤醒词统一转无声调拼音后做包含匹配：识别器把唤醒词写成同音字（驼/坨等）也能命中。
/// 拼音串没有分词边界，极端情况下可能被同拼音的其他句子误唤醒，后果只是提前进入唤醒态，可接受。
fn wake_command<'a>(text: &'a str, wake_words: &str) -> Option<&'a str> {
    let mut normalized = String::new();
    let mut original_ends = Vec::new();
    for (offset, character) in text.char_indices().filter(|(_, character)| character.is_alphanumeric()) {
        for letter in match_letters(character).chars() {
            normalized.push(letter);
            original_ends.resize(normalized.len(), offset + character.len_utf8());
        }
    }
    let mut words: Vec<String> = wake_words.split([',', '，', '、'])
        .map(|part| {
            let mut word = String::new();
            for character in part.chars().filter(|character| character.is_alphanumeric()) {
                word.push_str(&match_letters(character));
            }
            word
        })
        .filter(|word: &String| !word.is_empty())
        .collect();
    words.sort_by_key(|word| std::cmp::Reverse(word.len()));
    let (start, word) = words.iter().filter_map(|word| {
        normalized.find(word.as_str()).map(|start| (start, word))
    }).min_by_key(|(start, _)| *start)?;
    let mut matched_end = start + word.len();
    // 连喊宠物名字时，识别器可能重复唤醒词或加儿化尾音（拼音域为 "er"）。
    // 儿音仅在剥掉后能继续吞并重复唤醒词或直接收尾时才剥，避免误吞"二""而"等同音字。
    let mut suffix = &normalized[matched_end..];
    loop {
        let stripped = suffix.strip_prefix("er").unwrap_or(suffix);
        if stripped.is_empty() || words.iter().any(|candidate| stripped.starts_with(candidate.as_str())) {
            matched_end += suffix.len() - stripped.len();
            suffix = stripped;
        }
        let Some(next) = words.iter().find(|candidate| suffix.starts_with(candidate.as_str())) else { break };
        matched_end += next.len();
        suffix = &suffix[next.len()..];
    }
    if suffix.is_empty() {
        return Some("");
    }
    let end = original_ends[matched_end - 1];
    Some(text[end..].trim_start_matches(|character: char| !character.is_alphanumeric()).trim_end())
}

/// 临时诊断：转写用户实测录音，验证真实人声的识别效果。
#[cfg(test)]
mod wake_diagnostic {
    use super::*;

    #[test]
    fn follow_up_window_restarts_after_the_latest_reply() {
        let now = Instant::now();
        let mut conversation = VoiceConversation::default();
        assert!(!conversation.accepts_follow_up(now));
        let first = conversation.advance(Some(now + WAKE_COMMAND_WINDOW));
        let reply_finished = now + WAKE_COMMAND_WINDOW * 2;
        assert!(!conversation.accepts_follow_up(reply_finished));
        conversation.refresh(first, reply_finished);
        assert!(conversation.accepts_follow_up(reply_finished + Duration::from_secs(5)));

        let second = conversation.advance(Some(reply_finished + WAKE_COMMAND_WINDOW));
        let expired = reply_finished + WAKE_COMMAND_WINDOW * 2;
        conversation.refresh(first, expired);
        assert!(!conversation.accepts_follow_up(expired));
        conversation.advance(None);
        conversation.refresh(second, expired);
        assert!(!conversation.accepts_follow_up(expired));
    }

    #[test]
    fn resampling_preserves_duration_and_pitch_across_callback_boundaries() {
        for rate in [8_000, 16_000, 44_100, 48_000] {
            let input: Vec<f32> = (0..rate)
                .map(|index| (std::f32::consts::TAU * 440.0 * index as f32 / rate as f32).sin())
                .collect();
            let mut resampler = Resampler::new(rate);
            let mut output = Vec::new();
            for chunk in input.chunks(137) {
                resampler.push(chunk, &mut output);
            }
            assert!(output.len().abs_diff(SAMPLE_RATE) <= 2, "{rate} Hz: {} samples", output.len());
            let cycles = output.windows(2).filter(|pair| pair[0] <= 0.0 && pair[1] > 0.0).count();
            assert!(cycles.abs_diff(440) <= 1, "{rate} Hz: {cycles} cycles");
        }
    }

    #[test]
    fn short_voice_text_is_filtered_after_matching_the_wake_phrase() {
        for text in ["啊", "（谢谢）", "几 点 了？", "…", "OK!"] {
            assert!(!has_voice_command_content(text));
        }
        assert!(has_voice_command_content("打开云枢。"));
        assert!(has_voice_command_content("HELLO"));
        assert_eq!(wake_command("小小驼。", "小小驼"), Some(""));
        assert!(!has_voice_command_content(wake_command("小小驼，啊。", "小小驼").unwrap()));
        assert!(has_voice_command_content(wake_command("小小驼，打开云枢。", "小小驼").unwrap()));
    }

    #[test]
    fn wake_phrase_requires_a_match_and_preserves_command_text() {
        assert_eq!(wake_command("小，花。", "小花"), Some(""));
        assert_eq!(wake_command("小花，小花。", "小花"), Some(""));
        assert_eq!(wake_command("小花儿，小花兒。", "小花"), Some(""));
        assert_eq!(wake_command("小花，请打开文件。", "小花"), Some("请打开文件。"));
        assert_eq!(wake_command("Hey PET, show my files", "heypet"), Some("show my files"));
        assert_eq!(wake_command("小心，外面有点吵", "小花"), None);
        assert_eq!(wake_command("你好", ""), None);
        assert_eq!(wake_command("小花。", "小驼，小花"), Some(""));
        assert_eq!(wake_command("小驼，查天气。", "小驼，小花"), Some("查天气。"));
        assert_eq!(wake_command("小驼儿，小花儿。", "小驼，小花"), Some(""));
        assert_eq!(wake_command("小何。", "小驼，小花"), None);
    }

    /// 同音字容错：识别器把"小驼"转成"小坨/小驮"等，拼音一致仍应唤醒；
    /// 连喊后的重复唤醒词不得混入指令文本。
    #[test]
    fn wake_phrase_matches_homophones_and_repeats_without_leaking_into_command() {
        assert_eq!(wake_command("小坨小坨", "小驼"), Some(""));
        assert_eq!(wake_command("小坨，查天气。", "小驼"), Some("查天气。"));
        assert_eq!(wake_command("小驮，开个门。", "小驼"), Some("开个门。"));
        assert_eq!(wake_command("小驼小驼查天气", "小驼"), Some("查天气"));
        assert_eq!(wake_command("小驼儿查天气", "小驼"), Some("儿查天气"));
        assert_eq!(wake_command("小蜜，帮个忙", "小米"), Some("帮个忙"));
        // 拼音不同（tu 与 tuo）不误命中。
        assert_eq!(wake_command("小土，外面有点吵", "小驼"), None);
    }

    fn read_wav_mono16(path: &Path) -> Vec<f32> {
        let bytes = std::fs::read(path).expect("读取测试音频失败");
        let mut index = 12usize;
        while index + 8 <= bytes.len() {
            let id = &bytes[index..index + 4];
            let size = u32::from_le_bytes([bytes[index + 4], bytes[index + 5], bytes[index + 6], bytes[index + 7]]) as usize;
            if id == b"data" {
                return bytes[index + 8..index + 8 + size]
                    .chunks_exact(2)
                    .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
                    .collect();
            }
            index += 8 + size + (size & 1);
        }
        panic!("WAV 无 data 块");
    }

    #[test]
    #[ignore]
    fn transcribe_wake_words() {
        let wav = std::env::temp_dir().join("voice-test3.wav");
        let model = std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap())
            .join("CloudHubTools-Dev").join("voice-models").join("ggml-small.bin");
        let engine = Engine::default();
        let samples = read_wav_mono16(&wav);
        // 与实时管线一致：按块喂入重采样器（16k 设备等于直通）与 VAD，校准期同样丢弃前 3 秒。
        let mut resampler = Resampler::new(16000);
        let mut pending = PendingSegment { calibrating: CALIBRATION_FRAMES, ..Default::default() };
        let mut segments: Vec<(Vec<f32>, f32)> = Vec::new();
        let mut buffer: Vec<f32> = Vec::with_capacity(VAD_FRAME * 4);
        for chunk in samples.chunks(1024) {
            let mut out = Vec::new();
            resampler.push(chunk, &mut out);
            buffer.extend(out);
            while buffer.len() >= VAD_FRAME {
                let frame: Vec<f32> = buffer.drain(..VAD_FRAME).collect();
                if let Some((segment, avg_rms)) = pending.push(&frame) {
                    segments.push((segment, avg_rms));
                }
            }
        }
        println!("管线产出 {} 段", segments.len());
        for (index, (mut segment, avg_rms)) in segments.into_iter().enumerate() {
            let started = Instant::now();
            let text = transcribe_samples(&engine, &model, "zh", &mut segment).unwrap_or_default();
            println!("段{index} len={}ms rms={avg_rms:.4} [耗时{:?}] 命中: {}", segment.len() / 16, started.elapsed(), wake_command(&text, "小驼").is_some());
        }
    }
}

/// whisper 在静音/噪声段上的高频幻觉文本：均为训练数据里的字幕与片尾残留，真实指令不会包含。
const TRANSCRIBE_HALLUCINATIONS: [&str; 8] = ["字幕", "谢谢观看", "謝謝觀看", "订阅", "訂閱", "amara", "thank you for watching", "please subscribe"];

/// 将 16k 单声道采样打包为 16bit 小端原始 PCM（讯飞听写按 raw 编码分帧上传）。
fn pcm16_bytes(samples: &[f32]) -> Vec<u8> {
    let mut pcm = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let quantized = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        pcm.extend_from_slice(&quantized.to_le_bytes());
    }
    pcm
}

/// 将 16k 单声道采样打包为内存 WAV（无临时文件）。
fn wav_bytes(samples: &[f32]) -> Vec<u8> {
    let pcm = pcm16_bytes(samples);
    let data_len = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.extend_from_slice(&(16000u32 * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(&pcm);
    wav
}

/// 读取语音设置所选 AI 配置的凭据（密钥走既有加密存储，保持零化包装不落普通字符串）。
fn cloud_profile_credentials(profile_id: &str) -> Result<(String, impl AsRef<str>), String> {
    let db = crate::core::storage::open_db()?;
    let (profile, key) = crate::core::repositories::ai::load(&db, profile_id).map_err(|_| "AI 配置读取失败".to_string())?;
    Ok((profile.base_url, key))
}

/// 云端语音识别：multipart 上传 + JSON 返回 text（OpenAI /audio/transcriptions 与 MiniMax /v1/speech_to_text 均兼容）。
async fn cloud_transcribe(url: &str, key: impl AsRef<str>, model: &str, wav: &[u8]) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() { return Err("云端识别地址为空".into()); }
    if !url.starts_with("https://") { return Err("云端识别地址必须为 https".into()); }
    if model.trim().is_empty() { return Err("云端识别模型未填写".into()); }
    let boundary = "CloudHubVoiceBoundary7d1a";
    let mut body = Vec::with_capacity(wav.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes());
    body.extend_from_slice(wav);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{}\r\n--{boundary}--\r\n", model.trim()).as_bytes());
    let client = reqwest::Client::new();
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", key.as_ref()))
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .timeout(CLOUD_ASR_TIMEOUT)
        .body(body)
        .send()
        .await
        .map_err(|_| "云端识别请求失败，请检查网络".to_string())?
        .error_for_status()
        .map_err(|error| {
            let code = error.status().map(|status| status.as_str().to_string()).unwrap_or_else(|| "未知".into());
            format!("云端识别返回错误状态：{code}")
        })?;
    let body = response.text().await.map_err(|_| "云端识别响应读取失败".to_string())?;
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "云端识别响应非 JSON".to_string())?;
    // MiniMax 等服务商把业务错误包在 HTTP 200 的 base_resp 里（如密钥无效、欠费），必须显式检查。
    if let Some(base) = json.get("base_resp") {
        let code = base.get("status_code").and_then(|value| value.as_i64()).unwrap_or(0);
        if code != 0 {
            return Err(format!("服务商返回错误 {code}"));
        }
    }
    let text = json.get("text").and_then(|value| value.as_str()).unwrap_or("").trim().to_string();
    // 空文本 = 服务端判定无清晰语音（噪声段），由调用方静默回落本地识别，不算错误。
    Ok(text)
}

/// 讯飞凭据写入：JSON 明文经 encrypt_secret 加密后存 client_preferences，不落明文、不回传前端。
pub fn xfyun_store_credentials(credentials: &super::VoiceXfyunCredentials) -> Result<(), String> {
    let plaintext = serde_json::to_string(credentials).map_err(|_| "讯飞凭据序列化失败".to_string())?;
    let ciphertext = crate::core::crypto::encrypt_secret(&plaintext)?;
    let db = crate::core::storage::open_db()?;
    crate::core::repositories::preferences::save(&db, XFYUN_CREDENTIALS_KEY, &ciphertext, chrono::Utc::now().timestamp_millis())
}

/// 清除已保存的讯飞凭据（设置里三项全部留空保存时触发）。
pub fn xfyun_clear_credentials() -> Result<(), String> {
    let db = crate::core::storage::open_db()?;
    db.execute("DELETE FROM client_preferences WHERE key=?1", [XFYUN_CREDENTIALS_KEY]).map_err(|error| error.to_string())?;
    Ok(())
}

/// 读取讯飞凭据：密文仅在内存解密为三段字符串；未配置返回 None，解密失败提示重新保存而非泄露内容。
fn xfyun_load_credentials() -> Result<Option<(String, String, String)>, String> {
    let db = crate::core::storage::open_db()?;
    let Some(ciphertext) = crate::core::repositories::preferences::list(&db)?
        .get(XFYUN_CREDENTIALS_KEY)
        .filter(|value| !value.trim().is_empty())
        .cloned()
    else {
        return Ok(None);
    };
    let plaintext = crate::core::crypto::decrypt_secret(&ciphertext).map_err(|_| "讯飞凭据解密失败，请在语音设置中重新保存".to_string())?;
    let credentials: super::VoiceXfyunCredentials = serde_json::from_str(&plaintext).map_err(|_| "讯飞凭据数据无效，请在语音设置中重新保存".to_string())?;
    Ok(Some((credentials.app_id, credentials.api_key, credentials.api_secret)))
}

/// 状态展示用：讯飞凭据是否已配置（仅布尔状态）。
fn xfyun_configured() -> bool {
    matches!(xfyun_load_credentials(), Ok(Some(_)))
}

/// 按官方契约构造讯飞握手 URL：host/date/request-line 拼串 → HMAC-SHA256 → base64 鉴权参数。
/// date 由调用方传入（RFC1123 GMT），保证签名与请求时间一致；异常密钥长度在 HMAC 中不存在失败路径。
fn xfyun_handshake_url(api_key: &str, api_secret: &str, date: &str) -> String {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use hmac::Mac;
    /// 查询串编码：字母数字与 -_.~ 保留，空格/逗号/冒号/加号/斜杠等按 RFC3986 编码，与官方示例 urlencode 行为一致。
    const QUERY_ENCODE: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
        .add(b' ').add(b'"').add(b',').add(b':').add(b';').add(b'=').add(b'+').add(b'/').add(b'?').add(b'&').add(b'#').add(b'%');
    let signature_origin = format!("host: {XFYUN_IAT_HOST}\ndate: {date}\nGET {XFYUN_IAT_PATH} HTTP/1.1");
    let mut signer = hmac::Hmac::<sha2::Sha256>::new_from_slice(api_secret.as_bytes()).expect("HMAC 接受任意长度密钥");
    signer.update(signature_origin.as_bytes());
    let signature = BASE64.encode(signer.finalize().into_bytes());
    let authorization = BASE64.encode(format!("api_key=\"{api_key}\", algorithm=\"hmac-sha256\", headers=\"host date request-line\", signature=\"{signature}\""));
    format!(
        "wss://{XFYUN_IAT_HOST}{XFYUN_IAT_PATH}?authorization={}&date={}&host={}",
        percent_encoding::utf8_percent_encode(&authorization, QUERY_ENCODE),
        percent_encoding::utf8_percent_encode(date, QUERY_ENCODE),
        percent_encoding::utf8_percent_encode(XFYUN_IAT_HOST, QUERY_ENCODE),
    )
}

/// 讯飞语音听写（流式版）：签名握手 → 分帧上传 PCM → 拼接 data.result.ws[].cw[].w。
/// 连接失败不透出原始错误（握手 URL 含凭据派生参数），仅提示检查网络、凭据与系统时间。
async fn xfyun_iat_transcribe(app_id: &str, api_key: &str, api_secret: &str, language: &str, pcm: &[u8]) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    if app_id.is_empty() || api_key.is_empty() || api_secret.is_empty() { return Err("讯飞凭据未配置完整".into()); }
    if pcm.is_empty() { return Err("无有效语音片段".into()); }
    // 讯飞单次会话最长 60 秒：超长片段直接报错回落本地识别，避免截断丢句。
    if pcm.len() > 60 * SAMPLE_RATE * 2 { return Err("语音片段超过讯飞单次 60 秒上限".into()); }
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let (websocket, _) = tokio_tungstenite::connect_async(xfyun_handshake_url(api_key, api_secret, &date)).await
        .map_err(|_| "讯飞语音听写连接失败：请检查网络、讯飞凭据与本机系统时间".to_string())?;
    let (mut sink, mut stream) = websocket.split();
    // 听写无自动语种检测：跟随语音设置映射，zh/auto 走中英混合，en 走英文。
    let (language, accent) = match language.trim() {
        "en" => ("en_us", ""),
        _ => ("zh_cn", "mandarin"),
    };
    let business = if accent.is_empty() {
        serde_json::json!({ "language": language, "domain": "iat" })
    } else {
        serde_json::json!({ "language": language, "domain": "iat", "accent": accent })
    };
    let send_all = async {
        for (index, chunk) in pcm.chunks(XFYUN_FRAME_BYTES).enumerate() {
            if index > 0 { tokio::time::sleep(XFYUN_FRAME_INTERVAL).await; }
            let mut frame = serde_json::Map::new();
            if index == 0 {
                frame.insert("common".into(), serde_json::json!({ "app_id": app_id }));
                frame.insert("business".into(), business.clone());
            }
            frame.insert("data".into(), serde_json::json!({
                "status": if index == 0 { 0 } else { 1 },
                "format": "audio/L16;rate=16000",
                "encoding": "raw",
                "audio": BASE64.encode(chunk),
            }));
            let payload = serde_json::to_string(&frame).map_err(|_| "讯飞请求帧编码失败".to_string())?;
            sink.send(Message::text(payload)).await.map_err(|_| "讯飞语音听写发送中断".to_string())?;
        }
        sink.send(Message::text("{\"data\":{\"status\":2}}")).await.map_err(|_| "讯飞语音听写发送中断".to_string())?;
        // 不能在发送结束帧后立即关闭：讯飞收到 status=2 才开始发最终结果帧，过早的关闭握手会掐断结果
        // （实测表现为空文本）。读取侧收到 status=2 即返回，连接随函数结束丢弃，由服务端自行清理。
        Ok::<(), String>(())
    };
    let read_all = async {
        let mut transcript = String::new();
        while let Some(message) = stream.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    let json: serde_json::Value = serde_json::from_str(text.as_str())
                        .map_err(|_| "讯飞响应非 JSON".to_string())?;
                    let code = json.get("code").and_then(|value| value.as_i64()).unwrap_or(-1);
                    if code != 0 {
                        return Err(format!("讯飞语音听写返回错误 {code}"));
                    }
                    if let Some(characters) = json.pointer("/data/result/ws").and_then(|value| value.as_array()) {
                        for word in characters {
                            if let Some(characters) = word.get("cw").and_then(|value| value.as_array()) {
                                for character in characters {
                                    transcript.push_str(character.get("w").and_then(|value| value.as_str()).unwrap_or(""));
                                }
                            }
                        }
                    }
                    if json.pointer("/data/status").and_then(|value| value.as_i64()) == Some(2) { break; }
                }
                Ok(_) => {}
                Err(_) => return Err("讯飞语音听写连接中断".to_string()),
            }
        }
        Ok::<String, String>(transcript)
    };
    let (transcript, _) = tokio::time::timeout(XFYUN_SESSION_TIMEOUT, async { tokio::join!(read_all, send_all) })
        .await
        .map_err(|_| "讯飞语音听写会话超时".to_string())?;
    let transcript = transcript?;
    // 空结果 = 讯飞判定无清晰语音（噪声段），由调用方静默回落本地识别，不算错误。
    Ok(transcript.trim().to_string())
}

/// 云端识别走语音设置所选 AI 配置；凭据仅在内存中解密使用，音频不落盘。
fn cloud_segment_transcript(settings: &super::Settings, samples: &mut [f32]) -> Result<String, String> {
    let profile_id = settings.voice.cloud_profile_id.trim();
    if profile_id.is_empty() { return Err("未选择云端识别的 AI 配置".into()); }
    let (base_url, key) = cloud_profile_credentials(profile_id)?;
    if key.as_ref().is_empty() { return Err("AI 配置缺少密钥".into()); }
    // 转写地址：填了自定义地址直接用（如 MiniMax 的 /v1/speech_to_text）；留空走 OpenAI 风格 {服务地址}/audio/transcriptions。
    let url = match settings.voice.cloud_endpoint.trim() {
        "" => format!("{}/audio/transcriptions", base_url.trim().trim_end_matches('/')),
        endpoint => endpoint.to_string(),
    };
    normalize_peaks(samples);
    let wav = wav_bytes(samples);
    tauri::async_runtime::block_on(cloud_transcribe(&url, &key, &settings.voice.cloud_model, &wav))
}

/// 讯飞听写走独立加密凭据；音频以 16k 原始 PCM 分帧上传，失败回落本地识别。
fn cloud_segment_transcript_xfyun(settings: &super::Settings, samples: &mut [f32]) -> Result<String, String> {
    let Some((app_id, api_key, api_secret)) = xfyun_load_credentials()? else {
        return Err("讯飞语音听写凭据未配置，请在语音设置中填写".into());
    };
    normalize_peaks(samples);
    let pcm = pcm16_bytes(samples);
    tauri::async_runtime::block_on(xfyun_iat_transcribe(&app_id, &api_key, &api_secret, &settings.voice.language, &pcm))
}

/// 单段音频转写：开启云端识别时优先上传所选服务商（OpenAI 兼容接口或讯飞听写），失败自动回落本地 whisper。
fn segment_transcript(app: &AppHandle, engine: &Arc<Engine>, settings: &super::Settings, len_ms: usize, samples: &mut [f32]) -> Result<String, String> {
    if settings.voice.cloud_asr_enabled {
        // 退避期内跳过云端：连续多段空结果说明环境噪声反复触发，直接走本地识别不排队云端。
        let skipped = engine.cloud_skip_until.lock().is_ok_and(|until| until.is_some_and(|deadline| Instant::now() < deadline));
        // openai 兼容路径沿用旧行为：未选择 AI 配置时静默走本地；讯飞路径未配置凭据时报错提示。
        let cloud = if skipped {
            None
        } else {
            match settings.voice.cloud_provider.as_str() {
                "xfyun" => Some(cloud_segment_transcript_xfyun(settings, samples)),
                _ if !settings.voice.cloud_profile_id.trim().is_empty() => Some(cloud_segment_transcript(settings, samples)),
                _ => None,
            }
        };
        match cloud {
            Some(Ok(text)) if !text.trim().is_empty() => {
                engine.cloud_empty_streak.store(0, Ordering::Relaxed);
                if let Ok(mut until) = engine.cloud_skip_until.lock() { *until = None; }
                log_event(&format!("segment {len_ms}ms cloud transcribed"));
                return Ok(text);
            }
            // 云端判定无清晰语音（噪声段）：静默回落本地识别，不弹错误提示，避免环境噪声反复打扰。
            Some(Ok(_)) => {
                let streak = engine.cloud_empty_streak.fetch_add(1, Ordering::Relaxed) + 1;
                if streak >= CLOUD_EMPTY_BACKOFF_AFTER {
                    engine.cloud_empty_streak.store(0, Ordering::Relaxed);
                    if let Ok(mut until) = engine.cloud_skip_until.lock() { *until = Some(Instant::now() + CLOUD_EMPTY_BACKOFF); }
                    log_event(&format!("cloud asr backoff {CLOUD_EMPTY_BACKOFF:?} after {streak} empty"));
                }
                log_event(&format!("segment {len_ms}ms cloud empty"));
            }
            Some(Err(error)) => {
                engine.cloud_empty_streak.store(0, Ordering::Relaxed);
                log_event(&format!("segment {len_ms}ms cloud error: {error}"));
                let _ = app.emit("pet-voice-error", VoiceError { message: format!("云端识别失败，已回落本地识别：{error}") });
            }
            None => {}
        }
    }
    let (model, _) = resolve_model(settings)?;
    let text = transcribe_samples(engine, &model, &settings.voice.language, samples);
    // 本地识别出有效内容时结束退避，后续段落恢复云端优先。
    if text.as_ref().is_ok_and(|text| !text.trim().is_empty()) {
        engine.cloud_empty_streak.store(0, Ordering::Relaxed);
        if let Ok(mut until) = engine.cloud_skip_until.lock() { *until = None; }
    }
    text
}

/// 单段语音的处理结果：Noise 表示该段被判定为环境噪声（调用方据此抬升噪声底）。
enum SegmentOutcome { Speech, Noise }

fn set_wake_result(engine: &Engine, result: WakeResult) {
    if let Ok(mut last) = engine.last_result.lock() {
        *last = Some(result);
    }
}

/// 归一化后匹配唤醒词；指令取唤醒词之后的剩余文本。
/// 未命中的段落经 pet-voice-heard 上报（仅内存与界面展示，不写日志），便于排查唤醒词选词。
fn handle_segment(app: &AppHandle, engine: &Arc<Engine>, generation: u64, settings: &super::Settings, heard_at: Instant, samples: &mut [f32]) -> SegmentOutcome {
    let current_session = || {
        engine.generation.load(Ordering::SeqCst) == generation
            && !engine.manual_active.load(Ordering::SeqCst)
            && !capturing_playback(engine)
            && read_settings().is_ok_and(|current| current.voice == settings.voice)
    };
    {
        let Ok(_lifecycle) = engine.listener_lifecycle.lock() else { return SegmentOutcome::Speech };
        if !current_session() { return SegmentOutcome::Speech; }
        engine.segments.fetch_add(1, Ordering::SeqCst);
        set_wake_result(engine, WakeResult::Transcribing);
    }
    let len_ms = samples.len() / 16;
    // 拾音诊断：记录原始电平（峰值/RMS），判断唤醒失败是否源于音量过低或环境噪声过高。
    let raw_peak = samples.iter().fold(0.0f32, |max, sample| max.max(sample.abs()));
    let raw_rms = if samples.is_empty() { 0.0 } else { (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt() };
    log_event(&format!("segment {len_ms}ms raw peak={raw_peak:.3} rms={raw_rms:.4}"));
    let started = Instant::now();
    let record = |status: &str, detail: Option<&str>| super::activity::record(app, super::activity::Kind::Voice, started, "常驻监听", status, detail);
    let transcription = {
        let _activity = VoiceActivity::start(app, "pet-voice-recognizing", generation);
        segment_transcript(app, engine, settings, len_ms, samples)
    };
    let Ok(_lifecycle) = engine.listener_lifecycle.lock() else { return SegmentOutcome::Speech };
    if !current_session() { return SegmentOutcome::Speech; }
    let transcript = match transcription {
        Ok(text) => text,
        Err(error) => {
            record("识别失败", None);
            set_wake_result(engine, WakeResult::Failed);
            log_event(&format!("segment {len_ms}ms transcribe error: {error}"));
            let _ = app.emit("pet-voice-error", VoiceError { message: error });
            return SegmentOutcome::Speech;
        }
    };
    if transcript.trim().is_empty() {
        record("未识别", None);
        log_event(&format!("segment {len_ms}ms empty transcript"));
        set_wake_result(engine, WakeResult::Unclear);
        let _ = app.emit("pet-voice-error", VoiceError { message: "未识别到清晰语音，请靠近麦克风再试".into() });
        return SegmentOutcome::Noise;
    }
    let lowered = transcript.trim().to_lowercase();
    if TRANSCRIBE_HALLUCINATIONS.iter().any(|pattern| lowered.contains(pattern)) {
        record("已过滤", None);
        log_event(&format!("segment {len_ms}ms hallucination dropped"));
        set_wake_result(engine, WakeResult::Unclear);
        return SegmentOutcome::Noise;
    }
    let after_wake = wake_command(&transcript, &settings.voice.wake_word);
    if after_wake.is_none() && !has_voice_command_content(&transcript) {
        record("文字过短", Some(&transcript));
        log_event(&format!("segment {len_ms}ms filtered (short transcript)"));
        set_wake_result(engine, WakeResult::Unclear);
        return if transcript.chars().any(char::is_alphanumeric) { SegmentOutcome::Speech } else { SegmentOutcome::Noise };
    }
    let Ok(mut conversation) = engine.conversation.lock() else { return SegmentOutcome::Speech };
    let now = Instant::now();
    let next_window = Some(now + WAKE_COMMAND_WINDOW);
    match after_wake {
        Some(rest) if has_voice_command_content(rest) => {
            record("唤醒并识别指令", Some(&transcript));
            engine.matched.fetch_add(1, Ordering::SeqCst);
            set_wake_result(engine, WakeResult::Command);
            log_event(&format!("segment {len_ms}ms MATCHED (command dispatched)"));
            let command_id = conversation.advance(next_window);
            #[cfg(windows)]
            acknowledge_wake(app, engine, settings, true);
            let _ = app.emit("pet-voice-command", VoiceCommand { text: rest.to_string(), woke: true, command_id });
            SegmentOutcome::Speech
        }
        Some(_) => {
            record("已唤醒", Some(&transcript));
            engine.matched.fetch_add(1, Ordering::SeqCst);
            set_wake_result(engine, WakeResult::Awakened);
            log_event(&format!("segment {len_ms}ms MATCHED (awake)"));
            conversation.advance(next_window);
            #[cfg(windows)]
            acknowledge_wake(app, engine, settings, false);
            let _ = app.emit("pet-voice-awake", ());
            SegmentOutcome::Speech
        }
        None => {
            if conversation.accepts_follow_up(heard_at) {
                record("识别到追问", Some(&transcript));
                engine.matched.fetch_add(1, Ordering::SeqCst);
                set_wake_result(engine, WakeResult::Command);
                log_event(&format!("segment {len_ms}ms MATCHED (follow-up command)"));
                let command_id = conversation.advance(next_window);
                let _ = app.emit("pet-voice-command", VoiceCommand { text: transcript.trim().to_string(), woke: false, command_id });
                return SegmentOutcome::Speech;
            }
            let heard = transcript.trim().to_string();
            if !heard.is_empty() {
                record("未命中唤醒词", Some(&transcript));
                log_event(&format!("segment {len_ms}ms heard"));
                set_wake_result(engine, WakeResult::Unmatched);
                let _ = app.emit("pet-voice-heard", VoiceHeard { text: heard });
            }
            SegmentOutcome::Speech
        }
    }
}
