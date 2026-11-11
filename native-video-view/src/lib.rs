//! 原生视频帧边界：解码线程只写容量为一的最新帧邮箱，平台 UI 在线程本地消费。
//! 不编码 PNG、不生成 data URI，不通过 NSH JSON 发送像素，也不提供设备缺失时的假视频。

use bytes::Bytes;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, OnceLock, Weak},
};

#[cfg(all(target_os = "linux", feature = "linux-gtk"))]
pub mod linux;

// 实验后端只有显式 feature 与正确目标平台同时满足才参与构建。
#[cfg(all(target_os = "macos", feature = "macos-appkit"))]
mod appkit;
#[cfg(any(
    test,
    all(target_os = "macos", feature = "macos-appkit"),
    all(target_os = "windows", feature = "windows-d2d")
))]
mod backend;
#[cfg(all(target_os = "windows", feature = "windows-d2d"))]
mod direct2d;
#[cfg(all(target_os = "macos", feature = "macos-appkit"))]
pub mod macos;
#[cfg(any(test, all(target_os = "windows", feature = "windows-d2d")))]
mod redraw;
#[cfg(all(target_os = "windows", feature = "windows-d2d"))]
pub mod windows;

#[cfg(all(
    feature = "decoder",
    any(target_os = "linux", target_os = "macos", target_os = "windows")
))]
pub mod decoder;

pub const COMPONENT_NAME: &str = "surreal-collaboration/rgba-video";
pub const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_FRAME_SIDE: u32 = 4096;
pub const MAX_STREAMS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("视频帧尺寸超出允许范围")]
    Dimensions,
    #[error("RGBA 行跨度或缓冲区长度不正确")]
    BufferLayout,
    #[error("视频帧缓冲区超过内存上限")]
    FrameTooLarge,
    #[error("视频流已经关闭")]
    Closed,
    #[error("视频流数量已达上限")]
    TooManyStreams,
    #[error("视频流不存在或已关闭")]
    UnknownStream,
}

/// 非预乘、从左上角开始、每像素 R/G/B/A 四字节；可带行尾 padding。
/// 构造时验证尺寸与精确长度，字段私有，平台后端无需信任外部尺寸。
#[derive(Debug)]
pub struct RgbaFrame {
    width: u32,
    height: u32,
    stride: usize,
    pixels: Bytes,
}

impl RgbaFrame {
    pub fn packed(width: u32, height: u32, pixels: Bytes) -> Result<Self, Error> {
        if width == 0 || height == 0 || width > MAX_FRAME_SIDE || height > MAX_FRAME_SIDE {
            return Err(Error::Dimensions);
        }
        let stride = (width as usize).checked_mul(4).ok_or(Error::BufferLayout)?;
        Self::new(width, height, stride, pixels)
    }

    pub fn new(width: u32, height: u32, stride: usize, pixels: Bytes) -> Result<Self, Error> {
        if width == 0 || height == 0 || width > MAX_FRAME_SIDE || height > MAX_FRAME_SIDE {
            return Err(Error::Dimensions);
        }
        let row = (width as usize).checked_mul(4).ok_or(Error::BufferLayout)?;
        let length = stride
            .checked_mul(height as usize)
            .ok_or(Error::BufferLayout)?;
        if stride < row || !stride.is_multiple_of(4) || pixels.len() != length {
            return Err(Error::BufferLayout);
        }
        if length > MAX_FRAME_BYTES {
            return Err(Error::FrameTooLarge);
        }
        Ok(Self {
            width,
            height,
            stride,
            pixels,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn stride(&self) -> usize {
        self.stride
    }
    pub fn pixels(&self) -> &Bytes {
        &self.pixels
    }
}

#[derive(Default)]
struct State {
    frame: Option<Arc<RgbaFrame>>,
    sequence: u64,
    closed: bool,
}

struct Shared {
    id: String,
    state: Mutex<State>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // 临界区只替换已验证的数据，不调用用户代码。中毒时仍允许关闭并释放帧。
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn close(&self) {
        let old = {
            let mut state = self.lock();
            state.closed = true;
            state.frame.take()
        };
        // 大块像素缓冲的释放不占用邮箱锁。
        drop(old);
    }
}

struct PublisherLease(Arc<Shared>);
impl Drop for PublisherLease {
    fn drop(&mut self) {
        self.0.close();
    }
}

/// 可跨线程克隆。最后一个发布者析构会关闭流；视图本身不会延长发布者生命。
#[derive(Clone)]
pub struct FramePublisher {
    lease: Arc<PublisherLease>,
}

impl FramePublisher {
    pub fn id(&self) -> &str {
        &self.lease.0.id
    }

    /// 替换尚未显示的旧帧，不阻塞等待 UI、不增加队列长度。
    /// 返回此流的序号；序号不是媒体时间戳，AV 同步由上层负责。
    pub fn present(&self, frame: RgbaFrame) -> Result<u64, Error> {
        let (old, sequence) = {
            let mut state = self.lease.0.lock();
            if state.closed {
                return Err(Error::Closed);
            }
            state.sequence = state.sequence.wrapping_add(1);
            let old = state.frame.replace(Arc::new(frame));
            (old, state.sequence)
        };
        drop(old);
        Ok(sequence)
    }

    /// 幂等；所有克隆发布者随后都拒绝新帧，下一次 UI tick 清空画面。
    pub fn close(&self) {
        self.lease.0.close();
    }
}

/// UI 每次刷新至多拿走一次新的快照。多个原生视图可各自消费同一条流。
pub struct FrameReceiver {
    shared: Arc<Shared>,
    seen: Option<u64>,
}

#[derive(Debug)]
pub enum FrameUpdate {
    Unchanged,
    Frame {
        frame: Arc<RgbaFrame>,
        sequence: u64,
    },
    Closed,
}

impl FrameReceiver {
    pub fn poll(&mut self) -> FrameUpdate {
        let state = self.shared.lock();
        if state.closed {
            return FrameUpdate::Closed;
        }
        let Some(frame) = state.frame.as_ref() else {
            return FrameUpdate::Unchanged;
        };
        if self.seen == Some(state.sequence) {
            return FrameUpdate::Unchanged;
        }
        self.seen = Some(state.sequence);
        FrameUpdate::Frame {
            frame: frame.clone(),
            sequence: state.sequence,
        }
    }
}

#[derive(Default)]
struct Registry {
    next_id: u64,
    streams: HashMap<String, Weak<Shared>>,
}

/// 限制同时存在的流数量；注册表只保存弱引用，不会让已结束会话泄漏像素。
#[derive(Default)]
pub struct FrameHub(Mutex<Registry>);

impl FrameHub {
    pub fn open(&self) -> Result<FramePublisher, Error> {
        let mut registry = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        registry
            .streams
            .retain(|_, weak| weak.upgrade().is_some_and(|s| !s.lock().closed));
        if registry.streams.len() >= MAX_STREAMS {
            return Err(Error::TooManyStreams);
        }
        registry.next_id = registry
            .next_id
            .checked_add(1)
            .ok_or(Error::TooManyStreams)?;
        let id = format!("video-{}", registry.next_id);
        let shared = Arc::new(Shared {
            id: id.clone(),
            state: Mutex::new(State::default()),
        });
        registry.streams.insert(id, Arc::downgrade(&shared));
        Ok(FramePublisher {
            lease: Arc::new(PublisherLease(shared)),
        })
    }

    pub fn subscribe(&self, id: &str) -> Result<FrameReceiver, Error> {
        let registry = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        let shared = registry
            .streams
            .get(id)
            .and_then(Weak::upgrade)
            .ok_or(Error::UnknownStream)?;
        if shared.lock().closed {
            return Err(Error::UnknownStream);
        }
        Ok(FrameReceiver { shared, seen: None })
    }
}

fn hub() -> &'static FrameHub {
    static HUB: OnceLock<FrameHub> = OnceLock::new();
    HUB.get_or_init(FrameHub::default)
}

/// NSH 组件使用进程内注册表，通过不含像素的 streamId 属性定位流。
pub fn open_stream() -> Result<FramePublisher, Error> {
    hub().open()
}

pub fn subscribe(id: &str) -> Result<FrameReceiver, Error> {
    hub().subscribe(id)
}

/// 当前编译目标是否允许宿主接入视频。普通构建仍只支持 Linux GTK。
/// macOS/Windows 必须同时启用匹配后端与 experimental-host；这不代表运行验收。
/// 宿主必须以同一显式 opt-in 同时控制根注册宏、main 注册和接收许可，不能只开依赖 feature。
pub fn rendering_supported() -> bool {
    cfg!(any(
        all(target_os = "linux", feature = "linux-gtk"),
        all(
            feature = "experimental-host",
            any(
                all(target_os = "macos", feature = "macos-appkit"),
                all(target_os = "windows", feature = "windows-d2d")
            )
        )
    ))
}
