#[path = "desktop_runtime.rs"]
mod runtime;
use bytes::Bytes;
use std::{io, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
};
#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("invalid media configuration or malformed stream")]
    Invalid,
    #[error("Wayland screen capture requires an implemented desktop portal adapter; X11 bypass is disabled")]
    PortalRequired,
    #[error("capture backend does not match the current operating system")]
    UnsupportedPlatform,
    #[error(transparent)]
    Io(#[from] io::Error),
}
#[derive(Debug, Clone, Copy)]
pub struct VideoConfig {
    pub width: u16,
    pub height: u16,
    pub fps: u16,
}
impl VideoConfig {
    fn validate(self) -> Result<Self, Error> {
        if self.width == 0
            || self.height == 0
            || self.width > 1920
            || self.height > 1080
            || self.fps == 0
            || self.fps > 60
        {
            Err(Error::Invalid)
        } else {
            Ok(self)
        }
    }
}
pub enum CaptureInput {
    /// AVFoundation 枚举后由用户选择的摄像头或屏幕索引。屏幕权限由 macOS TCC 管理。
    MacVideo {
        device_index: u32,
        video: VideoConfig,
    },
    /// AVFoundation 枚举后由用户选择的麦克风索引。
    MacMicrophone {
        device_index: u32,
    },
    /// DirectShow 枚举后由用户选择的设备名；不拼接 shell 命令。
    WindowsCamera {
        device: String,
        video: VideoConfig,
    },
    WindowsMicrophone {
        device: String,
    },
    /// 用户明确选择的桌面区域。调用前宿主须展示准确区域并获得用户操作。
    WindowsScreen {
        x: i32,
        y: i32,
        video: VideoConfig,
    },
    /// 用户选择的摄像头节点；不请求额外 Linux 组或提升权限。
    Camera {
        device: String,
        video: VideoConfig,
    },
    /// 用户选择的 PulseAudio/PipeWire-Pulse source，default 由系统设置决定。
    Microphone {
        source: String,
    },
    /// 仅显式 X11 会话。宿主需让用户知道共享整个所选 display 的指定区域。
    X11Screen {
        display: String,
        video: VideoConfig,
    },
}
pub enum Encoded {
    Video { data: Bytes, duration: Duration },
    Audio { data: Bytes, duration: Duration },
}
pub struct Capture {
    child: Child,
    output: ChildStdout,
    video: Option<VideoConfig>,
    header_read: bool,
    pending_audio: Vec<Bytes>,
    fragment: Vec<u8>,
}
impl Capture {
    /// 需要官方 FFmpeg（libvpx/libopus、V4L2/Pulse/X11 支持）。缺失时返回错误，不装软件、不改权限。
    pub fn start(input: CaptureInput) -> Result<Self, Error> {
        let platform = match &input {
            CaptureInput::MacVideo { .. } | CaptureInput::MacMicrophone { .. } => "macos",
            CaptureInput::WindowsCamera { .. }
            | CaptureInput::WindowsMicrophone { .. }
            | CaptureInput::WindowsScreen { .. } => "windows",
            _ => "linux",
        };
        if platform != std::env::consts::OS {
            return Err(Error::UnsupportedPlatform);
        }
        let (args, video) = capture_args(input)?;
        Self::spawn(args, video)
    }
    fn spawn(mut args: Vec<String>, video: Option<VideoConfig>) -> Result<Self, Error> {
        if let Some(v) = video {
            args.extend([
                "-an".into(),
                "-vf".into(),
                format!("scale={}:{}", v.width, v.height),
                "-c:v".into(),
                "libvpx".into(),
                "-deadline".into(),
                "realtime".into(),
                "-cpu-used".into(),
                "8".into(),
                "-g".into(),
                v.fps.to_string(),
                "-b:v".into(),
                "1500k".into(),
                "-f".into(),
                "ivf".into(),
            ]);
        } else {
            args.extend(
                [
                    "-vn",
                    "-c:a",
                    "libopus",
                    "-frame_duration",
                    "20",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-f",
                    "ogg",
                    "-page_duration",
                    "20000",
                ]
                .map(String::from),
            );
        }
        args.extend(["-flush_packets", "1", "pipe:1"].map(String::from));
        let mut child = Command::new(runtime::executable("ffmpeg")?)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let output = child.stdout.take().ok_or(Error::Invalid)?;
        Ok(Self {
            child,
            output,
            video,
            header_read: false,
            pending_audio: Vec::new(),
            fragment: Vec::new(),
        })
    }
    pub async fn next(&mut self) -> Result<Encoded, Error> {
        if let Some(v) = self.video {
            if !self.header_read {
                let mut header = [0; 32];
                self.output.read_exact(&mut header).await?;
                if &header[..4] != b"DKIF"
                    || &header[8..12] != b"VP80"
                    || u16::from_le_bytes([header[6], header[7]]) != 32
                    || u16::from_le_bytes([header[12], header[13]]) != v.width
                    || u16::from_le_bytes([header[14], header[15]]) != v.height
                {
                    return Err(Error::Invalid);
                }
                self.header_read = true;
            }
            let mut header = [0; 12];
            self.output.read_exact(&mut header).await?;
            let size =
                u32::from_le_bytes(header[..4].try_into().map_err(|_| Error::Invalid)?) as usize;
            if size == 0 || size > 4 * 1024 * 1024 {
                return Err(Error::Invalid);
            }
            let mut data = vec![0; size];
            self.output.read_exact(&mut data).await?;
            return Ok(Encoded::Video {
                data: Bytes::from(data),
                duration: Duration::from_secs_f64(1.0 / f64::from(v.fps)),
            });
        }
        loop {
            if let Some(data) = self.pending_audio.pop() {
                return Ok(Encoded::Audio {
                    data,
                    duration: Duration::from_millis(20),
                });
            }
            let mut header = [0; 27];
            self.output.read_exact(&mut header).await?;
            if &header[..4] != b"OggS" || header[4] != 0 {
                return Err(Error::Invalid);
            }
            let mut lacing = vec![0; header[26] as usize];
            self.output.read_exact(&mut lacing).await?;
            let mut packets = Vec::new();
            for size in lacing {
                let mut segment = vec![0; size as usize];
                self.output.read_exact(&mut segment).await?;
                if self.fragment.len() + segment.len() > 65536 {
                    return Err(Error::Invalid);
                }
                self.fragment.extend_from_slice(&segment);
                if size < 255 {
                    let packet = std::mem::take(&mut self.fragment);
                    if packet.starts_with(b"OpusHead") || packet.starts_with(b"OpusTags") {
                        continue;
                    }
                    if packet.is_empty() || packet.len() > 1275 {
                        return Err(Error::Invalid);
                    }
                    packets.push(Bytes::from(packet));
                }
            }
            packets.reverse();
            self.pending_audio = packets;
        }
    }
    pub async fn stop(&mut self) -> Result<(), Error> {
        self.child.kill().await?;
        let _ = self.child.wait().await?;
        Ok(())
    }
}
fn capture_args(input: CaptureInput) -> Result<(Vec<String>, Option<VideoConfig>), Error> {
    match input {
        CaptureInput::MacVideo {
            device_index,
            video,
        } => {
            let video = video.validate()?;
            Ok((
                vec![
                    "-f".into(),
                    "avfoundation".into(),
                    "-framerate".into(),
                    video.fps.to_string(),
                    "-i".into(),
                    format!("{device_index}:none"),
                ],
                Some(video),
            ))
        }
        CaptureInput::MacMicrophone { device_index } => Ok((
            vec![
                "-f".into(),
                "avfoundation".into(),
                "-i".into(),
                format!("none:{device_index}"),
            ],
            None,
        )),
        CaptureInput::WindowsCamera { device, video } => {
            validate_windows_device(&device)?;
            let video = video.validate()?;
            Ok((
                vec![
                    "-f".into(),
                    "dshow".into(),
                    "-framerate".into(),
                    video.fps.to_string(),
                    "-video_size".into(),
                    format!("{}x{}", video.width, video.height),
                    "-i".into(),
                    format!("video={device}"),
                ],
                Some(video),
            ))
        }
        CaptureInput::WindowsMicrophone { device } => {
            validate_windows_device(&device)?;
            Ok((
                vec![
                    "-f".into(),
                    "dshow".into(),
                    "-i".into(),
                    format!("audio={device}"),
                ],
                None,
            ))
        }
        CaptureInput::WindowsScreen { x, y, video } => {
            let video = video.validate()?;
            if x.checked_add(i32::from(video.width)).is_none()
                || y.checked_add(i32::from(video.height)).is_none()
            {
                return Err(Error::Invalid);
            }
            Ok((
                vec![
                    "-f".into(),
                    "gdigrab".into(),
                    "-framerate".into(),
                    video.fps.to_string(),
                    "-offset_x".into(),
                    x.to_string(),
                    "-offset_y".into(),
                    y.to_string(),
                    "-video_size".into(),
                    format!("{}x{}", video.width, video.height),
                    "-i".into(),
                    "desktop".into(),
                ],
                Some(video),
            ))
        }
        CaptureInput::Camera { device, video } => {
            let video = video.validate()?;
            let suffix = device.strip_prefix("/dev/video").ok_or(Error::Invalid)?;
            if suffix.is_empty() || !suffix.bytes().all(|c| c.is_ascii_digit()) {
                return Err(Error::Invalid);
            }
            Ok((
                vec![
                    "-f".into(),
                    "v4l2".into(),
                    "-framerate".into(),
                    video.fps.to_string(),
                    "-video_size".into(),
                    format!("{}x{}", video.width, video.height),
                    "-i".into(),
                    device,
                ],
                Some(video),
            ))
        }
        CaptureInput::Microphone { source } => {
            if source.is_empty()
                || source.len() > 256
                || !source
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            {
                return Err(Error::Invalid);
            }
            Ok((vec!["-f".into(), "pulse".into(), "-i".into(), source], None))
        }
        CaptureInput::X11Screen { display, video } => {
            if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                return Err(Error::PortalRequired);
            }
            let video = video.validate()?;
            if !display.starts_with(':')
                || display.len() > 32
                || !display
                    .bytes()
                    .all(|c| c.is_ascii_digit() || b":.+,".contains(&c))
            {
                return Err(Error::Invalid);
            }
            Ok((
                vec![
                    "-f".into(),
                    "x11grab".into(),
                    "-framerate".into(),
                    video.fps.to_string(),
                    "-video_size".into(),
                    format!("{}x{}", video.width, video.height),
                    "-i".into(),
                    display,
                ],
                Some(video),
            ))
        }
    }
}
// DirectShow 的冒号/引号属于输入设备语法，不接受组合设备或注入另一个输入。
fn validate_windows_device(device: &str) -> Result<(), Error> {
    if device.is_empty()
        || device.len() > 512
        || device
            .chars()
            .any(|c| c.is_control() || c == ':' || c == '"')
    {
        return Err(Error::Invalid);
    }
    Ok(())
}

/// VP8 解码为 RGBA，宿主必须在真正的 NSH 图像/纹理节点渲染。不会创建假视频 UI。
pub struct VideoDecoder {
    child: Child,
    input: Option<ChildStdin>,
    output: ChildStdout,
    video: VideoConfig,
    timestamp: u64,
    keyframe_seen: bool,
}
impl VideoDecoder {
    pub async fn new(video: VideoConfig) -> Result<Self, Error> {
        let video = video.validate()?;
        let mut child = Command::new(runtime::executable("ffmpeg")?)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-threads",
                "1",
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
                "-f",
                "ivf",
                "-i",
                "pipe:0",
                "-f",
                "rawvideo",
                "-threads",
                "1",
                "-pix_fmt",
                "rgba",
                "-flush_packets",
                "1",
                "pipe:1",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let mut input = child.stdin.take().ok_or(Error::Invalid)?;
        let output = child.stdout.take().ok_or(Error::Invalid)?;
        input.write_all(&ivf_header(video)).await?;
        Ok(Self {
            child,
            input: Some(input),
            output,
            video,
            timestamp: 0,
            keyframe_seen: false,
        })
    }
    fn validate_frame(&mut self, data: &[u8]) -> Result<(), Error> {
        if data.is_empty() || data.len() > 4 * 1024 * 1024 {
            return Err(Error::Invalid);
        }
        if data[0] & 1 == 0 {
            if data.len() < 10
                || &data[3..6] != b"\x9d\x01\x2a"
                || (u16::from_le_bytes([data[6], data[7]]) & 0x3fff) != self.video.width
                || (u16::from_le_bytes([data[8], data[9]]) & 0x3fff) != self.video.height
            {
                return Err(Error::Invalid);
            }
            self.keyframe_seen = true;
        } else if !self.keyframe_seen {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    /// 单独写入时调用者必须并发读取输出；会话通常应调用 decode_rgba。
    pub async fn write(&mut self, data: &[u8]) -> Result<(), Error> {
        self.validate_frame(data)?;
        let input = self.input.as_mut().ok_or(Error::Invalid)?;
        write_ivf_frame(input, self.timestamp, data).await?;
        self.timestamp += 1;
        Ok(())
    }
    /// 同时写编码帧并读取 RGBA，防止大帧撑满双向 OS pipe。
    /// 宿主负责超时；此操作取消或 I/O 失败后必须 stop/drop decoder，不能复用部分帧状态。
    /// 不得与尚未 read_rgba 的旧 write 混用；一帧输入对应一帧输出。
    pub async fn decode_rgba(&mut self, data: &[u8]) -> Result<Bytes, Error> {
        self.validate_frame(data)?;
        let input = self.input.as_mut().ok_or(Error::Invalid)?;
        let mut pixels =
            vec![0; usize::from(self.video.width) * usize::from(self.video.height) * 4];
        tokio::try_join!(
            write_ivf_frame(input, self.timestamp, data),
            self.output.read_exact(&mut pixels)
        )?;
        self.timestamp += 1;
        Ok(Bytes::from(pixels))
    }
    pub async fn read_rgba(&mut self) -> Result<Bytes, Error> {
        let mut pixels =
            vec![0; usize::from(self.video.width) * usize::from(self.video.height) * 4];
        self.output.read_exact(&mut pixels).await?;
        Ok(Bytes::from(pixels))
    }
    pub async fn finish_input(&mut self) -> Result<(), Error> {
        drop(self.input.take());
        Ok(())
    }
    pub async fn stop(&mut self) -> Result<(), Error> {
        self.child.kill().await?;
        let _ = self.child.wait().await?;
        Ok(())
    }
}
async fn write_ivf_frame(input: &mut ChildStdin, timestamp: u64, data: &[u8]) -> io::Result<()> {
    input.write_all(&(data.len() as u32).to_le_bytes()).await?;
    input.write_all(&timestamp.to_le_bytes()).await?;
    input.write_all(data).await?;
    input.flush().await
}

fn ivf_header(video: VideoConfig) -> Vec<u8> {
    let mut h = Vec::with_capacity(32);
    h.extend_from_slice(b"DKIF");
    h.extend_from_slice(&0u16.to_le_bytes());
    h.extend_from_slice(&32u16.to_le_bytes());
    h.extend_from_slice(b"VP80");
    h.extend_from_slice(&video.width.to_le_bytes());
    h.extend_from_slice(&video.height.to_le_bytes());
    h.extend_from_slice(&u32::from(video.fps).to_le_bytes());
    h.extend_from_slice(&1u32.to_le_bytes());
    h.extend_from_slice(&0u64.to_le_bytes());
    h
}

/// 原生 SDL/Pulse 播放后端；仅宿主明确开启播放时构建。没有网页播放器。
/// 目前仅支持固定 20ms、48kHz 双声道 Opus，暂无 jitter/同步与设备选择 UI。
pub struct AudioPlayer {
    child: Child,
    input: ChildStdin,
    sequence: u32,
    granule: u64,
}
impl AudioPlayer {
    pub async fn new() -> Result<Self, Error> {
        let mut child = Command::new(runtime::executable("ffplay")?)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nodisp",
                "-autoexit",
                "-fflags",
                "nobuffer",
                "-f",
                "ogg",
                "-i",
                "pipe:0",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let mut input = child.stdin.take().ok_or(Error::Invalid)?;
        input
            .write_all(&ogg_page(
                b"OpusHead\x01\x02\x00\x00\x80\xbb\x00\x00\x00\x00\x00",
                2,
                0,
                0,
            ))
            .await?;
        input
            .write_all(&ogg_page(
                b"OpusTags\x00\x00\x00\x00\x00\x00\x00\x00",
                0,
                0,
                1,
            ))
            .await?;
        Ok(Self {
            child,
            input,
            sequence: 2,
            granule: 0,
        })
    }
    pub async fn write_opus_20ms(&mut self, data: &[u8]) -> Result<(), Error> {
        if data.is_empty() || data.len() > 1275 {
            return Err(Error::Invalid);
        }
        self.granule += 960;
        self.input
            .write_all(&ogg_page(data, 0, self.granule, self.sequence))
            .await?;
        self.sequence = self.sequence.wrapping_add(1);
        self.input.flush().await?;
        Ok(())
    }
    pub async fn stop(&mut self) -> Result<(), Error> {
        self.child.kill().await?;
        let _ = self.child.wait().await?;
        Ok(())
    }
}
fn ogg_page(data: &[u8], flags: u8, granule: u64, sequence: u32) -> Vec<u8> {
    let mut page = Vec::new();
    page.extend_from_slice(b"OggS");
    page.extend_from_slice(&[0, flags]);
    page.extend_from_slice(&granule.to_le_bytes());
    page.extend_from_slice(&1u32.to_le_bytes());
    page.extend_from_slice(&sequence.to_le_bytes());
    page.extend_from_slice(&0u32.to_le_bytes());
    let segments = data.len() / 255 + 1;
    page.push(segments as u8);
    page.extend(std::iter::repeat_n(255, segments - 1));
    page.push((data.len() % 255) as u8);
    page.extend_from_slice(data);
    let mut crc = 0u32;
    for byte in &page {
        crc ^= u32::from(*byte) << 24;
        for _ in 0..8 {
            crc = if crc & 0x80000000 != 0 {
                (crc << 1) ^ 0x04c11db7
            } else {
                crc << 1
            };
        }
    }
    page[22..26].copy_from_slice(&crc.to_le_bytes());
    page
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn real_ffmpeg_test_pattern_encode_decode_without_devices() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let video = VideoConfig {
                width: 64,
                height: 48,
                fps: 10,
            };
            let mut capture = Capture::spawn(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=64x48:rate=10",
                    "-t",
                    "0.5",
                ]
                .map(String::from)
                .to_vec(),
                Some(video),
            )
            .unwrap();
            let Encoded::Video { data, .. } = capture.next().await.unwrap() else {
                panic!("video expected")
            };
            assert!(!data.is_empty());
            let mut decoder = VideoDecoder::new(video).await.unwrap();
            decoder.write(&data).await.unwrap();
            // streaming check: do not close input before reading

            let rgba = decoder.read_rgba().await.unwrap();
            assert_eq!(rgba.len(), 64 * 48 * 4);
            assert!(rgba.as_chunks::<4>().0.iter().all(|p| p[3] == 255));
            let _ = capture.stop().await;
            let _ = decoder.stop().await;
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn large_frames_decode_concurrently_without_closing_input() {
        tokio::time::timeout(Duration::from_secs(30), async {
            let video = VideoConfig {
                width: 1280,
                height: 720,
                fps: 10,
            };
            let mut capture = Capture::spawn(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=1280x720:rate=10,noise=alls=100:allf=t",
                    "-t",
                    "0.3",
                ]
                .map(String::from)
                .to_vec(),
                Some(video),
            )
            .unwrap();
            let mut decoder = VideoDecoder::new(video).await.unwrap();
            let mut largest = 0;
            for _ in 0..3 {
                let Encoded::Video { data, .. } = capture.next().await.unwrap() else {
                    panic!("video expected")
                };
                largest = largest.max(data.len());
                let rgba = decoder.decode_rgba(&data).await.unwrap();
                assert_eq!(rgba.len(), 1280 * 720 * 4);
                assert!(rgba.as_chunks::<4>().0.iter().all(|pixel| pixel[3] == 255));
            }
            assert!(
                largest > 65536,
                "test must exceed a typical 64KiB pipe: {largest}"
            );
            // 输入仍然打开，且连续三帧已经实际输出。
            assert!(decoder.decode_rgba(&[]).await.is_err());
            let _ = capture.stop().await;
            let _ = decoder.stop().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn real_ffmpeg_sine_encodes_opus_and_ogg_decodes_to_pcm() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let mut capture = Capture::spawn(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000",
                    "-t",
                    "0.2",
                ]
                .map(String::from)
                .to_vec(),
                None,
            )
            .unwrap();
            let mut ogg = ogg_page(
                b"OpusHead\x01\x02\x00\x00\x80\xbb\x00\x00\x00\x00\x00",
                2,
                0,
                0,
            );
            ogg.extend(ogg_page(
                b"OpusTags\x00\x00\x00\x00\x00\x00\x00\x00",
                0,
                0,
                1,
            ));
            for i in 0..5 {
                let Encoded::Audio { data, .. } = capture.next().await.unwrap() else {
                    panic!("audio expected")
                };
                ogg.extend(ogg_page(
                    &data,
                    if i == 4 { 4 } else { 0 },
                    (i + 1) * 960,
                    i as u32 + 2,
                ));
            }
            let mut decoder = Command::new("ffmpeg")
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "ogg",
                    "-i",
                    "pipe:0",
                    "-f",
                    "s16le",
                    "pipe:1",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            decoder
                .stdin
                .as_mut()
                .unwrap()
                .write_all(&ogg)
                .await
                .unwrap();
            drop(decoder.stdin.take());
            let output = decoder.wait_with_output().await.unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout.len(), 5 * 960 * 2 * 2);
            assert!(output.stdout.iter().any(|v| *v != 0));
            let _ = capture.stop().await;
        })
        .await
        .unwrap();
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn missing_device_fails_instead_of_generating_fake_picture() {
        let mut capture = Capture::start(CaptureInput::Camera {
            device: "/dev/video999999".into(),
            video: VideoConfig {
                width: 64,
                height: 48,
                fps: 10,
            },
        })
        .unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(5), capture.next())
            .await
            .unwrap()
            .is_err());
        let _ = capture.stop().await;
    }
    #[test]
    fn desktop_inputs_are_explicit_and_validated() {
        let video = VideoConfig {
            width: 640,
            height: 480,
            fps: 30,
        };
        let (args, _) = capture_args(CaptureInput::MacVideo {
            device_index: 3,
            video,
        })
        .unwrap();
        assert_eq!(args.last().unwrap(), "3:none");
        let (args, _) = capture_args(CaptureInput::MacMicrophone { device_index: 2 }).unwrap();
        assert_eq!(args.last().unwrap(), "none:2");
        let (args, _) = capture_args(CaptureInput::WindowsCamera {
            device: "USB Camera (测试)".into(),
            video,
        })
        .unwrap();
        assert_eq!(args.last().unwrap(), "video=USB Camera (测试)");
        let (args, _) = capture_args(CaptureInput::WindowsScreen {
            x: -1920,
            y: 0,
            video,
        })
        .unwrap();
        assert_eq!(args.last().unwrap(), "desktop");
        assert!(args.contains(&"-1920".to_string()));
        for device in ["", "camera:audio=other", "camera\n", "\"camera\""] {
            assert!(capture_args(CaptureInput::WindowsMicrophone {
                device: device.into()
            })
            .is_err());
        }
        assert!(capture_args(CaptureInput::WindowsScreen {
            x: i32::MAX,
            y: 0,
            video
        })
        .is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn foreign_backends_never_spawn_on_linux() {
        assert!(matches!(
            Capture::start(CaptureInput::MacMicrophone { device_index: 0 }),
            Err(Error::UnsupportedPlatform)
        ));
        assert!(matches!(
            Capture::start(CaptureInput::WindowsMicrophone {
                device: "default".into()
            }),
            Err(Error::UnsupportedPlatform)
        ));
    }
    #[test]
    fn rejects_invalid_devices_and_sizes() {
        let video = VideoConfig {
            width: 0,
            height: 48,
            fps: 10,
        };
        assert!(video.validate().is_err());
        assert!(capture_args(CaptureInput::Camera {
            device: "https://example.com".into(),
            video: VideoConfig {
                width: 64,
                height: 48,
                fps: 10
            }
        })
        .is_err());
    }
}
