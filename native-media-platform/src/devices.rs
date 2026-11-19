//! 稳定设备标识与 FFmpeg 的本次枚举索引分离；不申请权限、不选择默认设备。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceKind {
    Camera,
    Microphone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    NotDetermined,
    Restricted,
    Denied,
    Authorized,
    Unavailable,
}
impl Permission {
    pub fn label(self) -> &'static str {
        match self {
            Self::NotDetermined => "尚未授权",
            Self::Restricted => "系统限制",
            Self::Denied => "已拒绝",
            Self::Authorized => "已授权",
            Self::Unavailable => "不可用",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub kind: DeviceKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inventory {
    pub devices: Vec<Device>,
    pub camera: Permission,
    pub microphone: Permission,
}
impl Inventory {
    pub fn permission(&self, kind: DeviceKind) -> Permission {
        match kind {
            DeviceKind::Camera => self.camera,
            DeviceKind::Microphone => self.microphone,
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::rc::autoreleasepool;
    use objc2_av_foundation::*;
    use objc2_foundation::NSArray;

    pub fn discover() -> Inventory {
        autoreleasepool(|_| unsafe {
            #[allow(deprecated)]
            let types = NSArray::from_slice(&[
                AVCaptureDeviceTypeBuiltInWideAngleCamera,
                AVCaptureDeviceTypeExternalUnknown,
                AVCaptureDeviceTypeBuiltInMicrophone,
            ]);
            let discovery =
                AVCaptureDeviceDiscoverySession::discoverySessionWithDeviceTypes_mediaType_position(
                    &types,
                    None,
                    AVCaptureDevicePosition::Unspecified,
                );
            let devices = discovery
                .devices()
                .iter()
                .filter_map(|device| {
                    let kind = if AVMediaTypeVideo.is_some_and(|media| device.hasMediaType(media)) {
                        DeviceKind::Camera
                    } else if AVMediaTypeAudio.is_some_and(|media| device.hasMediaType(media)) {
                        DeviceKind::Microphone
                    } else {
                        return None;
                    };
                    Some(Device {
                        id: device.uniqueID().to_string(),
                        name: device.localizedName().to_string(),
                        kind,
                    })
                })
                .collect();
            let permission = |media| match AVCaptureDevice::authorizationStatusForMediaType(media).0
            {
                0 => Permission::NotDetermined,
                1 => Permission::Restricted,
                2 => Permission::Denied,
                3 => Permission::Authorized,
                _ => Permission::Unavailable,
            };
            Inventory {
                devices,
                camera: AVMediaTypeVideo.map_or(Permission::Unavailable, permission),
                microphone: AVMediaTypeAudio.map_or(Permission::Unavailable, permission),
            }
        })
    }
}

#[cfg(target_os = "macos")]
pub use macos::discover;

#[cfg(not(target_os = "macos"))]
pub fn discover() -> Inventory {
    Inventory {
        devices: Vec::new(),
        camera: Permission::Unavailable,
        microphone: Permission::Unavailable,
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FfmpegDevice {
    kind: DeviceKind,
    index: u32,
    name: String,
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn parse_ffmpeg(log: &str) -> Vec<FfmpegDevice> {
    let mut kind = None;
    let mut result = Vec::new();
    for line in log.lines() {
        if line.contains("AVFoundation video devices:") {
            kind = Some(DeviceKind::Camera);
            continue;
        }
        if line.contains("AVFoundation audio devices:") {
            kind = Some(DeviceKind::Microphone);
            continue;
        }
        let Some(kind) = kind else {
            continue;
        };
        let Some((_, entry)) = line.rsplit_once('[') else {
            continue;
        };
        let Some((index, name)) = entry.split_once("] ") else {
            continue;
        };
        let Ok(index) = index.parse() else {
            continue;
        };
        if !name.is_empty() && result.len() < 256 {
            result.push(FfmpegDevice {
                kind,
                index,
                name: name.into(),
            });
        }
    }
    result
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn map_index(
    inventory: &Inventory,
    ffmpeg: &[FfmpegDevice],
    id: &str,
    kind: DeviceKind,
) -> Option<u32> {
    if inventory.permission(kind) != Permission::Authorized {
        return None;
    }
    let device = inventory
        .devices
        .iter()
        .find(|device| device.id == id && device.kind == kind)?;
    if inventory
        .devices
        .iter()
        .filter(|other| other.kind == kind && other.name == device.name)
        .count()
        != 1
    {
        return None;
    }
    let mut matches = ffmpeg
        .iter()
        .filter(|other| other.kind == kind && other.name == device.name);
    let found = matches.next()?;
    if matches.next().is_some()
        || ffmpeg
            .iter()
            .filter(|other| other.kind == kind && other.index == found.index)
            .count()
            != 1
    {
        return None;
    }
    Some(found.index)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn inventory() -> Inventory {
        Inventory {
            devices: vec![Device {
                id: "stable-camera".into(),
                name: "USB Camera".into(),
                kind: DeviceKind::Camera,
            }],
            camera: Permission::Authorized,
            microphone: Permission::Denied,
        }
    }
    #[test]
    fn maps_names_in_actual_ffmpeg_order_not_discovery_order() {
        let log = "[avf @ 0x1] AVFoundation video devices:\n[avf @ 0x1] [2] USB Camera\n[avf @ 0x1] [3] Capture screen 0\n[avf @ 0x1] AVFoundation audio devices:\n[avf @ 0x1] [0] USB Camera";
        let parsed = parse_ffmpeg(log);
        assert_eq!(
            map_index(&inventory(), &parsed, "stable-camera", DeviceKind::Camera),
            Some(2)
        );
        assert_eq!(
            map_index(
                &inventory(),
                &parsed,
                "stable-camera",
                DeviceKind::Microphone
            ),
            None
        );
        let moved = parse_ffmpeg(&log.replace("[2] USB", "[0] USB"));
        assert_eq!(
            map_index(&inventory(), &moved, "stable-camera", DeviceKind::Camera),
            Some(0)
        );
    }
    #[test]
    fn empty_removed_denied_and_ambiguous_devices_never_fall_back() {
        let parsed = parse_ffmpeg("AVFoundation video devices:\n[0] USB Camera");
        let mut inventory = inventory();
        assert_eq!(
            map_index(&inventory, &[], "stable-camera", DeviceKind::Camera),
            None
        );
        assert_eq!(
            map_index(&inventory, &parsed, "removed", DeviceKind::Camera),
            None
        );
        inventory.camera = Permission::Denied;
        assert_eq!(
            map_index(&inventory, &parsed, "stable-camera", DeviceKind::Camera),
            None
        );
        inventory.camera = Permission::Authorized;
        inventory.devices.push(Device {
            id: "other".into(),
            ..inventory.devices[0].clone()
        });
        assert_eq!(
            map_index(&inventory, &parsed, "stable-camera", DeviceKind::Camera),
            None
        );
        inventory.devices.pop();
        let duplicate = parse_ffmpeg("AVFoundation video devices:\n[0] USB Camera\n[1] USB Camera");
        assert_eq!(
            map_index(&inventory, &duplicate, "stable-camera", DeviceKind::Camera),
            None
        );
        assert!(parse_ffmpeg("[0] USB Camera\nmalformed").is_empty());
    }
}
