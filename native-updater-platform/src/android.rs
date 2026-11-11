//! Context由非导出ContentProvider在Java线程初始化；不替换NSH的JNI_OnLoad。
use crate::{Error, InstallRequest, InstallState};
use jni::{
    objects::{GlobalRef, JClass, JObject, JString, JValue},
    sys::jboolean,
    JNIEnv, JavaVM,
};
use std::{path::PathBuf, sync::OnceLock};
struct Host {
    vm: JavaVM,
    context: GlobalRef,
    bridge: GlobalRef,
}
static HOST: OnceLock<Host> = OnceLock::new();
#[no_mangle]
pub extern "system" fn Java_top_maplayer_collaboration_update_UpdaterInitProvider_initialize(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    context: JObject<'_>,
) -> jboolean {
    let result = (|| -> jni::errors::Result<()> {
        let vm = env.get_java_vm()?;
        let context = env.new_global_ref(context)?;
        let class = env.find_class("top/maplayer/collaboration/update/RequiredUpdater")?;
        let bridge = env.new_global_ref(class)?;
        let _ = HOST.set(Host {
            vm,
            context,
            bridge,
        });
        Ok(())
    })();
    if result.is_err() {
        let _ = env.exception_clear();
        0
    } else {
        1
    }
}
pub fn private_data_dir() -> Option<PathBuf> {
    let host = HOST.get()?;
    let mut env = host.vm.attach_current_thread().ok()?;
    let result = (|| -> jni::errors::Result<PathBuf> {
        let class: &JClass<'_> = host.bridge.as_obj().into();
        let value = env
            .call_static_method(
                class,
                "privateDataDirectory",
                "(Landroid/content/Context;)Ljava/lang/String;",
                &[JValue::Object(host.context.as_obj())],
            )?
            .l()?;
        let value = JString::from(value);
        let text: String = env.get_string(&value)?.into();
        Ok(PathBuf::from(text))
    })();
    if result.is_err() {
        let _ = env.exception_clear();
    }
    result.ok().filter(|path| path.is_absolute())
}
pub fn start(request: &InstallRequest<'_>) -> Result<InstallState, Error> {
    if request.release().platform != "android" {
        return Err(Error::UnsupportedPlatform);
    }
    let host = HOST.get().ok_or(Error::BridgeUnavailable)?;
    let mut env = host
        .vm
        .attach_current_thread()
        .map_err(|_| Error::BridgeUnavailable)?;
    let result = (|| -> jni::errors::Result<i32> {
        let class: &JClass<'_> = host.bridge.as_obj().into();
        let allowed = env
            .call_static_method(
                class,
                "installationAllowed",
                "(Landroid/content/Context;)Z",
                &[JValue::Object(host.context.as_obj())],
            )?
            .z()?;
        if !allowed {
            return Ok(-2);
        }
        let bytes = env.byte_array_from_slice(request.bytes())?;
        let hash = env.new_string(&request.release().sha256)?;
        let signer = env.new_string(&request.release().publisher)?;
        let version = env.new_string(&request.release().version)?;
        let class: &JClass<'_> = host.bridge.as_obj().into();
        env.call_static_method(
            class,
            "install",
            "(Landroid/content/Context;[BLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)I",
            &[
                JValue::Object(host.context.as_obj()),
                JValue::Object(bytes.as_ref()),
                JValue::Object(hash.as_ref()),
                JValue::Object(signer.as_ref()),
                JValue::Object(version.as_ref()),
            ],
        )?
        .i()
    })();
    match result {
        Ok(id) if id >= 0 => Ok(InstallState::Started),
        Ok(-2) => Ok(InstallState::PendingSystemConsent),
        _ => {
            let _ = env.exception_clear();
            Err(Error::BridgeUnavailable)
        }
    }
}
