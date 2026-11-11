package top.maplayer.collaboration.auth;
/** Exact raw redirect boundary; Rust validates query/state/issuer against the active attempt. */
final class AuthUri {
    private AuthUri() {}
    static boolean accepts(String uri) {
        return uri != null && uri.length() <= 16384
            && uri.startsWith("top.maplayer.collaboration:/auth/callback?")
            && uri.indexOf('#') < 0;
    }
}
