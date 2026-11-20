//! 实验 macOS / NSH 0.4 AppKit 后端。仅 macos-appkit feature 启用。
//! RGBA 直接写入 NSBitmapImageRep，NSImageView 由 AppKit 绘制；不经过任何图像编码器。
use crate::{backend, subscribe, FrameReceiver, FrameUpdate, RgbaFrame};
use objc2::{
    define_class, msg_send,
    rc::{Retained, Weak},
    sel, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSBitmapFormat, NSBitmapImageRep, NSDeviceRGBColorSpace, NSImage, NSImageAlignment,
    NSImageScaling, NSImageView, NSView,
};
use objc2_foundation::{
    NSObject, NSObjectProtocol, NSRect, NSRunLoop, NSRunLoopCommonModes, NSSize, NSTimer,
};
use std::{cell::RefCell, ptr, rc::Rc, sync::Arc};

struct State {
    receiver: Option<FrameReceiver>,
    pending: Option<Arc<RgbaFrame>>,
    announced: Option<(u32, u32)>,
    notify: backend::Notify,
}
struct TickState {
    view: Weak<NSImageView>,
    state: Rc<RefCell<State>>,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = TickState]
    #[name = "SurrealCKRgbaVideoClock"]
    struct VideoClock;

    unsafe impl NSObjectProtocol for VideoClock {}

    impl VideoClock {
        #[unsafe(method(videoTick:))]
        fn video_tick(&self, _timer: &NSTimer) {
            let Some(view) = self.ivars().view.load() else { return; };
            let mut state = self.ivars().state.borrow_mut();
            match state.receiver.as_mut().map(FrameReceiver::poll) {
                Some(FrameUpdate::Frame { frame, .. }) => state.pending = Some(frame),
                Some(FrameUpdate::Closed) => {
                    // 即使窗口隐藏也清除旧图，恢复时不会先画上一会话的缓存。
                    view.setImage(None);
                    state.receiver = None;
                    state.pending = None;
                    state.announced = None;
                    (state.notify)(backend::Event::Closed);
                    return;
                }
                Some(FrameUpdate::Unchanged) | None => {}
            }
            // 不可见时只保留一个最新快照，不分配逐帧 AppKit 图像。
            if view.window().is_none() || view.isHiddenOrHasHiddenAncestor() { return; }
            let Some(frame) = state.pending.take() else { return; };
            match image_from_frame(&frame) {
                Ok(image) => {
                    view.setImage(Some(&image));
                    let dimensions = (frame.width(), frame.height());
                    if state.announced != Some(dimensions) {
                        (state.notify)(backend::Event::Ready(dimensions));
                        state.announced = Some(dimensions);
                    }
                }
                Err(error) => {
                    view.setImage(None);
                    state.receiver = None;
                    state.announced = None;
                    (state.notify)(backend::Event::Error(error.into()));
                }
            }
        }
    }
);
impl VideoClock {
    fn new(view: &NSImageView, state: Rc<RefCell<State>>, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(TickState {
            view: Weak::new(view),
            state,
        });
        // SAFETY: VideoClock 继承 NSObject；ivars 在标准 init 之前已完成初始化。
        unsafe { msg_send![super(this), init] }
    }
}

pub(crate) struct AppKitView {
    view: Retained<NSImageView>,
    state: Rc<RefCell<State>>,
    timer: Retained<NSTimer>,
    // NSTimer 也持有 target，显式保留保证析构先 invalidate 再释放目标。
    _clock: Retained<VideoClock>,
}
impl AppKitView {
    pub(crate) fn new(notify: backend::Notify, mtm: MainThreadMarker) -> Self {
        let view = NSImageView::initWithFrame(NSImageView::alloc(mtm), NSRect::ZERO);
        view.setEditable(false);
        view.setAnimates(false);
        view.setImageAlignment(NSImageAlignment::AlignCenter);
        view.setImageScaling(NSImageScaling::ScaleProportionallyUpOrDown);
        let state = Rc::new(RefCell::new(State {
            receiver: None,
            pending: None,
            announced: None,
            notify,
        }));
        let clock = VideoClock::new(&view, state.clone(), mtm);
        // SAFETY: target 的 videoTick: 签名与 NSTimer 一致。只把计时器放入主 RunLoop，
        // selector 回调不跨线程传递 Rc/AppKit 对象，避免使用要求 Send 的 block API。
        let timer = unsafe {
            NSTimer::timerWithTimeInterval_target_selector_userInfo_repeats(
                1.0 / 60.0,
                &clock,
                sel!(videoTick:),
                None,
                true,
            )
        };
        // SAFETY: 由 MainThreadMarker 保证当前为主线程；CommonModes 是 Foundation 常量。
        unsafe {
            NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes);
        }
        Self {
            view,
            state,
            timer,
            _clock: clock,
        }
    }
}
impl AppKitView {
    pub(crate) fn view(&self) -> Retained<NSView> {
        Retained::into_super(Retained::into_super(self.view.clone()))
    }
    pub(crate) fn set_prop(&mut self, name: &str, value: Option<&serde_json::Value>) {
        if name != "streamId" {
            return;
        }
        self.view.setImage(None);
        let mut state = self.state.borrow_mut();
        state.receiver = None;
        state.pending = None;
        state.announced = None;
        if value.is_none() || value.is_some_and(serde_json::Value::is_null) {
            return;
        }
        let Some(id) = value
            .and_then(serde_json::Value::as_str)
            .filter(|id| id.len() <= 32)
        else {
            (state.notify)(backend::Event::Error("无效的视频流标识".into()));
            return;
        };
        match subscribe(id) {
            Ok(receiver) => state.receiver = Some(receiver),
            Err(error) => (state.notify)(backend::Event::Error(error.to_string())),
        }
    }
}
impl Drop for AppKitView {
    fn drop(&mut self) {
        // 在创建它的主线程上撤销；target 只弱引用 NSImageView，没有 timer/view 引用环。
        self.timer.invalidate();
        self.view.setImage(None);
        let mut state = self.state.borrow_mut();
        state.receiver = None;
        state.pending = None;
    }
}

fn image_from_frame(frame: &RgbaFrame) -> Result<Retained<NSImage>, &'static str> {
    let row = frame.width() as usize * 4;
    // SAFETY: null planes 要求 AppKit 自行分配存储；8位RGBA、4 samples、非预乘alpha，
    // 宽高已通过公共帧边界验证，bytesPerRow 为有效的紧密行跨度。
    let bitmap = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(), ptr::null_mut(), frame.width() as isize, frame.height() as isize,
            8, 4, true, false, NSDeviceRGBColorSpace, NSBitmapFormat::AlphaNonpremultiplied,
            row as isize, 32,
        )
    }.ok_or("AppKit 无法分配 RGBA 位图")?;
    let stride = usize::try_from(bitmap.bytesPerRow()).map_err(|_| "AppKit 返回无效行跨度")?;
    let available =
        usize::try_from(bitmap.bytesPerPlane()).map_err(|_| "AppKit 返回无效位图长度")?;
    let required = stride
        .checked_mul(frame.height() as usize)
        .ok_or("AppKit 位图长度溢出")?;
    let destination = bitmap.bitmapData();
    if stride < row
        || available < required
        || destination.is_null()
        || bitmap.pixelsWide() != frame.width() as isize
        || bitmap.pixelsHigh() != frame.height() as isize
    {
        return Err("AppKit 返回不匹配的 RGBA 位图布局");
    }
    for y in 0..frame.height() as usize {
        // SAFETY: 每行源在已验证帧内，目标在上方检查过的 AppKit 自有存储内。
        // 两个独立分配不重叠，bitmap 在复制与 NSImage 持有期间一直存活。
        unsafe {
            ptr::copy_nonoverlapping(
                frame.pixels().as_ptr().add(y * frame.stride()),
                destination.add(y * stride),
                row,
            );
        }
    }
    let image = NSImage::initWithSize(
        NSImage::alloc(),
        NSSize::new(frame.width() as f64, frame.height() as f64),
    );
    image.addRepresentation(&bitmap);
    Ok(image)
}
