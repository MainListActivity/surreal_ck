use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JClass, JObject},
    sys::jboolean,
};
use std::sync::OnceLock;

static HOST: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "system" fn Java_top_maplayer_collaboration_roster_RosterSfuProvider_initialize(
    env: JNIEnv<'_>,
    class: JClass<'_>,
    context: JObject<'_>,
) -> jboolean {
    let result = (|| {
        let vm = env.get_java_vm()?;
        let class = env.new_global_ref(class)?;
        if !livekit::webrtc::android::initialize_android_context(&vm, &context) {
            return Ok::<_, jni::errors::Error>(false);
        }
        let _ = HOST.set((vm, class));
        Ok(true)
    })();
    if result.is_err() {
        let _ = env.exception_clear();
    }
    u8::from(result.unwrap_or(false))
}

pub fn ensure_linked() {
    std::hint::black_box(
        Java_top_maplayer_collaboration_roster_RosterSfuProvider_initialize as *const (),
    );
}

pub(crate) fn ready() -> bool {
    HOST.get().is_some()
}

pub(crate) fn request_microphone() -> bool {
    let Some((vm, class)) = HOST.get() else {
        return false;
    };
    let Ok(mut env) = vm.attach_current_thread() else {
        return false;
    };
    let class: &JClass<'_> = class.as_obj().into();
    let result = env
        .call_static_method(class, "requestMicrophone", "()Z", &[])
        .and_then(|value| value.z());
    if result.is_err() {
        let _ = env.exception_clear();
    }
    result.unwrap_or(false)
}
