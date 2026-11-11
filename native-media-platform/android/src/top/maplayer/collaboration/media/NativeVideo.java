package top.maplayer.collaboration.media;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Surface;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Collections;

/** Android native Camera2 / MediaProjection -> VP8 and VP8 -> Surface.
 * No JNI registration or permission prompt is hidden here. Host owns authorization and lifecycle. */
public final class NativeVideo implements AutoCloseable {
    public interface Sink {
        void encoded(byte[] vp8, long presentationTimeUs, boolean keyframe);
        void failed(String reason);
        void stopped();
    }
    private final HandlerThread thread = new HandlerThread("NativeVideo");
    private final Handler handler;
    private final MediaCodec encoder;
    private Surface input;
    private final Sink sink;
    private CameraDevice camera;
    private CameraCaptureSession cameraSession;
    private VirtualDisplay display;
    private MediaProjection projection;
    private MediaProjection.Callback projectionCallback;
    private volatile boolean closed;
    private boolean sourceRequested;
    private boolean cameraPending;
    private boolean cameraClosed=true;
    private boolean resourcesReleased;
    private boolean releaseFailed;
    private boolean stoppedSent;

    public NativeVideo(int width, int height, int fps, Sink sink) throws IOException {
        if (width<=0 || height<=0 || width>1920 || height>1080 || fps<=0 || fps>60) throw new IllegalArgumentException("unsupported video size/fps");
        this.sink=sink;
        encoder=MediaCodec.createEncoderByType("video/x-vnd.on2.vp8");
        thread.start(); handler=new Handler(thread.getLooper());
        try {
        MediaFormat format=MediaFormat.createVideoFormat("video/x-vnd.on2.vp8",width,height);
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT,MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_BIT_RATE,1500000);
        format.setInteger(MediaFormat.KEY_FRAME_RATE,fps);
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL,1);
        encoder.setCallback(new MediaCodec.Callback() {
            @Override public void onInputBufferAvailable(MediaCodec codec,int index) { }
            @Override public void onOutputBufferAvailable(MediaCodec codec,int index,MediaCodec.BufferInfo info) {
                if(closed)return;
                try {
                    ByteBuffer buffer=codec.getOutputBuffer(index);
                    if (!closed && buffer!=null && info.size>0 && info.size<=4*1024*1024 && (info.flags&MediaCodec.BUFFER_FLAG_CODEC_CONFIG)==0) {
                        buffer.position(info.offset); buffer.limit(info.offset+info.size);
                        byte[] bytes=new byte[info.size]; buffer.get(bytes);
                        sink.encoded(bytes,info.presentationTimeUs,(info.flags&MediaCodec.BUFFER_FLAG_KEY_FRAME)!=0);
                    }
                } catch(RuntimeException error){if(!closed){sink.failed(error.toString());close();}} finally { if (!closed) {try{codec.releaseOutputBuffer(index,false);}catch(RuntimeException error){if(!closed){sink.failed(error.toString());close();}}} }
            }
            @Override public void onError(MediaCodec codec,MediaCodec.CodecException error) { sink.failed(error.getDiagnosticInfo()); close(); }
            @Override public void onOutputFormatChanged(MediaCodec codec,MediaFormat output) { }
        },handler);
        encoder.configure(format,null,null,MediaCodec.CONFIGURE_FLAG_ENCODE);
            input=encoder.createInputSurface(); encoder.start();
        } catch(RuntimeException error) {
            MediaReleaseFailure.releaseOrThrow(error,()->{if(input!=null)input.release();},encoder::release,thread::quitSafely);throw error;
        }
    }
    /** Runtime CAMERA permission must already have been granted by Activity's user-driven flow. */
    public synchronized void startCamera(Context context,String cameraId) throws android.hardware.camera2.CameraAccessException {
        if (context.checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED) throw new SecurityException("CAMERA permission not granted");
        if (closed || sourceRequested) throw new IllegalStateException("source already active or closed");
        sourceRequested=true;
        CameraManager manager=(CameraManager)context.getSystemService(Context.CAMERA_SERVICE);
        cameraPending=true;cameraClosed=false;
        try { manager.openCamera(cameraId,new CameraDevice.StateCallback() {
            @Override public void onOpened(CameraDevice device) {
                synchronized(NativeVideo.this){cameraPending=false;camera=device;if(closed){closeDevice(device);return;}
                try {
                    device.createCaptureSession(new SessionConfiguration(SessionConfiguration.SESSION_REGULAR,Collections.singletonList(new OutputConfiguration(input)),command->handler.post(command),new CameraCaptureSession.StateCallback() {
                        @Override public void onConfigured(CameraCaptureSession session) {
                            synchronized(NativeVideo.this){
                            if (closed) { release(session::close); return; } cameraSession=session;
                            try { CaptureRequest.Builder request=device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD); request.addTarget(input); session.setRepeatingRequest(request.build(),null,handler); }
                            catch (android.hardware.camera2.CameraAccessException|RuntimeException error) { sink.failed(error.toString()); close(); }
                            }
                        }
                        @Override public void onConfigureFailed(CameraCaptureSession session) { sink.failed("Camera surface configuration failed"); close(); }
                    }));
                } catch (android.hardware.camera2.CameraAccessException|RuntimeException error) { sink.failed(error.toString()); close(); }
                }
            }
            @Override public void onDisconnected(CameraDevice device) { synchronized(NativeVideo.this){cameraPending=false;camera=device;} closeDevice(device); close(); }
            @Override public void onError(CameraDevice device,int error) { synchronized(NativeVideo.this){cameraPending=false;camera=device;} closeDevice(device); sink.failed("Camera error "+error); close(); }
            @Override public void onClosed(CameraDevice device) { synchronized(NativeVideo.this){cameraPending=false;cameraClosed=true;maybeStopped();} }
        },handler); } catch(android.hardware.camera2.CameraAccessException|RuntimeException error) {cameraPending=false;cameraClosed=true;throw error;}
    }
    /** Pass a fresh MediaProjection only after the OS consent flow and foreground service start.
     * Host must declare/run mediaProjection FGS on required API levels. No reuse of old consent tokens. */
    public synchronized void startScreen(MediaProjection granted,int width,int height,int dpi) {
        if (closed || sourceRequested) throw new IllegalStateException("source already active or closed");
        if (granted==null || dpi<=0 || width<=0 || height<=0) throw new IllegalArgumentException("invalid projection");
        sourceRequested=true;
        projection=granted;
        projectionCallback=new MediaProjection.Callback() { @Override public void onStop() { close(); } };
        projection.registerCallback(projectionCallback,handler);
        display=projection.createVirtualDisplay("Collaboration screen",width,height,dpi,DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,input,null,handler);
    }
    public synchronized void requestKeyframe() {
        if (!closed) { Bundle params=new Bundle(); params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME,0); encoder.setParameters(params); }
    }
    @Override public synchronized void close() {
        if(closed)return;closed=true;
        if(!handler.post(this::releaseResources)){releaseFailed=true;sink.failed("Video resource release unconfirmed: callback looper unavailable");}
    }
    private synchronized void releaseResources(){
        // Try every release even if one platform call throws. Never claim stopped on a failed release.
        release(()->{if(cameraSession!=null)cameraSession.close();});
        release(()->{if(camera!=null)camera.close();});
        release(()->{if(display!=null)display.release();});
        release(()->{if(projection!=null){projection.unregisterCallback(projectionCallback);projection.stop();}});
        release(encoder::stop);release(encoder::release);release(()->{if(input!=null)input.release();});
        resourcesReleased=true;
        // Keep the callback looper alive while a pending Camera2 open/close still owns hardware.
        maybeStopped();
    }
    private synchronized void closeDevice(CameraDevice device){release(device::close);}
    private void release(Runnable operation){try{operation.run();}catch(RuntimeException error){releaseFailed=true;sink.failed("Video resource release unconfirmed: "+error);}}
    private void maybeStopped(){
        if(resourcesReleased&&!cameraPending&&cameraClosed){thread.quitSafely();if(!releaseFailed&&!stoppedSent){stoppedSent=true;sink.stopped();}}
    }
    /** Native hardware/software codec decoder rendering directly onto the host's visible Surface. */
    public static final class Decoder implements AutoCloseable {
        private final MediaCodec codec;
        public Decoder(int width,int height,Surface target) throws IOException {
            codec=MediaCodec.createDecoderByType("video/x-vnd.on2.vp8");
            try{codec.configure(MediaFormat.createVideoFormat("video/x-vnd.on2.vp8",width,height),target,null,0); codec.start();}catch(RuntimeException error){MediaReleaseFailure.releaseOrThrow(error,codec::release);throw error;}
        }
        /** Host calls off UI thread. Returns false for bounded backpressure; never allocates an unbounded queue. */
        public boolean frame(byte[] vp8,long presentationTimeUs) {
            if (vp8.length==0 || vp8.length>4*1024*1024) return false;
            int index=codec.dequeueInputBuffer(0);
            if (index<0) { drain(); return false; }
            ByteBuffer input=codec.getInputBuffer(index);
            if (input==null || input.capacity()<vp8.length) { codec.queueInputBuffer(index,0,0,presentationTimeUs,0); return false; }
            input.clear(); input.put(vp8); codec.queueInputBuffer(index,0,vp8.length,presentationTimeUs,0); drain(); return true;
        }
        private void drain() { MediaCodec.BufferInfo info=new MediaCodec.BufferInfo(); for (int i=codec.dequeueOutputBuffer(info,0); i>=0; i=codec.dequeueOutputBuffer(info,0)) codec.releaseOutputBuffer(i,true); }
        @Override public void close() { try {codec.stop();} finally {codec.release();} }
    }
}
