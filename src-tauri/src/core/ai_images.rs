use base64::{engine::general_purpose::STANDARD as B64, Engine};
use image::{ImageFormat, ImageReader, Rgb, RgbImage};
use serde::Deserialize;
use std::io::Cursor;
use std::io::Read;

pub fn read_source_file(source_path: &str) -> Result<String, String> {
    let path = std::path::Path::new(source_path);
    if !path.is_absolute() { return Err("请选择本机图片文件".into()); }
    let file = std::fs::File::open(path).map_err(|_| "无法读取图片文件")?;
    let metadata = file.metadata().map_err(|_| "无法读取图片文件")?;
    if !metadata.is_file() { return Err("请选择PNG或JPEG图片文件".into()); }
    if metadata.len() > 12 * 1024 * 1024 { return Err("原图超过12MB，请先缩小".into()); }
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    file.take(12 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "读取图片失败")?;
    if bytes.len() > 12 * 1024 * 1024 { return Err("原图超过12MB，请先缩小".into()); }
    let reader = ImageReader::new(Cursor::new(bytes.as_slice())).with_guessed_format().map_err(|_| "图片格式无效")?;
    let mime = match reader.format() {
        Some(ImageFormat::Png) => "image/png",
        Some(ImageFormat::Jpeg) => "image/jpeg",
        _ => return Err("请使用有效的PNG或JPEG截图".into()),
    };
    let (width, height) = reader.into_dimensions().map_err(|_| "图片尺寸无效")?;
    if width == 0 || height == 0 || width > 12000 || height > 12000 || u64::from(width) * u64::from(height) > 20_000_000 {
        return Err("原图尺寸过大，请先缩小".into());
    }
    Ok(format!("data:{mime};base64,{}", B64.encode(bytes.as_slice())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageInput {
    pub data_url: String,
    pub reviewed: bool,
}
pub struct NormalizedImage {
    pub data_url: String,
    pub base64: String,
    pub mime: &'static str,
}

pub fn normalize(data_url: &str) -> Result<NormalizedImage, String> {
    if data_url.len() > 2_800_000 {
        return Err("截图超过大小限制，请裁剪后重试".into());
    }
    let (kind, encoded) = data_url
        .split_once(',')
        .ok_or("截图格式无效，请使用PNG或JPEG图片")?;
    let expected = match kind {
        "data:image/png;base64" => ImageFormat::Png,
        "data:image/jpeg;base64" => ImageFormat::Jpeg,
        "data:image/webp;base64" => ImageFormat::WebP,
        _ => return Err("截图格式无效，请使用PNG或JPEG图片".into()),
    };
    let bytes = B64.decode(encoded).map_err(|_| "截图数据无效")?;
    if bytes.len() > 2_097_152 {
        return Err("截图超过大小限制，请裁剪后重试".into());
    }
    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| "截图数据无效")?;
    if reader.format() != Some(expected) {
        return Err("截图格式与实际内容不一致".into());
    }
    let (width, height) = reader.into_dimensions().map_err(|_| "截图尺寸无效")?;
    if width == 0 || height == 0 || width > 1600 || height > 1600 {
        return Err("截图尺寸须在1600像素以内，请裁剪或缩小".into());
    }
    let mut reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| "截图数据无效")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(1600);
    limits.max_image_height = Some(1600);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    let rgba = reader.decode().map_err(|_| "无法解码截图")?.to_rgba8();
    // Render visible pixels against white before re-encoding; strip metadata and hidden alpha RGB.
    let rgb = RgbImage::from_fn(width, height, |x, y| {
        let pixel = rgba.get_pixel(x, y);
        let a = pixel[3] as u32;
        Rgb([0, 1, 2].map(|index| ((pixel[index] as u32 * a + 255 * (255 - a)) / 255) as u8))
    });
    let grey = image::DynamicImage::ImageRgb8(rgb.clone()).to_luma8();
    let mut prepared = rqrr::PreparedImage::prepare(grey);
    if prepared
        .detect_grids()
        .iter()
        .any(|grid| grid.decode().is_ok())
    {
        return Err("截图包含二维码，请裁剪或遮挡后重试".into());
    }
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 85)
        .encode_image(&image::DynamicImage::ImageRgb8(rgb))
        .map_err(|_| "处理截图失败")?;
    let base64 = B64.encode(encoded);
    Ok(NormalizedImage {
        data_url: format!("data:image/jpeg;base64,{base64}"),
        base64,
        mime: "image/jpeg",
    })
}

pub fn challenge() -> Result<(NormalizedImage, String), String> {
    let mut bits = rand::random::<u8>();
    if bits == 0 || bits == 255 {
        bits ^= 0b01010101;
    }
    let colors = (0..8)
        .map(|index| {
            if bits & (1 << index) != 0 {
                "red"
            } else {
                "blue"
            }
        })
        .collect::<Vec<_>>();
    let image = RgbImage::from_fn(256, 48, |x, y| {
        let index = (x / 32) as usize;
        if x % 32 < 3 || x % 32 >= 29 || y < 6 || y >= 42 {
            Rgb([255, 255, 255])
        } else if colors[index] == "red" {
            Rgb([245, 20, 20])
        } else {
            Rgb([20, 20, 245])
        }
    });
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|_| "生成图像测试失败")?;
    Ok((
        normalize(&format!(
            "data:image/png;base64,{}",
            B64.encode(bytes.into_inner())
        ))?,
        colors.join(","),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dropped_image_files_are_bounded_and_validated_without_exposing_paths() {
        let path=std::env::temp_dir().join(format!("ai-image-test-{}.png",uuid::Uuid::new_v4()));
        let image=RgbImage::new(100,80);
        let mut bytes=Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image).write_to(&mut bytes,ImageFormat::Png).unwrap();
        std::fs::write(&path,bytes.into_inner()).unwrap();
        let url=read_source_file(path.to_str().unwrap()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        std::fs::write(&path,b"test-only-private-not-an-image").unwrap();
        let error=read_source_file(path.to_str().unwrap()).unwrap_err();
        assert!(!error.contains("private"));assert!(!error.contains(path.to_str().unwrap()));
        let file=std::fs::File::create(&path).unwrap();file.set_len(12*1024*1024+1).unwrap();drop(file);
        assert!(read_source_file(path.to_str().unwrap()).unwrap_err().contains("12MB"));
        std::fs::remove_file(path).unwrap();
        assert!(read_source_file("relative.png").is_err());
        assert!(read_source_file(std::env::temp_dir().to_str().unwrap()).is_err());
    }
    #[test]
    fn readable_qr_is_blocked_before_image_can_leave_the_device() {
        // Generated by the existing qrcode.react package; payload contains no credentials.
        let rows: Vec<String> =
            serde_json::from_str(include_str!("fixtures/ai-test-only-qr.json")).unwrap();
        let side = rows.len() as u32;
        let image = RgbImage::from_fn(side * 8, side * 8, |x, y| {
            if rows[(y / 8) as usize].as_bytes()[(x / 8) as usize] == b'1' {
                Rgb([0, 0, 0])
            } else {
                Rgb([255, 255, 255])
            }
        });
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let uri = format!("data:image/png;base64,{}", B64.encode(bytes.into_inner()));
        let error = normalize(&uri).err().expect("readable QR must be blocked");
        assert!(error.contains("二维码"));
    }
    #[test]
    fn rejects_remote_urls_bad_headers_and_large_dimensions() {
        assert!(normalize("https://example.test/image.png").is_err());
        assert!(normalize("data:image/png;base64,not-base64").is_err());
        let image = RgbImage::new(1601, 1);
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let uri = format!("data:image/png;base64,{}", B64.encode(bytes.into_inner()));
        assert!(normalize(&uri).is_err());
    }
    #[test]
    fn synthetic_challenge_is_bounded_and_does_not_disclose_the_answer_in_metadata() {
        let (image, answer) = challenge().unwrap();
        assert!(image.data_url.starts_with("data:image/jpeg;base64,"));
        assert!(image.base64.len() < 100_000);
        assert_eq!(answer.split(',').count(), 8);
        assert!(answer.contains("red") && answer.contains("blue"));
    }
}
