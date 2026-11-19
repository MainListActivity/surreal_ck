use super::*;
use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use surreal_ck_native_call::devices::Device;

static TEST_LOCK: Mutex<()> = Mutex::new(());
static FIXTURE: Mutex<Option<Arc<FakeAccess>>> = Mutex::new(None);

struct FakeAccess {
    kind: DeviceKind,
    inventory: Mutex<Inventory>,
    pending: Mutex<Option<Sender<Inventory>>>,
    requests: AtomicUsize,
}

impl FakeAccess {
    fn inventory_with(&self, permission: Permission, count: usize) -> Inventory {
        Inventory {
            camera: if self.kind == DeviceKind::Camera {
                permission
            } else {
                Permission::Authorized
            },
            microphone: if self.kind == DeviceKind::Microphone {
                permission
            } else {
                Permission::Authorized
            },
            devices: (0..count)
                .map(|_| Device {
                    id: "stable-device".into(),
                    name: "Test Device".into(),
                    kind: self.kind,
                })
                .collect(),
        }
    }

    fn complete(&self, permission: Permission, count: usize) {
        let inventory = self.inventory_with(permission, count);
        *self.inventory.lock().unwrap() = inventory.clone();
        self.pending
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .try_send(inventory)
            .unwrap();
    }
}

impl DeviceAccess for FakeAccess {
    fn inventory(&self) -> Inventory {
        self.inventory.lock().unwrap().clone()
    }

    fn request(&self, kind: DeviceKind, result: Sender<Inventory>) {
        assert_eq!(kind, self.kind);
        assert!(self.pending.lock().unwrap().replace(result).is_none());
        self.requests.fetch_add(1, Ordering::SeqCst);
    }
}

#[component]
fn PermissionFixture() -> impl IntoElement {
    let access = FIXTURE.lock().unwrap().take().unwrap();
    let ui = CallUi::new();
    let kind = access.kind;
    view()
        .child(ui.mac_device_selector(kind, access))
        .child(text(move || {
            format!("selection={}", ui.selections[index(source(kind))].get())
        }))
        .child(text(move || {
            format!("capture={:?}", ui.captures[index(source(kind))].get())
        }))
        .child(text(move || ui.status.get()))
}

fn fixture(kind: DeviceKind, permission: Permission, count: usize) -> (Headless, Arc<FakeAccess>) {
    let access = Arc::new(FakeAccess {
        kind,
        inventory: Mutex::new(Inventory {
            devices: Vec::new(),
            camera: Permission::NotDetermined,
            microphone: Permission::NotDetermined,
        }),
        pending: Mutex::new(None),
        requests: AtomicUsize::new(0),
    });
    *access.inventory.lock().unwrap() = access.inventory_with(permission, count);
    *FIXTURE.lock().unwrap() = Some(access.clone());
    let app = Headless::start(EngineConfig::new(Root::of::<PermissionFixture>())).unwrap();
    (app, access)
}

fn request_label(kind: DeviceKind) -> &'static str {
    match kind {
        DeviceKind::Camera => "请求摄像头权限",
        DeviceKind::Microphone => "请求麦克风权限",
    }
}

fn assert_not_capturing(app: &mut Headless) -> Result<(), String> {
    app.wait_for(
        "capture=CaptureState { active: false, request: None, close_unconfirmed: false }",
    )?;
    app.wait_for("selection=")
}

#[test]
fn explicit_permission_request_refreshes_devices_without_starting_capture() -> Result<(), String> {
    let _guard = TEST_LOCK.lock().unwrap();
    for kind in [DeviceKind::Camera, DeviceKind::Microphone] {
        let (mut app, access) = fixture(kind, Permission::NotDetermined, 1);
        let label = request_label(kind);
        app.wait_for(label)?;
        assert_eq!(access.requests.load(Ordering::SeqCst), 0);
        assert_not_capturing(&mut app)?;
        app.press(label)?;
        app.wait_for("等待系统权限结果；授权不会自动开启采集。")?;
        assert!(!app.screen().enabled(label)?);
        assert!(!app.screen().enabled("刷新设备列表")?);
        assert_eq!(access.requests.load(Ordering::SeqCst), 1);
        access.complete(Permission::Authorized, 1);
        app.wait_for("已授权 · 1 个设备；热插拔后刷新，开始时重新核对映射")?;
        assert!(!app.shows(label));
        assert_not_capturing(&mut app)?;
        app.press("选择设备 ▾")?;
        app.press("Test Device")?;
        app.wait_for("selection=stable-device")?;
        app.wait_for(
            "capture=CaptureState { active: false, request: None, close_unconfirmed: false }",
        )?;
    }
    Ok(())
}

#[test]
fn denied_and_restricted_permissions_guide_to_settings_and_can_refresh() -> Result<(), String> {
    let _guard = TEST_LOCK.lock().unwrap();
    for kind in [DeviceKind::Camera, DeviceKind::Microphone] {
        for permission in [Permission::Denied, Permission::Restricted] {
            let (mut app, access) = fixture(kind, permission, 0);
            let hint = match kind {
                DeviceKind::Camera => {
                    "请前往「系统设置 → 隐私与安全性 → 摄像头」允许访问，然后刷新设备列表；受管理设备可能需要联系管理员。"
                }
                DeviceKind::Microphone => {
                    "请前往「系统设置 → 隐私与安全性 → 麦克风」允许访问，然后刷新设备列表；受管理设备可能需要联系管理员。"
                }
            };
            app.wait_for(hint)?;
            assert!(!app.shows(request_label(kind)));
            assert_eq!(access.requests.load(Ordering::SeqCst), 0);
            *access.inventory.lock().unwrap() = access.inventory_with(Permission::Authorized, 0);
            app.press("刷新设备列表")?;
            app.wait_for("已授权 · 0 个设备；热插拔后刷新，开始时重新核对映射")?;
            assert!(!app.shows(hint));
            assert_not_capturing(&mut app)?;
        }
    }
    Ok(())
}

#[test]
fn denied_request_and_empty_grant_do_not_invent_devices_or_start_capture() -> Result<(), String> {
    let _guard = TEST_LOCK.lock().unwrap();
    for permission in [Permission::Denied, Permission::Authorized] {
        let (mut app, access) = fixture(DeviceKind::Camera, Permission::NotDetermined, 0);
        app.wait_for("请求摄像头权限")?;
        app.press("请求摄像头权限")?;
        access.complete(permission, 0);
        app.wait_for(&format!(
            "{} · 0 个设备；热插拔后刷新，开始时重新核对映射",
            permission.label()
        ))?;
        assert!(!app.shows("请求摄像头权限"));
        assert_not_capturing(&mut app)?;
    }
    Ok(())
}

#[test]
fn missing_permission_completion_releases_pending_state_for_retry() -> Result<(), String> {
    let _guard = TEST_LOCK.lock().unwrap();
    let (mut app, access) = fixture(DeviceKind::Camera, Permission::NotDetermined, 0);
    app.wait_for("请求摄像头权限")?;
    app.press("请求摄像头权限")?;
    access.pending.lock().unwrap().take();
    app.wait_for("权限请求未完成；请刷新设备列表后重试。")?;
    assert!(app.screen().enabled("请求摄像头权限")?);
    app.press("请求摄像头权限")?;
    assert_eq!(access.requests.load(Ordering::SeqCst), 2);
    access.complete(Permission::Authorized, 0);
    app.wait_for("已授权 · 0 个设备；热插拔后刷新，开始时重新核对映射")?;
    assert_not_capturing(&mut app)
}
