package top.maplayer.collaboration.update;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;

/** 在 NSH Activity 建立 Rust 根之前，以真实 Application Context 初始化 JNI 桥。 */
public final class UpdaterInitProvider extends ContentProvider {
    private static native boolean initialize(android.content.Context context);
    @Override public boolean onCreate() {
        android.content.Context context = getContext();
        if (context == null) return false;
        try {
            System.loadLibrary("nsh");
            return initialize(context.getApplicationContext());
        } catch (UnsatisfiedLinkError error) {
            // 未链接适配器的包保持不可用，不猜测私有目录。
            return false;
        }
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) { throw new UnsupportedOperationException(); }
    @Override public String getType(Uri uri) { throw new UnsupportedOperationException(); }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
