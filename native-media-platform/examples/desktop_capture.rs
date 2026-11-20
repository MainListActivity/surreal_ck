//! 手动硬件验收入口。仅用户显式指定设备/区域后采集；不保存或发送内容。
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use std::time::Duration;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use surreal_ck_native_media_platform::desktop::{
    Capture, CaptureInput, Encoded, VideoConfig, VideoDecoder,
};

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("--capture-selected-device") {
        return Err("需要显式操作：--capture-selected-device <mac-video|mac-audio|windows-video|windows-audio|windows-screen> <设备索引/名称或区域x> [区域y]；采集约3秒，不保存或发送".into());
    }
    let kind = args.get(1).ok_or("缺少后端")?;
    let selected = args.get(2).ok_or("缺少所选设备或区域")?;
    let video = VideoConfig {
        width: 640,
        height: 480,
        fps: 15,
    };
    let input = match kind.as_str() {
        "mac-video" => CaptureInput::MacVideo {
            device_index: selected.parse()?,
            video,
        },
        "mac-audio" => CaptureInput::MacMicrophone {
            device_index: selected.parse()?,
        },
        "windows-video" => CaptureInput::WindowsCamera {
            device: selected.clone(),
            video,
        },
        "windows-audio" => CaptureInput::WindowsMicrophone {
            device: selected.clone(),
        },
        "windows-screen" => CaptureInput::WindowsScreen {
            x: selected.parse()?,
            y: args.get(3).ok_or("缺少区域 y")?.parse()?,
            video,
        },
        _ => return Err("未知后端".into()),
    };
    let mut capture = Capture::start(input)?;
    let mut decoder = if kind.ends_with("video") || kind.ends_with("screen") {
        Some(VideoDecoder::new(video).await?)
    } else {
        None
    };
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let count = if decoder.is_some() { 45 } else { 150 };
        for _ in 0..count {
            match capture.next().await? {
                Encoded::Video { data, .. } => {
                    let decoder = decoder.as_mut().expect("video decoder");
                    let pixels = decoder.decode_rgba(&data).await?;
                    if pixels.len() != 640 * 480 * 4 {
                        return Err("RGBA 帧尺寸不匹配".into());
                    }
                }
                Encoded::Audio { data, .. } => {
                    if data.is_empty() {
                        return Err("空音频包".into());
                    }
                }
            }
        }
        Ok::<_, Box<dyn std::error::Error>>(count)
    })
    .await;
    let stopped = capture.stop().await;
    if let Some(decoder) = &mut decoder {
        decoder.stop().await?;
    }
    stopped?;
    println!(
        "完成 {} 帧/包；设备采集已停止。本测试不证明 UI 渲染、扬声器播放或两机通话。",
        result??
    );
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn main() {
    eprintln!("此手动采集示例仅支持桌面系统");
    std::process::exit(1);
}
