package top.maplayer.collaboration.media;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.IBinder;
import java.util.concurrent.atomic.AtomicBoolean;

/** Visible foreground ownership of camera/microphone/projection. No sticky restart or token reuse. */
public final class NativeCaptureService extends Service {
    private static final String CHANNEL="ck-active-capture";
    private static volatile NativeCaptureService instance;
    private volatile long session;
    private final java.util.concurrent.atomic.AtomicReferenceArray<VideoCapture> videos=new java.util.concurrent.atomic.AtomicReferenceArray<>(3);
    private volatile Microphone microphone;
    private int foregroundTypes;
    private boolean destroying;
    private boolean rejected;
    @Override public void onCreate(){super.onCreate();NativeCaptureService prior=instance;if(prior!=null&&active(prior.session)){rejected=true;return;}instance=this;
        NotificationManager manager=getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL,"正在采集通话媒体",NotificationManager.IMPORTANCE_LOW));
    }
    @Override public IBinder onBind(Intent intent){return null;}
    static boolean active(long id){NativeCaptureService s=instance;return s!=null&&s.session==id&&(s.microphone!=null||s.videos.get(1)!=null||s.videos.get(2)!=null);}
    static void stopSession(long id){MediaBridge.invalidate(id,-1);NativeCaptureService s=instance;if(s!=null&&s.session==id)s.stopAll();}
    static void stopTrack(long id,int source){MediaBridge.invalidate(id,source);NativeCaptureService s=instance;if(s!=null&&s.session==id)s.stopOne(source);}
    static boolean trackActive(long id,int source){NativeCaptureService s=instance;return s!=null&&s.session==id&&(source==0?s.microphone!=null:s.videos.get(source)!=null);}
    static void keyframe(long id,int source){NativeCaptureService s=instance;if(s!=null&&s.session==id&&source>=1&&source<=2){VideoCapture v=s.videos.get(source);if(v!=null&&v.video!=null){try{v.video.requestKeyframe();}catch(RuntimeException e){v.fail(e.toString());}}}}
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(rejected||intent==null){stopSelf();return START_NOT_STICKY;}
        long id=intent.getLongExtra("session",0);
        if("stop".equals(intent.getAction())){if(id==session){MediaBridge.invalidate(id,-1);stopAll();}return START_NOT_STICKY;}
        if(!MediaBridge.valid(id)||(session!=0&&session!=id)){stopSelf();return START_NOT_STICKY;}
        session=id;
        int source=intent.getIntExtra("source",-1);
        if(source<0||source>2){stopSelf();return START_NOT_STICKY;}
        long request=intent.getLongExtra("request",-1);
        if(!MediaBridge.canStart(id,source,request)){if(!active(session))stopSelf();return START_NOT_STICKY;}
        // Keep a second press from reusing projection consent or restarting an active device.
        if((source==0&&microphone!=null)||(source>0&&videos.get(source)!=null))return START_NOT_STICKY;
        try{
            if(source==0&&checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)throw new SecurityException("Microphone permission denied");
            if(source==1&&checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED)throw new SecurityException("Camera permission denied");
            if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)throw new SecurityException("Visible capture notification permission denied");
            NotificationManager notifications=getSystemService(NotificationManager.class);
            if(!notifications.areNotificationsEnabled()||notifications.getNotificationChannel(CHANNEL).getImportance()==NotificationManager.IMPORTANCE_NONE)throw new SecurityException("Visible capture notification is disabled");
            int type=source==0?ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE:source==1?ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA:ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            foregroundTypes|=type;
            Notification notification=notification();
            if(Build.VERSION.SDK_INT>=29)startForeground(1903,notification,foregroundTypes);else startForeground(1903,notification);
            MediaBridge.changed(id,source,2,"");
            if(source==0){Microphone capture=new Microphone(request);microphone=capture;capture.start();}
            else{
                VideoCapture capture=new VideoCapture(source,request);videos.set(source,capture);
                capture.video=new NativeVideo(640,480,15,capture);
                if(source==1){String camera=intent.getStringExtra("camera");if(camera==null)throw new IllegalArgumentException("Choose a camera");capture.video.startCamera(this,camera);}
                else{
                    Intent consent=consent(intent);
                    if(consent==null)throw new SecurityException("Fresh screen consent required");
                    MediaProjectionManager manager=getSystemService(MediaProjectionManager.class);
                    MediaProjection projection=manager.getMediaProjection(intent.getIntExtra("result",0),consent);
                    intent.removeExtra("consent"); // Never cache/reuse Android14+ consent tokens.
                    if(projection==null)throw new SecurityException("Screen consent invalid");
                    capture.video.startScreen(projection,640,480,getResources().getDisplayMetrics().densityDpi);
                }
            }
        }catch(Exception failure){if(failure instanceof MediaReleaseFailure&&source>0){VideoCapture capture=videos.get(source);if(capture!=null)capture.unconfirmed=true;}MediaBridge.changed(id,source,3,failure.toString());stopOne(source);}
        return START_NOT_STICKY;
    }
    @SuppressWarnings("deprecation")
    private static Intent consent(Intent intent){return intent.getParcelableExtra("consent");}
    private Notification notification(){
        Intent stop=new Intent(this,NativeCaptureService.class).setAction("stop").putExtra("session",session);
        PendingIntent action=PendingIntent.getService(this,1904,stop,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Intent show=new Intent(this,NativeCallActivity.class).putExtra("session",session);
        PendingIntent open=PendingIntent.getActivity(this,1905,show,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle("正在采集通话媒体").setContentText("摄像头、麦克风或屏幕采集中；点击停止可立即结束采集")
            .setContentIntent(open).setOngoing(true).addAction(new Notification.Action.Builder(null,"停止采集",action).build()).build();
    }
    private void stopOne(int source){
        MediaBridge.invalidate(session,source);
        if(source==0){Microphone capture=microphone;if(capture!=null)capture.stop();else MediaBridge.changed(session,0,0,"");}
        else if(source==1||source==2){VideoCapture capture=videos.get(source);if(capture!=null)capture.close();else MediaBridge.changed(session,source,0,"");}
        updateForeground();
    }
    private void stopAll(){for(int source=0;source<3;source++)stopOne(source);}
    private void updateForeground(){
        int types=(microphone!=null?ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE:0)
            |(videos.get(1)!=null?ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA:0)|(videos.get(2)!=null?ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION:0);
        foregroundTypes=types;
        if(types==0){stopForeground(STOP_FOREGROUND_REMOVE);if(destroying&&instance==this)instance=null;if(!destroying)stopSelf();MediaBridge.closedIfIdle(session);}
        else if(!destroying&&Build.VERSION.SDK_INT>=29){try{startForeground(1903,notification(),types);}catch(RuntimeException error){android.util.Log.e("CKMedia","Cannot update foreground notification",error);MediaBridge.error(session,-1,"前台采集通知更新失败："+error);}}
    }
    @Override public void onTaskRemoved(Intent root){stopAll();super.onTaskRemoved(root);}
    @Override public void onDestroy(){destroying=true;if(!rejected)stopAll();if(instance==this&&!active(session))instance=null;super.onDestroy();MediaBridge.closedIfIdle(session);}
    private final class VideoCapture implements NativeVideo.Sink {
        final int source;final long ownerSession;final long request;NativeVideo video;boolean running;volatile boolean closing;boolean unconfirmed;
        VideoCapture(int source,long request){this.source=source;this.request=request;ownerSession=session;}
        @Override public void encoded(byte[] data,long pts,boolean key){
            if(videos.get(source)!=this||closing||!MediaBridge.validRequest(ownerSession,source,request))return;
            if(!running){running=MediaBridge.running(ownerSession,source,request);if(!running)return;}
            if(!MediaBridge.frame(ownerSession,source,request,data,pts,key)&&video!=null){try{video.requestKeyframe();}catch(RuntimeException e){fail(e.toString());}}
        }
        @Override public void failed(String reason){fail(reason);}
        void fail(String reason){if(videos.get(source)!=this)return;if(closing&&!reason.startsWith("Video resource release unconfirmed"))return;MediaBridge.changed(ownerSession,source,3,reason);new android.os.Handler(getMainLooper()).post(this::close);}
        @Override public void stopped(){new android.os.Handler(getMainLooper()).post(()->{
            if(videos.get(source)==this){videos.set(source,null);MediaBridge.changed(ownerSession,source,0,"");updateForeground();}
        });}
        void close(){
            if(closing)return;closing=true;if(!unconfirmed)MediaBridge.changed(ownerSession,source,4,"");
            if(video==null){if(unconfirmed)return;videos.set(source,null);MediaBridge.changed(ownerSession,source,0,"");return;}
            try{video.close();}catch(RuntimeException e){MediaBridge.changed(ownerSession,source,3,"Video release unconfirmed: "+e);}
        }
    }
    private final class Microphone {
        final AtomicBoolean enabled=new AtomicBoolean(true);NativeAudio audio;Thread thread;boolean unconfirmed;
        final long ownerSession;final long request;
        Microphone(long request){ownerSession=session;this.request=request;}
        void start() throws java.io.IOException{
            try{audio=new NativeAudio(NativeCaptureService.this,(data,pts)->{if(enabled.get()&&microphone==this&&MediaBridge.validRequest(ownerSession,0,request))MediaBridge.frame(ownerSession,0,request,data,pts,false);});}
            catch(java.io.IOException|RuntimeException e){if(!(e instanceof MediaReleaseFailure))microphone=null;else unconfirmed=true;throw e;}
            if(!MediaBridge.running(ownerSession,0,request))enabled.set(false);
            thread=new Thread(()->{
                String error="";boolean released=false;
                try{while(enabled.get())audio.pump();}catch(RuntimeException e){if(enabled.get())error=e.toString();}
                finally{try{audio.close();released=true;}catch(RuntimeException e){error="Microphone release unconfirmed: "+e;}}
                final String result=error;final boolean closed=released;
                new android.os.Handler(getMainLooper()).post(()->{if(microphone==this){if(closed)microphone=null;MediaBridge.changed(ownerSession,0,closed?0:3,result);updateForeground();}});
            },"ck-microphone");thread.start();
        }
        void stop(){boolean wasEnabled=enabled.getAndSet(false);if(wasEnabled&&!unconfirmed)MediaBridge.changed(ownerSession,0,4,"");if(audio!=null){try{audio.stopInput();}catch(RuntimeException e){MediaBridge.changed(ownerSession,0,3,"Stopping microphone: "+e);}}}
    }
}
