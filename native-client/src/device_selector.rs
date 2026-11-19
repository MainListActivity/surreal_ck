use super::*;
use nsh_base::{SelectItem, SelectValue, select};
use std::sync::Arc;
use surreal_ck_native_call::devices::{self, DeviceKind, Inventory, Permission};

#[cfg(test)]
#[path = "device_selector_tests.rs"]
mod tests;

pub(super) trait DeviceAccess: Send + Sync {
    fn inventory(&self) -> Inventory;
    fn request(&self, kind: DeviceKind, result: Sender<Inventory>);
}

pub(super) struct NativeAccess;
impl DeviceAccess for NativeAccess {
    fn inventory(&self) -> Inventory {
        devices::discover()
    }

    fn request(&self, kind: DeviceKind, result: Sender<Inventory>) {
        devices::request_access(kind, move |inventory| {
            let _ = result.try_send(inventory);
        });
    }
}

fn source(kind: DeviceKind) -> Source {
    match kind {
        DeviceKind::Camera => Source::Camera,
        DeviceKind::Microphone => Source::Microphone,
    }
}

impl CallUi {
    fn update_devices(self, inventory: Inventory) {
        for kind in [DeviceKind::Camera, DeviceKind::Microphone] {
            let selection = self.selections[index(source(kind))];
            let selected = selection.get_untracked();
            if inventory.permission(kind) != Permission::Authorized
                || !inventory
                    .devices
                    .iter()
                    .any(|d| d.id == selected && d.kind == kind)
            {
                selection.set(String::new());
            }
        }
        self.devices.set(inventory);
    }

    pub(super) fn mac_device_selector(
        self,
        kind: DeviceKind,
        access: Arc<dyn DeviceAccess>,
    ) -> impl IntoElement {
        self.update_devices(access.inventory());
        let selection = self.selections[index(source(kind))];
        let refresh_access = access.clone();
        let refresh = move || self.update_devices(refresh_access.inventory());
        let request_label = match kind {
            DeviceKind::Camera => "请求摄像头权限",
            DeviceKind::Microphone => "请求麦克风权限",
        };
        view()
            .gap_1()
            .child(
                select()
                    .items(move || {
                        let inventory = self.devices.get();
                        inventory.devices.iter().filter(|d| d.kind == kind).map(|d| {
                            SelectItem::new(d.id.clone(), d.name.clone())
                                .disabled(inventory.permission(kind) != Permission::Authorized)
                        }).collect::<Vec<_>>()
                    })
                    .value(move || SelectValue::Controlled(
                        (!selection.get().is_empty()).then(|| selection.get().into()),
                    ))
                    .trigger(view().px_3().py_2().rounded(px(8.0)).bg(move || theme().muted)
                        .child(text(move || {
                            self.devices.get().devices.iter()
                                .find(|d| d.id == selection.get() && d.kind == kind)
                                .map(|d| d.name.clone())
                                .unwrap_or_else(|| "选择设备 ▾".into())
                        }).text_color(move || theme().foreground)))
                    .on_open(refresh.clone())
                    .on_change(move |value: &Option<SharedString>| {
                        selection.set(value.as_ref().map(|value| value.to_string()).unwrap_or_default())
                    }),
            )
            .child(when(
                move || self.devices.get().permission(kind) == Permission::NotDetermined,
                move || {
                    let access = access.clone();
                    ui::action(request_label, move || self.device_permission_pending.get(), move || {
                        if self.device_permission_pending.get_untracked()
                            || self.devices.get_untracked().permission(kind) != Permission::NotDetermined
                        {
                            return;
                        }
                        self.device_permission_pending.set(true);
                        let (result, completion) = async_channel::bounded(1);
                        access.request(kind, result);
                        spawn(async move {
                            match completion.recv().await {
                                Ok(inventory) => self.update_devices(inventory),
                                Err(_) => self.status.set("权限请求未完成；请刷新设备列表后重试。".into()),
                            }
                            self.device_permission_pending.set(false);
                        });
                    })
                },
            ))
            .child(when(
                move || matches!(self.devices.get().permission(kind), Permission::Denied | Permission::Restricted),
                move || text(match kind {
                    DeviceKind::Camera => "请前往「系统设置 → 隐私与安全性 → 摄像头」允许访问，然后刷新设备列表；受管理设备可能需要联系管理员。",
                    DeviceKind::Microphone => "请前往「系统设置 → 隐私与安全性 → 麦克风」允许访问，然后刷新设备列表；受管理设备可能需要联系管理员。",
                }).text_color(move || theme().muted_foreground),
            ))
            .child(when(
                move || self.device_permission_pending.get(),
                move || text("等待系统权限结果；授权不会自动开启采集。")
                    .text_color(move || theme().muted_foreground),
            ))
            .child(ui::action("刷新设备列表", move || self.device_permission_pending.get(), refresh))
            .child(text(move || {
                let inventory = self.devices.get();
                format!("{} · {} 个设备；热插拔后刷新，开始时重新核对映射",
                    inventory.permission(kind).label(),
                    inventory.devices.iter().filter(|d| d.kind == kind).count())
            }).text_color(move || theme().muted_foreground))
    }
}
