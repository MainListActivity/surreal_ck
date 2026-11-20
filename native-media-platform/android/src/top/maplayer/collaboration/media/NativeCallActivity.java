package top.maplayer.collaboration.media;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Native foreground controls + real decoder Surfaces. Capture is off until each explicit user action. */
public final class NativeCallActivity extends Activity {
    private long session;
    private int pending=-1;
    private long pendingToken;
    private boolean systemPrompt;
    private boolean registered;
    private volatile boolean resumed;
    private Intent deferredStart;
    private TextView status;
    private Spinner cameras;
    private final List<String> cameraIds=new ArrayList<>();
    private final Renderer[] renderers={new Renderer(0),new Renderer(1),new Renderer(2)};
    private volatile boolean remoteVideo,remoteAudio;
    @Override protected void onCreate(Bundle state){
        super.onCreate(state);
        session=getIntent().getLongExtra("session",0);
        if(!MediaBridge.valid(session)){finish();return;}
        registered=MediaBridge.attached(this,session);if(!registered){finish();return;}
        LinearLayout content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);content.setPadding(24,24,24,24);
        ScrollView scroll=new ScrollView(this);scroll.addView(content);setContentView(scroll);
        TextView heading=new TextView(this);heading.setText("原生通话控制 · 所有采集默认关闭");heading.setTextSize(20);content.addView(heading);
        TextView note=new TextView(this);note.setText("每次开启需系统许可。离开此窗口会停止采集和播放。系统屏幕选择器取消不会停止已授权的其他轨。媒体未接通或设备不支持时会明确报错。");content.addView(note);
        status=new TextView(this);status.setText(NativeCaptureService.active(session)?"前次采集尚未确认停止，请等待资源释放完成。":"尚未启动采集或远端播放。");content.addView(status);
        cameras=new Spinner(this);List<String> names=new ArrayList<>();
        try{CameraManager manager=getSystemService(CameraManager.class);for(String id:manager.getCameraIdList()){
            Integer facing=manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
            cameraIds.add(id);names.add((facing!=null&&facing==CameraCharacteristics.LENS_FACING_FRONT?"前置摄像头 ":"摄像头 ")+id);
        }}catch(Exception e){status.setText("无法列出摄像头："+e);}
        cameras.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,names));content.addView(cameras);
        button(content,"开启所选摄像头",()->request(1));button(content,"停止摄像头",()->NativeCaptureService.stopTrack(session,1));
        button(content,"开启麦克风",()->request(0));button(content,"停止麦克风",()->NativeCaptureService.stopTrack(session,0));
        button(content,"选择并共享屏幕",()->request(2));button(content,"停止屏幕共享",()->NativeCaptureService.stopTrack(session,2));
        button(content,"开启/关闭远端视频",()->{remoteVideo=!remoteVideo;renderers[1].enabled(remoteVideo);renderers[2].enabled(remoteVideo);status.setText(remoteVideo?"允许远端视频解码，等待真实帧。":"远端视频已关闭。");});
        label(content,"远端摄像头（仅显示实际解码帧）");surface(content,1);
        label(content,"远端屏幕（仅显示实际解码帧）");surface(content,2);
        button(content,"开启/关闭远端音频",()->{remoteAudio=!remoteAudio;renderers[0].enabled(remoteAudio);status.setText(remoteAudio?"允许远端音频播放。":"远端音频已关闭。");});
        button(content,"停止全部采集",()->NativeCaptureService.stopSession(session));button(content,"关闭媒体窗口",this::finish);
    }
    private void button(LinearLayout parent,String text,Runnable action){Button b=new Button(this);b.setText(text);b.setOnClickListener(v->{if(MediaBridge.valid(session))action.run();});parent.addView(b);}
    private void label(LinearLayout parent,String text){TextView label=new TextView(this);label.setText(text);parent.addView(label);}
    private void surface(LinearLayout parent,int source){SurfaceView view=new SurfaceView(this);parent.addView(view,new LinearLayout.LayoutParams(-1,(int)(180*getResources().getDisplayMetrics().density)));
        view.getHolder().addCallback(new SurfaceHolder.Callback(){
            @Override public void surfaceCreated(SurfaceHolder holder){renderers[source].surface(holder.getSurface());}
            @Override public void surfaceChanged(SurfaceHolder holder,int format,int width,int height){renderers[source].surface(holder.getSurface());}
            @Override public void surfaceDestroyed(SurfaceHolder holder){renderers[source].surface(null);}
        });
    }
    private void request(int source){
        if(NativeCaptureService.trackActive(session,source)){status.setText("该采集已开启，请先停止后再更换。");return;}
        if(pending!=-1){status.setText("请先完成或取消当前系统许可请求。");return;}
        if(source==1&&cameraIds.isEmpty()){status.setText("没有可用摄像头。");return;}
        try{pendingToken=MediaBridge.authorize(this,session,source);}catch(RuntimeException error){status.setText("无法授权采集请求："+error);return;}
        pending=source;List<String> permissions=new ArrayList<>();
        if(source==0&&checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED)permissions.add(Manifest.permission.RECORD_AUDIO);
        if(source==1&&checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED)permissions.add(Manifest.permission.CAMERA);
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)permissions.add(Manifest.permission.POST_NOTIFICATIONS);
        if(!permissions.isEmpty()){systemPrompt=true;requestPermissions(permissions.toArray(new String[0]),201);}else afterPermissions();
    }
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){super.onRequestPermissionsResult(code,permissions,results);if(code!=201)return;
        systemPrompt=false;boolean granted=results.length==permissions.length&&results.length>0;
        for(int value:results)if(value!=PackageManager.PERMISSION_GRANTED)granted=false;
        if(!granted){status.setText("权限被拒绝，未启动请求的采集。可再次点击按钮重试。");pending=-1;return;}
        if(!MediaBridge.valid(session)||isFinishing()){pending=-1;return;}afterPermissions();
    }
    @SuppressWarnings("deprecation")
    private void afterPermissions(){
        if(pending<0||!MediaBridge.validRequest(session,pending,pendingToken)){pending=-1;status.setText("此采集请求已被停止，请重新点击开启。");return;}
        if(pending==2){systemPrompt=true;try{startActivityForResult(getSystemService(MediaProjectionManager.class).createScreenCaptureIntent(),202);}catch(RuntimeException e){systemPrompt=false;pending=-1;status.setText("无法打开屏幕选择器："+e);}}
        else startCapture(null,0);
    }
    @Override @SuppressWarnings("deprecation")
    protected void onActivityResult(int code,int result,Intent data){super.onActivityResult(code,result,data);if(code!=202)return;systemPrompt=false;
        if(result!=RESULT_OK||data==null){pending=-1;status.setText("屏幕选择已取消，其他已授权轨保持原状。");return;}
        if(!MediaBridge.valid(session)||isFinishing()){pending=-1;return;}startCapture(data,result);
    }
    private void startCapture(Intent consent,int result){int source=pending;pending=-1;if(source<0||source>2||!MediaBridge.validRequest(session,source,pendingToken)){status.setText("此采集请求已被停止。");return;}
        Intent service=new Intent(this,NativeCaptureService.class).putExtra("session",session).putExtra("source",source).putExtra("request",pendingToken);
        if(source==1)service.putExtra("camera",cameraIds.get(cameras.getSelectedItemPosition()));
        if(source==2)service.putExtra("consent",consent).putExtra("result",result);
        if(!resumed){deferredStart=service;return;}dispatch(service);
    }
    private void dispatch(Intent service){int source=service.getIntExtra("source",-1);
        if(!MediaBridge.canStart(session,source,service.getLongExtra("request",-1))){status.setText("采集请求已失效，未启动设备。");return;}
        try{startForegroundService(service);status.setText("等待真实设备或编码器启动…");}catch(RuntimeException e){MediaBridge.changed(session,source,0,e.toString());}
    }
    void error(String detail){if(status!=null)status.setText("媒体错误："+detail);}
    void status(int source,int state,String detail){if(status!=null)status.setText((source==0?"麦克风":source==1?"摄像头":"屏幕")+": "+(state==0?"已停止":state==1?"真实采集中":state==2?"正在启动":state==4?"正在停止，释放待确认":"停止/状态未确认")+(detail.isEmpty()?"":"；"+detail));}
    boolean present(int source,byte[] data,long pts){if(source<0||source>2||pts<0)return false;return renderers[source].offer(data,pts);}
    private void stopPlayback(){remoteVideo=false;remoteAudio=false;for(Renderer renderer:renderers)renderer.enabled(false);}
    boolean foreground(){return resumed&&!isFinishing();}
    @Override protected void onResume(){super.onResume();resumed=true;if(deferredStart!=null){Intent next=deferredStart;deferredStart=null;if(MediaBridge.valid(session))dispatch(next);}}
    @Override protected void onStop(){resumed=false;if(registered&&!systemPrompt){deferredStart=null;NativeCaptureService.stopSession(session);stopPlayback();}super.onStop();}
    @Override protected void onDestroy(){if(registered)NativeCaptureService.stopSession(session);
        java.util.concurrent.atomic.AtomicInteger remaining=new java.util.concurrent.atomic.AtomicInteger(renderers.length);
        for(Renderer renderer:renderers)renderer.close(()->{if(remaining.decrementAndGet()==0)MediaBridge.detached(this,session);});
        super.onDestroy();}

    /** No frame waits on the UI thread. Queue is bounded; true means queued, not displayed. */
    private final class Renderer {
        private final int source;
        private final boolean audio;
        private final ThreadPoolExecutor executor;
        private final Object queueLock=new Object();
        private volatile boolean enabled,closed;
        private volatile boolean needKeyframe=true;
        private final java.util.concurrent.atomic.AtomicLong dropped=new java.util.concurrent.atomic.AtomicLong();
        private volatile Surface surface;
        private NativeVideo.Decoder decoder;
        private NativeAudio.Player player;
        private int width,height;
        Renderer(int source){this.source=source;this.audio=source==0;executor=new ThreadPoolExecutor(1,1,10,TimeUnit.SECONDS,new ArrayBlockingQueue<>(audio?16:2),r->{Thread t=new Thread(r,"ck-render");t.setDaemon(true);return t;},new ThreadPoolExecutor.AbortPolicy());}
        void surface(Surface value){synchronized(queueLock){if(closed)return;if(surface!=value){surface=value;dropped.incrementAndGet();executor.getQueue().clear();releaseLater();}}}
        void enabled(boolean value){synchronized(queueLock){if(closed)return;enabled=value;if(!value){dropped.incrementAndGet();executor.getQueue().clear();releaseLater();}}}
        private void releaseLater(){if(closed)return;try{executor.execute(()->{synchronized(this){release();}});}catch(java.util.concurrent.RejectedExecutionException e){/* An already scheduled close owns release. */}}
        boolean offer(byte[] bytes,long pts){synchronized(queueLock){if(!enabled||closed||bytes.length==0||bytes.length>(audio?1275:4*1024*1024))return false;
            long revision=dropped.get();try{executor.execute(()->render(bytes,pts,revision));return true;}catch(java.util.concurrent.RejectedExecutionException e){if(!audio){dropped.incrementAndGet();needKeyframe=true;executor.getQueue().clear();}return false;}
        }}
        private synchronized void render(byte[] bytes,long pts,long revision){if(!enabled||closed||revision!=dropped.get())return;
            try{
                if(audio){if(player==null)player=new NativeAudio.Player();player.frame(bytes,pts);return;}
                if(surface==null||!surface.isValid())return;
                boolean key=(bytes[0]&1)==0;
                if(needKeyframe&&!key)return;
                if(key){if(bytes.length<10||bytes[3]!=(byte)0x9d||bytes[4]!=1||bytes[5]!=0x2a)return;
                    int w=((bytes[7]&255)<<8|(bytes[6]&255))&0x3fff,h=((bytes[9]&255)<<8|(bytes[8]&255))&0x3fff;
                    if(w<1||h<1||w>1920||h>1080)return;
                    if(decoder==null||w!=width||h!=height){release();decoder=new NativeVideo.Decoder(w,h,surface);width=w;height=h;}
                }
                if(decoder!=null){if(decoder.frame(bytes,pts)){if(key&&revision==dropped.get())needKeyframe=false;}else needKeyframe=true;}
            }catch(Exception error){enabled=false;if(error instanceof MediaReleaseFailure)MediaBridge.releaseFailed(session,source,"播放初始化释放未确认："+error);release();android.util.Log.e("CKMedia","Native decode failed",error);MediaBridge.error(session,source,"远端解码失败："+error);}
        }
        private void release(){needKeyframe=true;try{if(decoder!=null)decoder.close();}catch(RuntimeException e){android.util.Log.e("CKMedia","Video release failed",e);MediaBridge.releaseFailed(session,source,"视频播放释放未确认："+e);}finally{decoder=null;}
            try{if(player!=null)player.close();}catch(RuntimeException e){android.util.Log.e("CKMedia","Audio release failed",e);MediaBridge.releaseFailed(session,source,"音频播放释放未确认："+e);}finally{player=null;}}
        void close(Runnable done){synchronized(queueLock){if(closed)return;closed=true;enabled=false;dropped.incrementAndGet();executor.getQueue().clear();
            try{executor.execute(()->{try{synchronized(this){release();surface=null;}}finally{done.run();}});executor.shutdown();}
            catch(java.util.concurrent.RejectedExecutionException error){MediaBridge.releaseFailed(session,source,"播放关闭队列未接受清理请求");done.run();}
        }}
    }
}
