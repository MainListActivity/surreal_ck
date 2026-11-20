//! SAF bridge. Requests are explicit user actions; polling never treats a pending request as success.
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JClass, JObject, JString, JValue},
    sys::jboolean,
};
use std::sync::OnceLock;

struct Host {
    vm: JavaVM,
    context: GlobalRef,
    class: GlobalRef,
}
static HOST: OnceLock<Host> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "system" fn Java_top_maplayer_collaboration_documents_DocumentInitProvider_initialize(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    context: JObject<'_>,
) -> jboolean {
    let result = (|| -> jni::errors::Result<()> {
        let class = env.find_class("top/maplayer/collaboration/documents/DocumentBridge")?;
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

pub fn ensure_linked() {
    std::hint::black_box(
        Java_top_maplayer_collaboration_documents_DocumentInitProvider_initialize as *const (),
    );
}

/// Call only following a user's foreground file-selection action.
pub fn open() -> Result<i64, String> {
    request(None)
}
/// Only a completed, verified file under Android's real filesDir can be exported.
pub fn save(path: &str) -> Result<i64, String> {
    request(Some(path))
}
fn request(path: Option<&str>) -> Result<i64, String> {
    let host = HOST.get().ok_or("Android document host is unavailable")?;
    let mut env = host.vm.attach_current_thread().map_err(|e| e.to_string())?;
    let result = (|| -> jni::errors::Result<i64> {
        let class: &JClass<'_> = host.class.as_obj().into();
        match path {
            Some(path) => {
                let path = env.new_string(path)?;
                env.call_static_method(
                    class,
                    "save",
                    "(Landroid/content/Context;Ljava/lang/String;)J",
                    &[
                        JValue::Object(host.context.as_obj()),
                        JValue::Object(path.as_ref()),
                    ],
                )?
                .j()
            }
            None => env
                .call_static_method(
                    class,
                    "open",
                    "(Landroid/content/Context;)J",
                    &[JValue::Object(host.context.as_obj())],
                )?
                .j(),
        }
    })();
    result.map_err(|e| {
        let _ = env.exception_clear();
        format!("Document request failed: {e}")
    })
}

/// None is pending. Terminal JSON has state imported/exported/cancelled/failed and is consumed once.
pub fn poll(id: i64) -> Result<Option<String>, String> {
    let host = HOST.get().ok_or("Android document host is unavailable")?;
    let mut env = host.vm.attach_current_thread().map_err(|e| e.to_string())?;
    let result = (|| -> jni::errors::Result<String> {
        let class: &JClass<'_> = host.class.as_obj().into();
        let value = env
            .call_static_method(class, "poll", "(J)Ljava/lang/String;", &[JValue::Long(id)])?
            .l()?;
        let value = JString::from(value);
        let text: String = env.get_string(&value)?.into();
        Ok(text)
    })();
    result
        .map(|s| if s.is_empty() { None } else { Some(s) })
        .map_err(|e| {
            let _ = env.exception_clear();
            format!("Document result failed: {e}")
        })
}

pub fn available() -> bool {
    HOST.get().is_some()
}

/// Releases only a Java-validated, app-owned SAF import copy, never the source content URI.
pub fn release_import(path: &str) -> Result<(), String> {
    let host = HOST.get().ok_or("Android document host is unavailable")?;
    let mut env = host.vm.attach_current_thread().map_err(|e| e.to_string())?;
    let result = (|| -> jni::errors::Result<bool> {
        let class: &JClass<'_> = host.class.as_obj().into();
        let path = env.new_string(path)?;
        env.call_static_method(
            class,
            "release",
            "(Landroid/content/Context;Ljava/lang/String;)Z",
            &[
                JValue::Object(host.context.as_obj()),
                JValue::Object(path.as_ref()),
            ],
        )?
        .z()
    })();
    match result {
        Ok(true) => Ok(()),
        Ok(false) => Err("导入缓存未释放，保留至下次清理".into()),
        Err(error) => {
            let _ = env.exception_clear();
            Err(format!("导入缓存清理失败：{error}"))
        }
    }
}
