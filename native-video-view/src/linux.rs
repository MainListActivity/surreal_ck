//! NSH 0.4 / GTK4 原生视频组件，像素直接交给 GdkMemoryTexture。

use crate::{subscribe, FrameReceiver, FrameUpdate, COMPONENT_NAME};
use nsh_platform_linux::{
    gtk4::{self as gtk, gdk, glib, prelude::*},
    ComponentContext, NativeComponent,
};
use std::{cell::RefCell, rc::Rc};

// 允许应用根注册宏引用与此后端完全相同的 NSH 类型。
pub use nsh_platform_linux::Components;

struct RenderState {
    receiver: Option<FrameReceiver>,
    dimensions: Option<(u32, u32)>,
    context: ComponentContext,
}

/// 必须从 GTK UI 线程调用；不初始化 GTK、不获取设备或额外权限。
pub fn register(components: &Components) {
    components.register(
        COMPONENT_NAME,
        Rc::new(|context| Box::new(VideoView::new(context))),
    );
}

struct VideoView {
    picture: gtk::Picture,
    state: Rc<RefCell<RenderState>>,
    tick: Option<gtk::TickCallbackId>,
}

impl VideoView {
    fn new(context: ComponentContext) -> Self {
        let picture = gtk::Picture::new();
        picture.set_can_shrink(true);
        picture.set_content_fit(gtk::ContentFit::Contain);
        picture.set_hexpand(true);
        picture.set_vexpand(true);
        let state = Rc::new(RefCell::new(RenderState {
            receiver: None,
            dimensions: None,
            context,
        }));
        let for_tick = state.clone();
        // GTK 只在映射到窗口的控件上触发 frame clock；没有跨线程 GTK 对象和逐帧事件队列。
        // 回调使用参数 picture 而不是捕获强引用，避免 picture -> callback -> picture 循环。
        let tick = picture.add_tick_callback(move |picture, _| {
            let mut state = for_tick.borrow_mut();
            let update = state.receiver.as_mut().map(FrameReceiver::poll);
            match update {
                Some(FrameUpdate::Frame { frame, .. }) => {
                    let bytes = glib::Bytes::from_owned(frame.pixels().clone());
                    let texture = gdk::MemoryTexture::new(
                        frame.width() as i32,
                        frame.height() as i32,
                        gdk::MemoryFormat::R8g8b8a8,
                        &bytes,
                        frame.stride(),
                    );
                    picture.set_paintable(Some(&texture));
                    let dimensions = (frame.width(), frame.height());
                    if state.dimensions != Some(dimensions) {
                        state
                            .context
                            .set_size(dimensions.0 as f32, dimensions.1 as f32);
                        state.context.emit(
                            "ready",
                            serde_json::json!({
                                "width": dimensions.0, "height": dimensions.1,
                            }),
                        );
                        state.dimensions = Some(dimensions);
                    }
                }
                Some(FrameUpdate::Closed) => {
                    picture.set_paintable(None::<&gdk::Paintable>);
                    state.receiver = None;
                    state.dimensions = None;
                    state.context.emit("closed", serde_json::Value::Null);
                }
                Some(FrameUpdate::Unchanged) | None => {}
            }
            glib::ControlFlow::Continue
        });
        Self {
            picture,
            state,
            tick: Some(tick),
        }
    }
}

impl NativeComponent for VideoView {
    fn widget(&self) -> gtk::Widget {
        self.picture.clone().upcast()
    }

    fn set_prop(&mut self, name: &str, value: Option<&serde_json::Value>) {
        if name != "streamId" {
            return;
        }
        // 改绑前立即清空旧画面，失败不会继续展示前一位对端的图像。
        self.picture.set_paintable(None::<&gdk::Paintable>);
        let mut state = self.state.borrow_mut();
        state.receiver = None;
        state.dimensions = None;
        if value.is_none() || value.is_some_and(serde_json::Value::is_null) {
            return;
        }
        let Some(id) = value
            .and_then(serde_json::Value::as_str)
            .filter(|id| id.len() <= 32)
        else {
            state
                .context
                .emit("error", serde_json::json!({"message": "无效的视频流标识"}));
            return;
        };
        match subscribe(id) {
            Ok(receiver) => state.receiver = Some(receiver),
            Err(error) => state
                .context
                .emit("error", serde_json::json!({"message": error.to_string()})),
        }
    }
}

impl Drop for VideoView {
    fn drop(&mut self) {
        if let Some(tick) = self.tick.take() {
            tick.remove();
        }
        self.picture.set_paintable(None::<&gdk::Paintable>);
        self.state.borrow_mut().receiver = None;
    }
}
