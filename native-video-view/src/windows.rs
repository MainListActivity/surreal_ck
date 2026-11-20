//! NSH 0.4 Direct2D 注册适配器，实验 feature windows-d2d 默认关闭。
use crate::{backend, direct2d::Direct2DView, COMPONENT_NAME};
use ::windows::Win32::Graphics::Direct2D::ID2D1DeviceContext;
pub use nsh_platform_windows::Components;
use nsh_platform_windows::{ComponentContext, NativeComponent};
use std::{rc::Rc, sync::Arc};

/// 由应用根 #[native_components(windows)] 或 AppOptions.components 显式注册。
/// 后台线程只调用线程安全的 context.redraw，不持有 Direct2D 对象。
pub fn register(components: &Components) {
    components.register(
        COMPONENT_NAME,
        Rc::new(|context| {
            context.set_size(320.0, 180.0);
            let wake = context.clone();
            let invalidate = Arc::new(move || wake.redraw());
            let notify: backend::Notify = Rc::new(move |event| emit_event(&context, event));
            Box::new(Component(Direct2DView::new(notify, invalidate)))
        }),
    );
}
fn emit_event(context: &ComponentContext, event: backend::Event) {
    match event {
        backend::Event::Ready((width, height)) => {
            let (w, h) = backend::intrinsic((width, height));
            context.set_size(w, h);
            context.emit(
                "ready",
                serde_json::json!({"width": width, "height": height}),
            );
        }
        backend::Event::Closed => context.emit("closed", serde_json::Value::Null),
        backend::Event::Error(message) => {
            context.emit("error", serde_json::json!({"message": message}))
        }
    }
}
struct Component(Direct2DView);
impl NativeComponent for Component {
    fn draw(&self, dc: &ID2D1DeviceContext, size: (f32, f32)) {
        self.0.draw(dc, size);
    }
    fn set_prop(&mut self, name: &str, value: Option<&serde_json::Value>) {
        self.0.set_prop(name, value);
    }
}
