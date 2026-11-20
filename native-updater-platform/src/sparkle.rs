//! 将 Sparkle enclosure 签名绑定核心已验 hash 的完整归档；不同bytes绝不放行。
use ring::signature::{UnparsedPublicKey, ED25519};
pub fn archive_signature_matches(key: &[u8], signature: &[u8], verified_bytes: &[u8]) -> bool {
    key.len() == 32
        && signature.len() == 64
        && UnparsedPublicKey::new(&ED25519, key)
            .verify(verified_bytes, signature)
            .is_ok()
}
#[cfg(all(target_os = "macos", feature = "macos-sparkle"))]
mod native {
    use super::archive_signature_matches;
    use crate::{Error, InstallRequest, InstallState};
    use std::ffi::{c_char, CStr, CString};
    pub type StatusCallback = extern "C" fn(u64, bool, *const c_char);
    extern "C" {
        fn ck_start_required_update(
            version: *const c_char,
            url: *const c_char,
            publisher: *const c_char,
            bytes: *const u8,
            length: usize,
            generation: u64,
            status: StatusCallback,
        ) -> i32;
    }
    /// 回调中的UTF8指针仅在回调期间有效；须复制后发送UI channel。
    pub fn start(
        request: &InstallRequest<'_>,
        generation: u64,
        callback: StatusCallback,
    ) -> Result<InstallState, Error> {
        if request.release().platform != "macos" {
            return Err(Error::UnsupportedPlatform);
        }
        let version =
            CString::new(request.release().version.as_str()).map_err(|_| Error::InvalidArtifact)?;
        let url =
            CString::new(request.release().url.as_str()).map_err(|_| Error::InvalidArtifact)?;
        let publisher = CString::new(request.release().publisher.as_str())
            .map_err(|_| Error::InvalidPublisher)?;
        // C桥在返回前复制所有参数，随后切到主队列；不借用request跨线程。
        let result = unsafe {
            ck_start_required_update(
                version.as_ptr(),
                url.as_ptr(),
                publisher.as_ptr(),
                request.bytes().as_ptr(),
                request.bytes().len(),
                generation,
                callback,
            )
        };
        if result == 0 {
            Ok(InstallState::Started)
        } else {
            Err(Error::BridgeUnavailable)
        }
    }
    /// # Safety
    /// 仅本crate的ObjC桥调用。每个指针须有效且在此调用期间保持可读。
    #[no_mangle]
    pub unsafe extern "C" fn ck_archive_signature_matches(
        key: *const u8,
        key_len: usize,
        sig: *const u8,
        sig_len: usize,
        bytes: *const u8,
        len: usize,
    ) -> bool {
        if key.is_null()
            || sig.is_null()
            || bytes.is_null()
            || key_len != 32
            || sig_len != 64
            || len > isize::MAX as usize
        {
            return false;
        }
        archive_signature_matches(
            unsafe { std::slice::from_raw_parts(key, key_len) },
            unsafe { std::slice::from_raw_parts(sig, sig_len) },
            unsafe { std::slice::from_raw_parts(bytes, len) },
        )
    }
    /// # Safety
    /// 指针必须来自桥的状态回调，并在读取期间有效。
    pub unsafe fn status_text(text: *const c_char) -> Option<String> {
        if text.is_null() {
            None
        } else {
            unsafe { CStr::from_ptr(text) }
                .to_str()
                .ok()
                .map(str::to_owned)
        }
    }
}
#[cfg(all(target_os = "macos", feature = "macos-sparkle"))]
pub use native::{start, status_text, StatusCallback};
#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    #[test]
    fn exact_archive_required() {
        let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap();
        let bytes = b"already SHA256 verified update archive";
        let sig = key.sign(bytes);
        assert!(archive_signature_matches(
            key.public_key().as_ref(),
            sig.as_ref(),
            bytes
        ));
        assert!(!archive_signature_matches(
            key.public_key().as_ref(),
            sig.as_ref(),
            b"another archive same version"
        ));
        assert!(!archive_signature_matches(&[0; 32], sig.as_ref(), bytes));
        assert!(!archive_signature_matches(
            key.public_key().as_ref(),
            &[0; 64],
            bytes
        ));
        assert!(!archive_signature_matches(&[], sig.as_ref(), bytes));
        assert!(!archive_signature_matches(
            key.public_key().as_ref(),
            &[],
            bytes
        ));
    }
}
