package top.maplayer.collaboration.auth;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
/** Launch only an authorization URL supplied by the bound Rust LoginAttempt. */
public final class AuthBridge {
    private AuthBridge() {}
    public static void open(Context context, String authorization) {
        Uri uri = Uri.parse(authorization);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getFragment() != null)
            throw new IllegalArgumentException("Invalid authorization endpoint");
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }
    static native boolean callback(String uri);
}
