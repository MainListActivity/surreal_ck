package top.maplayer.collaboration.auth;
/** Boundary-only tests. A matching URI is not a validated login. */
public final class AuthUriTest {
    private AuthUriTest() {}
    public static void main(String[] args) {
        String good = "top.maplayer.collaboration:/auth/callback?state=example&code=example";
        if (!AuthUri.accepts(good)) throw new AssertionError();
        String[] bad = {null, "", good + "#fragment", good.replace(":/auth", "://auth"), good.replace("callback?", "callback/extra?"), good.replace("/auth/", "/%61uth/"), good.replace("collaboration:", "evil:"), "top.maplayer.collaboration:/auth/callback", good + new String(new char[16384])};
        for (String raw : bad) if (AuthUri.accepts(raw)) throw new AssertionError("Untrusted URI accepted");
        System.out.println("PASS: exact OAuth URI ingress boundaries; state remains Rust-validated");
    }
}
