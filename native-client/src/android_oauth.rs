//! Experimental in-memory Android OAuth ingress. No callback persistence or gate bypass.
use jni::{
    JNIEnv, JavaVM,
    objects::{GlobalRef, JClass, JObject, JString, JValue},
    sys::jboolean,
};
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use surreal_ck_native_identity::{IdentityError, LoginAttempt};
use tokio::sync::mpsc;
use zeroize::Zeroizing;
#[path = "android_oauth_route.rs"]
mod route;
use route::Route;
const REDIRECT: &str = "top.maplayer.collaboration:/auth/callback";
struct Host {
    vm: JavaVM,
    context: GlobalRef,
    class: GlobalRef,
}
static HOST: OnceLock<Host> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);
static ACTIVE: Mutex<Route<mpsc::Sender<Zeroizing<String>>>> = Mutex::new(Route::new());
#[unsafe(no_mangle)]
pub extern "system" fn Java_top_maplayer_collaboration_auth_AuthInitProvider_initialize(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    context: JObject<'_>,
) -> jboolean {
    let result = (|| -> jni::errors::Result<()> {
        let class = env.find_class("top/maplayer/collaboration/auth/AuthBridge")?;
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
#[unsafe(no_mangle)]
pub extern "system" fn Java_top_maplayer_collaboration_auth_AuthBridge_callback(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    uri: JString<'_>,
) -> jboolean {
    let result = (|| -> Option<()> {
        let active = ACTIVE.lock().ok()?;
        let sender = active.current()?;
        let chars = env.call_method(&uri, "length", "()I", &[]).ok()?.i().ok()?;
        if !(1..=16384).contains(&chars) {
            return None;
        }
        let raw = Zeroizing::new(String::from(env.get_string(&uri).ok()?));
        if raw.len() > 16384
            || !raw.starts_with("top.maplayer.collaboration:/auth/callback?")
            || raw.contains('#')
        {
            return None;
        }
        sender.try_send(raw).ok()
    })();
    let _ = env.exception_clear();
    u8::from(result.is_some())
}
pub fn ensure_linked() {
    std::hint::black_box(
        Java_top_maplayer_collaboration_auth_AuthInitProvider_initialize as *const (),
    );
    std::hint::black_box(Java_top_maplayer_collaboration_auth_AuthBridge_callback as *const ());
}
pub struct AndroidReceiver {
    id: u64,
    receiver: mpsc::Receiver<Zeroizing<String>>,
    authorization: Zeroizing<String>,
}
impl AndroidReceiver {
    pub fn bind(attempt: &LoginAttempt) -> Result<Self, String> {
        if HOST.get().is_none() {
            return Err("Android OAuth host unavailable".into());
        }
        if attempt.redirect_uri() != REDIRECT {
            return Err("Android redirect is not the explicit experimental callback".into());
        }
        attempt.remaining().map_err(|e| e.to_string())?;
        let mut active = ACTIVE.lock().map_err(|_| "OAuth state unavailable")?;
        if active.current().is_some() {
            return Err("Another OAuth request is pending".into());
        }
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel(4);
        active
            .start(id, sender)
            .map_err(|_| "Another OAuth request is pending")?;
        Ok(Self {
            id,
            receiver,
            authorization: Zeroizing::new(attempt.authorization_url().to_owned()),
        })
    }
    pub fn open_browser(&self, authorization: &str) -> Result<(), String> {
        if authorization != self.authorization.as_str() {
            return Err("Authorization URL changed".into());
        }
        let host = HOST.get().ok_or("Android OAuth host unavailable")?;
        let mut env = host
            .vm
            .attach_current_thread()
            .map_err(|_| "Cannot attach browser host")?;
        let result = (|| -> jni::errors::Result<()> {
            let class: &JClass<'_> = host.class.as_obj().into();
            let url = env.new_string(authorization)?;
            env.call_static_method(
                class,
                "open",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[
                    JValue::Object(host.context.as_obj()),
                    JValue::Object(url.as_ref()),
                ],
            )?;
            Ok(())
        })();
        let _ = env.exception_clear();
        result.map_err(|_| "System browser could not open authorization request".into())
    }
    pub async fn receive(mut self, attempt: &LoginAttempt) -> Result<Zeroizing<String>, String> {
        if attempt.authorization_url() != self.authorization.as_str() {
            return Err("OAuth attempt changed".into());
        }
        let remaining = attempt.remaining().map_err(|e| e.to_string())?;
        tokio::time::timeout(remaining, async {
            while let Some(raw) = self.receiver.recv().await {
                match attempt.validate_callback(&raw) {
                    Ok(()) | Err(IdentityError::LoginRejected) => return Ok(raw),
                    _ => continue,
                }
            }
            Err("OAuth receiver closed".into())
        })
        .await
        .map_err(|_| "OAuth attempt expired".to_owned())?
    }
}
impl Drop for AndroidReceiver {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            active.cancel(self.id);
        }
    }
}
