use super::{Engine, Ordering};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::{
    sync::{mpsc, OnceLock},
    time::{Duration, Instant},
};

const MAX_RESPONSE: usize = 16 * 1024 * 1024;
const PROFILE_ERROR: &str = "请在播报音色中选择有效的小米 MiMo AI 配置";
const AUDIO_ERROR: &str = "小米 MiMo 返回的音频无效";
const OUTPUT_ERROR: &str = "无法播放小米 MiMo 音频，请检查系统播放设备";

fn endpoint(base: &str) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(base).ok()?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(
            url.host_str()?,
            "api.xiaomimimo.com"
                | "token-plan-cn.xiaomimimo.com"
                | "token-plan-sgp.xiaomimimo.com"
                | "token-plan-ams.xiaomimimo.com"
        )
    {
        return None;
    }
    url.set_path("/v1/chat/completions");
    Some(url)
}

pub(in crate::commands::desktop_pet) fn profile_available(
    profile: &crate::core::repositories::ai::Profile,
) -> bool {
    profile.enabled && profile.has_key && endpoint(&profile.base_url).is_some()
}

pub(super) async fn synthesize(
    profile_id: &str,
    voice: &str,
    text: &str,
) -> Result<PcmVoice, String> {
    let safe =
        crate::core::ai::preview(text).map_err(|error| format!("已跳过小米 MiMo 合成：{error}"))?;
    if safe.removed_lines > 0 {
        return Err("播报文本含疑似凭据，已跳过云端合成".into());
    }
    let (url, key) = {
        let mut db = crate::core::storage::open_db().map_err(|_| PROFILE_ERROR.to_string())?;
        let snapshot = db.transaction().map_err(|_| PROFILE_ERROR.to_string())?;
        let (profile, key) = crate::core::repositories::ai::load(&snapshot, profile_id)
            .map_err(|_| PROFILE_ERROR.to_string())?;
        if key.is_empty() {
            return Err(PROFILE_ERROR.into());
        }
        (endpoint(&profile.base_url).ok_or(PROFILE_ERROR)?, key)
    };
    if text.contains(key.as_str()) {
        return Err("播报文本含已配置的凭据，已跳过云端合成".into());
    }
    static CLIENT: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(4))
                .timeout(Duration::from_secs(12))
                .build()
        })
        .as_ref()
        .map_err(|_| "小米 MiMo 网络客户端不可用")?;
    let mut response = client
        .post(url)
        .bearer_auth(key.as_str())
        .json(&request_body(voice, text))
        .send()
        .await
        .map_err(|_| "无法连接小米 MiMo，请检查网络后重试")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "小米 MiMo 拒绝请求，请检查 API Key 和账户权限",
            402 => "小米 MiMo 账户额度不足，请检查账户",
            429 => "小米 MiMo 请求过于频繁，请稍后重试",
            _ => "小米 MiMo 合成失败，请稍后重试",
        }
        .into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取小米 MiMo 音频失败")?
    {
        if chunk.len() > MAX_RESPONSE - body.len() {
            return Err("小米 MiMo 返回的音频过长".into());
        }
        body.extend_from_slice(&chunk);
    }
    parse_response(&body).ok_or_else(|| AUDIO_ERROR.into())
}

fn request_body(voice: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "model": "mimo-v2.5-tts",
        "messages": [{"role": "assistant", "content": text}],
        "audio": {"format": "wav", "voice": voice},
        "stream": false,
    })
}

pub(super) struct PcmVoice {
    samples: Vec<i16>,
    sample_rate: u32,
}

fn parse_response(body: &[u8]) -> Option<PcmVoice> {
    let response: serde_json::Value = serde_json::from_slice(body).ok()?;
    let data = response
        .pointer("/choices/0/message/audio/data")?
        .as_str()?;
    parse_wave(&STANDARD.decode(data).ok()?)
}

fn parse_wave(wave: &[u8]) -> Option<PcmVoice> {
    if wave.get(..4)? != b"RIFF" || wave.get(8..12)? != b"WAVE" {
        return None;
    }
    let mut cursor = 12usize;
    let mut format = None;
    let mut data = None;
    while let Some(chunk) = wave.get(cursor..cursor + 8) {
        let size = u32::from_le_bytes(chunk[4..8].try_into().ok()?) as usize;
        let start = cursor + 8;
        let end = start.checked_add(size)?;
        let bytes = wave.get(start..end)?;
        match &chunk[..4] {
            b"fmt " if size >= 16 => format = Some(bytes),
            b"data" => data = Some(bytes),
            _ => {}
        }
        if format.is_some() && data.is_some() {
            break;
        }
        cursor = end.checked_add(size & 1)?;
    }
    let format = format?;
    let sample_rate = u32::from_le_bytes(format[4..8].try_into().ok()?);
    let data = data?;
    if format[..4] != [1, 0, 1, 0]
        || format[14..16] != [16, 0]
        || !(8000..=96000).contains(&sample_rate)
        || data.is_empty()
        || data.len() % 2 != 0
        || data.len() / 2 > sample_rate as usize * 180
    {
        return None;
    }
    let samples = data
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    Some(PcmVoice {
        samples,
        sample_rate,
    })
}

pub(super) fn play(engine: &Engine, generation: u64, audio: PcmVoice) -> Result<(), String> {
    let _lock = engine.speech_lock.lock().map_err(|_| OUTPUT_ERROR)?;
    if engine.speech_generation.load(Ordering::SeqCst) != generation {
        return Ok(());
    }
    let device = cpal::default_host()
        .default_output_device()
        .ok_or(OUTPUT_ERROR)?;
    let config = device.default_output_config().map_err(|_| OUTPUT_ERROR)?;
    let (tx, rx) = mpsc::sync_channel(2);
    let deadline = Instant::now()
        + Duration::from_secs_f64(audio.samples.len() as f64 / audio.sample_rate as f64 + 5.0);
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => output_stream::<f32>(&device, config.config(), audio, tx),
        cpal::SampleFormat::I16 => output_stream::<i16>(&device, config.config(), audio, tx),
        cpal::SampleFormat::U16 => output_stream::<u16>(&device, config.config(), audio, tx),
        cpal::SampleFormat::I32 => output_stream::<i32>(&device, config.config(), audio, tx),
        _ => return Err(OUTPUT_ERROR.into()),
    }
    .map_err(|_| OUTPUT_ERROR)?;
    stream.play().map_err(|_| OUTPUT_ERROR)?;
    let mut drain_until = None;
    let result = loop {
        if engine.speech_generation.load(Ordering::SeqCst) != generation
            || drain_until.is_some_and(|until| Instant::now() >= until)
        {
            break Ok(());
        }
        if Instant::now() >= deadline {
            break Err(OUTPUT_ERROR.into());
        }
        match rx.recv_timeout(Duration::from_millis(25)) {
            Ok(Ok(delay)) => drain_until = Some(Instant::now() + delay),
            Ok(Err(())) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err(OUTPUT_ERROR.into())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    };
    drop(stream);
    if let Ok(mut tail) = engine.speech_tail.lock() {
        *tail = Some(Instant::now() + Duration::from_millis(350));
    }
    result
}

fn output_stream<T: cpal::SizedSample + cpal::FromSample<f32>>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    audio: PcmVoice,
    tx: mpsc::SyncSender<Result<Duration, ()>>,
) -> Result<cpal::Stream, cpal::BuildStreamError> {
    let channels = usize::from(config.channels);
    let step = f64::from(audio.sample_rate) / f64::from(config.sample_rate.0);
    let mut position = 0.0_f64;
    let mut drained = false;
    let errors = tx.clone();
    device.build_output_stream(
        &config,
        move |output: &mut [T], info| {
            let timestamp = info.timestamp();
            if !drained && position >= audio.samples.len() as f64 {
                drained = true;
                let delay = timestamp
                    .playback
                    .duration_since(&timestamp.callback)
                    .unwrap_or_default();
                let _ = tx.try_send(Ok(delay + Duration::from_millis(20)));
            }
            for frame in output.chunks_mut(channels) {
                let index = position as usize;
                let sample = match audio.samples.get(index) {
                    Some(&current) => {
                        let next = audio.samples.get(index + 1).copied().unwrap_or(current);
                        let fraction = (position - index as f64) as f32;
                        position += step;
                        (f32::from(current) + (f32::from(next) - f32::from(current)) * fraction)
                            / 32768.0
                    }
                    None => 0.0,
                };
                frame.fill(T::from_sample_(sample));
            }
        },
        move |_| {
            let _ = errors.try_send(Err(()));
        },
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mimo_routes_to_official_origin() {
        assert_eq!(
            endpoint("https://api.xiaomimimo.com/anthropic")
                .unwrap()
                .as_str(),
            "https://api.xiaomimimo.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://token-plan-cn.xiaomimimo.com/v1")
                .unwrap()
                .as_str(),
            "https://token-plan-cn.xiaomimimo.com/v1/chat/completions"
        );
        for url in [
            "http://api.xiaomimimo.com/v1",
            "https://api.xiaomimimo.com.example.test/v1",
            "https://api.xiaomimimo.com:8443/v1",
            "https://user@api.xiaomimimo.com/v1",
            "https://api.xiaomimimo.com/v1?key=value",
        ] {
            assert!(endpoint(url).is_none());
        }
    }

    #[test]
    fn mimo_uses_stock_voice_and_validates_audio() {
        let request = request_body("茉莉", "我在。");
        assert_eq!(request["model"], "mimo-v2.5-tts");
        assert_eq!(request["audio"]["voice"], "茉莉");
        assert_eq!(request["messages"][0]["role"], "assistant");
        assert_eq!(request["messages"][0]["content"], "我在。");
        let wave = super::super::wav_bytes(&[0.25, -0.25, 0.0]);
        let response = |bytes: &[u8]| {
            serde_json::json!({"choices": [{"message": {"audio": {"data": STANDARD.encode(bytes)}}}]}).to_string()
        };
        let audio = parse_response(response(&wave).as_bytes()).unwrap();
        assert_eq!(audio.sample_rate, 16_000);
        assert_eq!(audio.samples.len(), 3);
        assert!(parse_response(response(&wave[..wave.len() - 1]).as_bytes()).is_none());
        assert!(parse_response(br#"{"choices":[]}"#).is_none());
    }
}
