package top.maplayer.collaboration.media;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
public final class MediaInitProvider extends ContentProvider {
    private static native boolean initialize(android.content.Context context);
    @Override public boolean onCreate() {
        if (getContext() == null) return false;
        try { System.loadLibrary("nsh"); boolean ready=initialize(getContext().getApplicationContext());android.util.Log.i("CKMedia","Native media host initialized: "+ready);return ready; }
        catch (UnsatisfiedLinkError error) { android.util.Log.e("CKMedia", "Media JNI unavailable", error); return false; }
    }
    @Override public Cursor query(Uri u,String[] p,String s,String[] a,String o){throw new UnsupportedOperationException();}
    @Override public String getType(Uri u){throw new UnsupportedOperationException();}
    @Override public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException();}
    @Override public int delete(Uri u,String s,String[] a){throw new UnsupportedOperationException();}
    @Override public int update(Uri u,ContentValues v,String s,String[] a){throw new UnsupportedOperationException();}
}
