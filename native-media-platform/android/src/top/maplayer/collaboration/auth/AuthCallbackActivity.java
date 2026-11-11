package top.maplayer.collaboration.auth;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
/** Untrusted external entry: no login, exchange, business navigation or persisted state here. */
public final class AuthCallbackActivity extends Activity {
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        try {
            Intent intent = getIntent();
            String uri = intent.getDataString();
            if (saved == null && Intent.ACTION_VIEW.equals(intent.getAction()) && AuthUri.accepts(uri))
                AuthBridge.callback(uri);
        } catch (RuntimeException | UnsatisfiedLinkError ignored) {
            // No callback URL, code or state is logged. Missing host fails closed.
        } finally { finish(); }
    }
}
