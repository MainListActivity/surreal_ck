//! Android Java host, generation-bound callbacks and bounded encoded-frame handoff.
//! Opening controls never grants permission or starts capture. Snapshot is authoritative.
use bytes::Bytes;
use jni::{
    objects::{GlobalRef, JByteArray, JClass, JObject, JString, JValue},
    sys::{jboolean, jint, jlong},
    JNIEnv, JavaVM,
};
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Microphone,
    Camera,
    Screen,
}
impl Source {
    fn index(self) -> usize {
        match self {
            Self::Microphone => 0,
            Self::Camera => 1,
            Self::Screen => 2,
        }
    }
}
fn source(value: i32) -> Option<Source> {
    match value {
        0 => Some(Source::Microphone),
        1 => Some(Source::Camera),
        2 => Some(Source::Screen),
        _ => None,
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CaptureStatus {
    #[default]
    Stopped,
    Starting,
    Stopping,
    Running,
    Unconfirmed,
}
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub states: [CaptureStatus; 3],
    pub revisions: [u64; 3],
    pub closed: bool,
    pub error: Option<String>,
}
#[derive(Debug)]
pub enum Event {
    Frame {
        source: Source,
        timestamp_us: u64,
        keyframe: bool,
        data: Bytes,
    },
    State {
        source: Source,
        running: bool,
    },
    Error {
        source: Option<Source>,
        message: String,
    },
    Closed,
}
struct Host {
    vm: JavaVM,
    context: GlobalRef,
    class: GlobalRef,
}
static HOST: OnceLock<Host> = OnceLock::new();
const MAX_BYTES: usize = 8 * 1024 * 1024;
#[derive(Default)]
struct Session {
    id: u64,
    snapshot: Snapshot,
    queue: VecDeque<Event>,
    bytes: usize,
}
impl Session {
    fn accepts(&self, id: u64, source: Source, len: usize) -> bool {
        let limit = if source == Source::Microphone {
            1275
        } else {
            4 * 1024 * 1024
        };
        self.id == id
            && !self.snapshot.closed
            && self.snapshot.states[source.index()] == CaptureStatus::Running
            && len > 0
            && len <= limit
            && self.bytes.saturating_add(len) <= MAX_BYTES
            && self.queue.len() < 64
    }
    fn state(&mut self, source: Source, status: CaptureStatus) {
        let at = source.index();
        if self.snapshot.states[at] != status {
            self.queue
                .retain(|event| !matches!(event,Event::Frame{source:old,..} if *old==source));
            self.bytes = self
                .queue
                .iter()
                .map(|event| match event {
                    Event::Frame { data, .. } => data.len(),
                    _ => 0,
                })
                .sum();
        }
        self.snapshot.states[at] = status;
        self.snapshot.revisions[at] = self.snapshot.revisions[at].wrapping_add(1);
        if self.queue.len() < 64 {
            self.queue.push_back(Event::State {
                source,
                running: status == CaptureStatus::Running,
            });
        }
    }
    fn close(&mut self, id: u64) -> bool {
        if self.id != id
            || self
                .snapshot
                .states
                .iter()
                .any(|s| *s != CaptureStatus::Stopped)
        {
            return false;
        }
        self.snapshot.closed = true;
        self.queue.clear();
        self.bytes = 0;
        self.queue.push_back(Event::Closed);
        true
    }
}
static SESSION: Mutex<Session> = Mutex::new(Session {
    id: 0,
    snapshot: Snapshot {
        states: [CaptureStatus::Stopped; 3],
        revisions: [0; 3],
        closed: true,
        error: None,
    },
    queue: VecDeque::new(),
    bytes: 0,
});
fn lock() -> std::sync::MutexGuard<'static, Session> {
    SESSION.lock().unwrap_or_else(|p| p.into_inner())
}
#[no_mangle]
pub extern "system" fn Java_top_maplayer_collaboration_media_MediaInitProvider_initialize(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    context: JObject<'_>,
) -> jboolean {
    let result = (|| -> jni::errors::Result<()> {
        let class = env.find_class("top/maplayer/collaboration/media/MediaBridge")?;
        let host = Host {
            vm: env.get_java_vm()?,
            context: env.new_global_ref(context)?,
            class: env.new_global_ref(class)?,
        };
        let _ = HOST.set(host);
        Ok(())
    })();
    if result.is_err() {
        let _ = env.exception_clear();
        0
    } else {
        1
    }
}
#[no_mangle]
pub extern "system" fn Java_top_maplayer_collaboration_media_MediaBridge_nativeFrame(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    id: jlong,
    kind: jint,
    data: JByteArray<'_>,
    pts: jlong,
    key: jboolean,
) -> jboolean {
    let Some(source) = source(kind) else { return 0 };
    if pts < 0 {
        return 0;
    }
    let Ok(length) = env.get_array_length(&data) else {
        return 0;
    };
    let limit = if source == Source::Microphone {
        1275
    } else {
        4 * 1024 * 1024
    };
    if length <= 0 || length > limit {
        return 0;
    }
    let mut s = lock();
    if !s.accepts(id as u64, source, length as usize) {
        return 0;
    }
    let Ok(data) = env.convert_byte_array(data) else {
        return 0;
    };
    s.bytes += data.len();
    s.queue.push_back(Event::Frame {
        source,
        timestamp_us: pts as u64,
        keyframe: key != 0,
        data: Bytes::from(data),
    });
    1
}
#[no_mangle]
pub extern "system" fn Java_top_maplayer_collaboration_media_MediaBridge_nativeState(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    id: jlong,
    kind: jint,
    state: jint,
    detail: JString<'_>,
) {
    let Some(source) = source(kind) else { return };
    let status = match state {
        0 => CaptureStatus::Stopped,
        1 => CaptureStatus::Running,
        2 => CaptureStatus::Starting,
        4 => CaptureStatus::Stopping,
        _ => CaptureStatus::Unconfirmed,
    };
    let mut s = lock();
    if s.id != id as u64 || s.snapshot.closed {
        return;
    }
    s.state(source, status);
    if !detail.is_null() {
        if let Ok(text) = env.get_string(&detail) {
            let text: String = text.into();
            if !text.is_empty() {
                s.snapshot.error = Some(text.chars().take(1024).collect());
            }
            if !text.is_empty() && s.queue.len() < 64 {
                s.queue.push_back(Event::Error {
                    source: Some(source),
                    message: text.chars().take(1024).collect(),
                });
            }
        }
    }
}
#[no_mangle]
pub extern "system" fn Java_top_maplayer_collaboration_media_MediaBridge_nativeClosed(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    id: jlong,
) {
    let mut s = lock();
    s.close(id as u64);
}
#[no_mangle]
pub extern "system" fn Java_top_maplayer_collaboration_media_MediaBridge_nativeError(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    id: jlong,
    kind: jint,
    detail: JString<'_>,
) {
    let mut s = lock();
    if s.id != id as u64 || s.snapshot.closed {
        return;
    }
    if let Ok(text) = env.get_string(&detail) {
        let text: String = text.into();
        s.snapshot.error = Some(text.chars().take(1024).collect());
        if s.queue.len() < 64 {
            s.queue.push_back(Event::Error {
                source: source(kind),
                message: text.chars().take(1024).collect(),
            });
        }
    }
}
pub fn ensure_linked() {
    std::hint::black_box(
        Java_top_maplayer_collaboration_media_MediaBridge_nativeError as *const (),
    );
    std::hint::black_box(
        Java_top_maplayer_collaboration_media_MediaInitProvider_initialize as *const (),
    );
    std::hint::black_box(
        Java_top_maplayer_collaboration_media_MediaBridge_nativeFrame as *const (),
    );
    std::hint::black_box(
        Java_top_maplayer_collaboration_media_MediaBridge_nativeState as *const (),
    );
    std::hint::black_box(
        Java_top_maplayer_collaboration_media_MediaBridge_nativeClosed as *const (),
    );
}
pub fn available() -> bool {
    HOST.get().is_some()
}
pub fn begin() -> Result<u64, String> {
    if !available() {
        return Err("Android media host unavailable".into());
    }
    let mut s = lock();
    if !s.snapshot.closed {
        return Err("Previous Android media session has not confirmed shutdown".into());
    }
    let id =
        s.id.checked_add(1)
            .filter(|id| *id <= i64::MAX as u64)
            .ok_or("Session generation exhausted")?;
    *s = Session {
        id,
        snapshot: Snapshot::default(),
        ..Default::default()
    };
    drop(s);
    if let Err(error) = with_env(id, |h, e| {
        let class: &JClass<'_> = h.class.as_obj().into();
        e.call_static_method(class, "prepare", "(J)V", &[JValue::Long(id as i64)])?;
        Ok(())
    }) {
        // Preserve the generation and require Java to confirm closure; never silently reuse it.
        let _ = stop(id);
        return Err(error);
    }
    Ok(id)
}
pub fn snapshot(id: u64) -> Result<Snapshot, String> {
    let s = lock();
    if s.id != id {
        return Err("Stale media session".into());
    }
    Ok(s.snapshot.clone())
}
pub fn poll(id: u64) -> Result<Option<Event>, String> {
    let mut s = lock();
    if s.id != id {
        return Err("Stale media session".into());
    }
    let event = s.queue.pop_front();
    if let Some(Event::Frame { data, .. }) = &event {
        s.bytes -= data.len();
    }
    Ok(event)
}
fn with_env<T>(
    id: u64,
    f: impl FnOnce(&Host, &mut JNIEnv<'_>) -> jni::errors::Result<T>,
) -> Result<T, String> {
    let s = lock();
    if s.id != id || s.snapshot.closed {
        return Err("Media session closed or stale".into());
    }
    drop(s);
    let host = HOST.get().ok_or("Android media host unavailable")?;
    let mut env = host.vm.attach_current_thread().map_err(|e| e.to_string())?;
    f(host, &mut env).map_err(|e| {
        let _ = env.exception_clear();
        format!("Android media bridge: {e}")
    })
}
pub fn show(id: u64) -> Result<(), String> {
    with_env(id, |h, e| {
        let class: &JClass<'_> = h.class.as_obj().into();
        e.call_static_method(
            class,
            "open",
            "(Landroid/content/Context;J)V",
            &[JValue::Object(h.context.as_obj()), JValue::Long(id as i64)],
        )?;
        Ok(())
    })
}
/// This requests release; callers must observe snapshot.closed before reporting stopped.
pub fn stop(id: u64) -> Result<(), String> {
    with_env(id, |h, e| {
        let class: &JClass<'_> = h.class.as_obj().into();
        e.call_static_method(
            class,
            "stop",
            "(Landroid/content/Context;J)V",
            &[JValue::Object(h.context.as_obj()), JValue::Long(id as i64)],
        )?;
        Ok(())
    })
}
pub fn request_keyframe(id: u64, source: Source) -> Result<(), String> {
    with_env(id, |h, e| {
        let class: &JClass<'_> = h.class.as_obj().into();
        e.call_static_method(
            class,
            "keyframe",
            "(JI)V",
            &[JValue::Long(id as i64), JValue::Int(source.index() as i32)],
        )?;
        Ok(())
    })
}
/// Accepted into a bounded render queue is not proof of a displayed frame/audible output.
pub fn present(id: u64, source: Source, timestamp_us: u64, data: &[u8]) -> Result<bool, String> {
    if data.is_empty()
        || data.len()
            > if source == Source::Microphone {
                1275
            } else {
                4 * 1024 * 1024
            }
        || timestamp_us > i64::MAX as u64
    {
        return Err("Invalid media frame".into());
    }
    with_env(id, |h, e| {
        let class: &JClass<'_> = h.class.as_obj().into();
        let bytes = e.byte_array_from_slice(data)?;
        e.call_static_method(
            class,
            "present",
            "(JI[BJ)Z",
            &[
                JValue::Long(id as i64),
                JValue::Int(source.index() as i32),
                JValue::Object(bytes.as_ref()),
                JValue::Long(timestamp_us as i64),
            ],
        )?
        .z()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generation_permission_and_byte_bounds() {
        let mut s = Session {
            id: 7,
            ..Default::default()
        };
        assert!(!s.accepts(7, Source::Camera, 100));
        s.state(Source::Camera, CaptureStatus::Starting);
        assert!(!s.accepts(7, Source::Camera, 100));
        s.state(Source::Camera, CaptureStatus::Running);
        assert!(s.accepts(7, Source::Camera, 100));
        assert!(!s.accepts(6, Source::Camera, 100));
        assert!(!s.accepts(7, Source::Camera, 0));
        assert!(!s.accepts(7, Source::Camera, 4 * 1024 * 1024 + 1));
        s.bytes = MAX_BYTES - 99;
        assert!(!s.accepts(7, Source::Camera, 100));
        s.bytes = 0;
        s.snapshot.closed = true;
        assert!(!s.accepts(7, Source::Camera, 100));
    }
    #[test]
    fn privacy_snapshot_survives_full_queue_and_stale_frames_are_removed() {
        let mut s = Session {
            id: 1,
            ..Default::default()
        };
        s.state(Source::Camera, CaptureStatus::Running);
        s.queue.push_back(Event::Frame {
            source: Source::Camera,
            timestamp_us: 0,
            keyframe: true,
            data: Bytes::from_static(b"old"),
        });
        s.bytes = 3;
        for _ in 0..63 {
            s.queue.push_back(Event::State {
                source: Source::Microphone,
                running: false,
            });
        }
        let before = s.snapshot.revisions[1];
        s.state(Source::Camera, CaptureStatus::Stopped);
        assert_eq!(s.snapshot.states[1], CaptureStatus::Stopped);
        assert!(s.snapshot.revisions[1] > before);
        assert_eq!(s.bytes, 0);
        assert!(!s.queue.iter().any(|e| matches!(e, Event::Frame { .. })));
        s.state(Source::Camera, CaptureStatus::Running);
        assert!(!s.queue.iter().any(|e| matches!(e, Event::Frame { .. })));
    }
    #[test]
    fn unconfirmed_release_never_becomes_closed() {
        let mut s = Session {
            id: 9,
            ..Default::default()
        };
        s.state(Source::Microphone, CaptureStatus::Unconfirmed);
        assert!(!s.close(9));
        assert!(!s.snapshot.closed);
        s.state(Source::Microphone, CaptureStatus::Stopped);
        assert!(!s.close(8));
        assert!(s.close(9));
        assert!(s.snapshot.closed);
    }
}
