package top.maplayer.collaboration.media;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import java.lang.ref.WeakReference;

/** Only the Rust media session opens these controls. No permission or device is started implicitly. */
public final class MediaBridge {
    private MediaBridge() {}
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile long session;
    private static long lastSession;
    private static volatile boolean closing;
    private static volatile boolean playbackUnconfirmed;
    private static final CaptureRequests requests=new CaptureRequests();
    private static volatile WeakReference<NativeCallActivity> activity = new WeakReference<>(null);
    static native boolean nativeFrame(long session,int source,byte[] data,long pts,boolean keyframe);
    static native void nativeState(long session,int source,int state,String detail);
    static native void nativeClosed(long session);
    static native void nativeError(long session,int source,String detail);
    public static synchronized void prepare(long id){
        if(id<=lastSession||session!=0)throw new IllegalStateException("Previous media generation is not closed");
        lastSession=id;session=id;closing=false;playbackUnconfirmed=false;
    }
    public static void open(Context context,long id) {
        if(!valid(id))throw new IllegalStateException("Media session unavailable");
        MAIN.post(() -> {
            if (!valid(id)) return;
            NativeCallActivity existing=activity.get();
            if(existing!=null&&!existing.isFinishing()) return;
            Intent intent=new Intent(context,NativeCallActivity.class).putExtra("session",id);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {context.startActivity(intent);} catch(RuntimeException e){nativeState(id,1,0,"Cannot open media controls: "+e);}
        });
    }
    static synchronized long authorize(NativeCallActivity caller,long id,int source){
        if(!valid(id)||activity.get()!=caller||!caller.foreground())throw new IllegalStateException("Capture requires visible controls");
        return requests.issue(source);
    }
    static synchronized boolean validRequest(long id,int source,long request){return valid(id)&&requests.valid(source,request);}
    static boolean canStart(long id,int source,long request){NativeCallActivity a=activity.get();return validRequest(id,source,request)&&a!=null&&a.foreground();}
    static synchronized void invalidate(long id,int source){if(session!=id)return;requests.invalidate(source);}
    static void releaseFailed(long id,int source,String detail){if(session==id){playbackUnconfirmed=true;error(id,source,detail);}}
    static synchronized boolean running(long id,int source,long request){if(!validRequest(id,source,request))return false;changed(id,source,1,"");return true;}
    static synchronized boolean frame(long id,int source,long request,byte[] data,long pts,boolean key){return validRequest(id,source,request)&&nativeFrame(id,source,data,pts,key);}
    static boolean valid(long id){return session==id&&!closing;}
    static boolean attached(NativeCallActivity value,long id){NativeCallActivity old=activity.get();if(!valid(id)||(old!=null&&old!=value&&!old.isFinishing()))return false;activity=new WeakReference<>(value);return true;}
    static void detached(NativeCallActivity value,long id){if(activity.get()==value)activity=new WeakReference<>(null);closedIfIdle(id);}
    static void error(long id,int source,String detail){nativeError(id,source,detail);MAIN.post(()->{NativeCallActivity a=activity.get();if(a!=null&&session==id)a.error(detail);});}
    static void changed(long id,int source,int state,String detail){
        nativeState(id,source,state,detail);
        MAIN.post(()->{NativeCallActivity a=activity.get();if(a!=null&&session==id)a.status(source,state,detail);});
    }
    public static void stop(Context context,long id){
        MAIN.post(()->{
            if(session!=id)return;
            closing=true;
            NativeCaptureService.stopSession(id);
            NativeCallActivity a=activity.get();if(a!=null)a.finish();
            closedIfIdle(id);
        });
    }
    static void closedIfIdle(long id){MAIN.post(()->{
        if(session==id&&closing&&!playbackUnconfirmed&&activity.get()==null&&!NativeCaptureService.active(id)){
            session=0;closing=false;nativeClosed(id);
        }
    });}
    public static void keyframe(long id,int source){MAIN.post(()->{if(valid(id))NativeCaptureService.keyframe(id,source);});}
    public static boolean present(long id,int source,byte[] data,long pts){
        NativeCallActivity a=activity.get();return valid(id)&&a!=null&&a.present(source,data,pts);
    }
}
