//! 已有真实 VP8 解码器到原生帧邮箱的边界。不会创建 FFmpeg 或启用摄像头。
use crate::{Error, FramePublisher, RgbaFrame};
use surreal_ck_native_media_platform::desktop::{VideoConfig, VideoDecoder};

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error(transparent)]
    Media(#[from] surreal_ck_native_media_platform::desktop::Error),
    #[error(transparent)]
    Frame(#[from] Error),
}

/// 等待已启动解码器的一帧并发布。video 必须与创建解码器时的配置相同。
/// 取消/停止解码器与接收网络包由宿主管理；本函数不自行 spawn 无生命周期任务。
pub async fn read_and_present(
    decoder: &mut VideoDecoder,
    video: VideoConfig,
    publisher: &FramePublisher,
) -> Result<u64, DecodeError> {
    let pixels = decoder.read_rgba().await?;
    Ok(publisher.present(RgbaFrame::packed(
        u32::from(video.width),
        u32::from(video.height),
        pixels,
    )?)?)
}
