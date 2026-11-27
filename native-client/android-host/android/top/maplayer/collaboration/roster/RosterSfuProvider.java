package top.maplayer.collaboration.roster;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import java.lang.ref.WeakReference;

public final class RosterSfuProvider extends ContentProvider implements Application.ActivityLifecycleCallbacks {
    private static volatile WeakReference<Activity> resumed = new WeakReference<>(null);
    private static native boolean initialize(android.content.Context context);

    @Override public boolean onCreate() {
        if (getContext() == null || !(getContext().getApplicationContext() instanceof Application)) return false;
        Application app = (Application) getContext().getApplicationContext();
        try {
            System.loadLibrary("nsh");
            if (!initialize(app)) return false;
            app.registerActivityLifecycleCallbacks(this);
            return true;
        } catch (UnsatisfiedLinkError error) {
            android.util.Log.e("CKRoster", "LiveKit JNI unavailable", error);
            return false;
        }
    }

    public static boolean requestMicrophone() {
        Activity activity = resumed.get();
        if (activity == null || activity.isFinishing()) return false;
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return true;
        activity.runOnUiThread(() -> {
            if (resumed.get() == activity && !activity.isFinishing()) {
                activity.requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, 908);
            }
        });
        return false;
    }

    @Override public void onActivityResumed(Activity activity) { resumed = new WeakReference<>(activity); }
    @Override public void onActivityPaused(Activity activity) { if (resumed.get() == activity) resumed.clear(); }
    @Override public void onActivityCreated(Activity activity, Bundle state) {}
    @Override public void onActivityStarted(Activity activity) {}
    @Override public void onActivityStopped(Activity activity) {}
    @Override public void onActivitySaveInstanceState(Activity activity, Bundle state) {}
    @Override public void onActivityDestroyed(Activity activity) {}
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { throw new UnsupportedOperationException(); }
    @Override public String getType(Uri u) { throw new UnsupportedOperationException(); }
    @Override public Uri insert(Uri u, ContentValues v) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri u, String s, String[] a) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { throw new UnsupportedOperationException(); }
}
