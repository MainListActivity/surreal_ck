//! NSH 0.4 AppKit 注册适配器，实验 feature macos-appkit 默认关闭。
use crate::{appkit::AppKitView, backend, COMPONENT_NAME};
pub use nsh_platform_macos::Components;
use nsh_platform_macos::{ComponentContext, NativeComponent};
use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::NSView;
use std::rc::Rc;

/// 由应用根 #[native_components(macos)] 或 AppOptions.components 显式注册。
/// 本函数不修改客户端支持声明，也不访问媒体设备。
pub fn register(components: &Components) {
    components.register(
        COMPONENT_NAME,
        Rc::new(|context| {
            let mtm = MainThreadMarker::new()
                .expect("NSH AppKit native component must be created on the main thread");
            context.set_size(320.0, 180.0);
            let notify: backend::Notify = Rc::new(move |event| emit_event(&context, event));
            Box::new(Component(AppKitView::new(notify, mtm)))
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
struct Component(AppKitView);
impl NativeComponent for Component {
    fn view(&self) -> Retained<NSView> {
        self.0.view()
    }
    fn set_prop(&mut self, name: &str, value: Option<&serde_json::Value>) {
        self.0.set_prop(name, value);
    }
}
