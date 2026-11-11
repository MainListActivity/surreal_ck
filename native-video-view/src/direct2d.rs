//! 实验 Windows / NSH 0.4 Direct2D 后端。仅 windows-d2d feature 启用。
//! 原生 UI 线程创建和复用 ID2D1Bitmap1；后台线程仅合并重绘通知，不持有 COM 对象。
use crate::{backend, redraw::RedrawWatch, subscribe, FrameReceiver, FrameUpdate, RgbaFrame};
use ::windows::{
    core::Interface,
    Win32::Graphics::{
        Direct2D::{
            Common::{D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT, D2D_RECT_F, D2D_SIZE_U},
            ID2D1Bitmap1, ID2D1Device, ID2D1DeviceContext, D2D1_BITMAP_OPTIONS_NONE,
            D2D1_BITMAP_PROPERTIES1, D2D1_INTERPOLATION_MODE_LINEAR,
        },
        Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
    },
};
use std::{cell::RefCell, mem::ManuallyDrop, sync::Arc};

struct CachedBitmap {
    // 持有设备引用，旧设备存活期间其地址不可能被新设备复用。
    device: ID2D1Device,
    bitmap: ID2D1Bitmap1,
    dimensions: (u32, u32),
    sequence: u64,
}
#[derive(Default)]
struct DrawState {
    receiver: Option<FrameReceiver>,
    frame: Option<Arc<RgbaFrame>>,
    sequence: u64,
    bitmap: Option<CachedBitmap>,
    upload: Vec<u8>,
    announced: Option<(u32, u32)>,
    reported_error: bool,
}
impl DrawState {
    fn clear(&mut self) {
        *self = Self::default();
    }
}
pub(crate) struct Direct2DView {
    notify: backend::Notify,
    invalidate: Arc<dyn Fn() + Send + Sync>,
    state: RefCell<DrawState>,
    wake: Option<RedrawWatch>,
}
impl Direct2DView {
    pub(crate) fn new(notify: backend::Notify, invalidate: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self {
            notify,
            invalidate,
            state: RefCell::new(DrawState::default()),
            wake: None,
        }
    }
    fn failed(&self, state: &mut DrawState, message: impl ToString) {
        state.bitmap = None;
        state.announced = None;
        if !state.reported_error {
            (self.notify)(backend::Event::Error(message.to_string()));
            state.reported_error = true;
        }
    }
    fn bind(&mut self, id: &str) -> Result<(), String> {
        let receiver = subscribe(id).map_err(|e| e.to_string())?;
        let monitor = subscribe(id).map_err(|e| e.to_string())?;
        let invalidate = self.invalidate.clone();
        let wake = RedrawWatch::new(monitor, move || invalidate()).map_err(|e| e.to_string())?;
        self.state.get_mut().receiver = Some(receiver);
        self.wake = Some(wake);
        Ok(())
    }
}
impl Direct2DView {
    pub(crate) fn draw(&self, dc: &ID2D1DeviceContext, size: (f32, f32)) {
        if let Some(wake) = self.wake.as_ref() {
            wake.acknowledge();
        }
        let mut state = self.state.borrow_mut();
        match state.receiver.as_mut().map(FrameReceiver::poll) {
            Some(FrameUpdate::Frame { frame, sequence }) => {
                state.frame = Some(frame);
                state.sequence = sequence;
            }
            Some(FrameUpdate::Closed) => {
                state.clear();
                (self.notify)(backend::Event::Closed);
                return;
            }
            Some(FrameUpdate::Unchanged) | None => {}
        }
        let Some(frame) = state.frame.clone() else {
            return;
        };
        let dimensions = (frame.width(), frame.height());
        let Some((left, top, width, height)) = backend::contain(size, dimensions) else {
            return;
        };
        // SAFETY: NSH 调用 draw 时提供其当前 UI 线程上的有效 Direct2D context。
        let device = match unsafe { dc.GetDevice() } {
            Ok(device) => device,
            Err(error) => {
                self.failed(&mut state, error);
                return;
            }
        };
        let current = state.bitmap.as_ref().filter(|bitmap| {
            bitmap.device.as_raw() == device.as_raw() && bitmap.dimensions == dimensions
        });
        let needs_upload = current.is_none_or(|bitmap| bitmap.sequence != state.sequence);
        let reusable = current.map(|bitmap| bitmap.bitmap.clone());
        if needs_upload {
            backend::premultiplied_bgra(&frame, &mut state.upload);
            let stride = frame.width() * 4;
            let bitmap = reusable.filter(|bitmap| {
                // SAFETY: upload 含 height 行、每行 width*4 字节，重用位图的尺寸完全匹配。
                unsafe { bitmap.CopyFromMemory(None, state.upload.as_ptr().cast(), stride) }.is_ok()
            });
            let bitmap = if let Some(bitmap) = bitmap {
                bitmap
            } else {
                let properties = D2D1_BITMAP_PROPERTIES1 {
                    pixelFormat: D2D1_PIXEL_FORMAT {
                        format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                    },
                    dpiX: 96.0,
                    dpiY: 96.0,
                    bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
                    colorContext: ManuallyDrop::new(None),
                };
                // SAFETY: 帧已由公共边界验证，转换缓冲恰好覆盖传入尺寸和行跨度。
                match unsafe {
                    dc.CreateBitmap(
                        D2D_SIZE_U {
                            width: frame.width(),
                            height: frame.height(),
                        },
                        Some(state.upload.as_ptr().cast()),
                        stride,
                        &properties,
                    )
                } {
                    Ok(bitmap) => bitmap,
                    Err(error) => {
                        self.failed(&mut state, error);
                        return;
                    }
                }
            };
            state.bitmap = Some(CachedBitmap {
                device,
                bitmap,
                dimensions,
                sequence: state.sequence,
            });
        }
        let Some(bitmap) = state.bitmap.as_ref() else {
            return;
        };
        let rect = D2D_RECT_F {
            left,
            top,
            right: left + width,
            bottom: top + height,
        };
        // SAFETY: 位图属于上方验证的同一设备，NSH 已设置视图局部变换和裁剪。
        unsafe {
            dc.DrawBitmap(
                &bitmap.bitmap,
                Some(&rect),
                1.0,
                D2D1_INTERPOLATION_MODE_LINEAR,
                None,
                None,
            );
        }
        state.reported_error = false;
        if state.announced != Some(dimensions) {
            (self.notify)(backend::Event::Ready(dimensions));
            state.announced = Some(dimensions);
        }
    }

    pub(crate) fn set_prop(&mut self, name: &str, value: Option<&serde_json::Value>) {
        if name != "streamId" {
            return;
        }
        // 先停止旧通知线程，再移除旧纹理。改绑失败也不能继续显示前一个对端。
        self.wake = None;
        self.state.get_mut().clear();
        (self.invalidate)();
        if value.is_none() || value.is_some_and(serde_json::Value::is_null) {
            return;
        }
        let Some(id) = value
            .and_then(serde_json::Value::as_str)
            .filter(|id| id.len() <= 32)
        else {
            (self.notify)(backend::Event::Error("无效的视频流标识".into()));
            return;
        };
        if let Err(error) = self.bind(id) {
            (self.notify)(backend::Event::Error(error));
        }
    }
}
impl Drop for Direct2DView {
    fn drop(&mut self) {
        self.wake = None; // join 只等可立即取消的通知线程，不等待采集/网络/解码任务。
        self.state.get_mut().clear();
    }
}
