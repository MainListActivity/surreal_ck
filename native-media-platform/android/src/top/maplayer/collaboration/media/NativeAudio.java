package top.maplayer.collaboration.media;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.media.MediaRecorder;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Native 48 kHz mono capture -> Opus, and stereo Opus -> speaker.
 * Caller owns RECORD_AUDIO runtime permission, foreground microphone service and off-UI-thread pumping. */
public final class NativeAudio implements AutoCloseable {
    public interface Sink { void encoded(byte[] opus,long presentationTimeUs); }
    private final AudioRecord recorder;
    private final MediaCodec encoder;
    private final Sink sink;
    private final byte[] pcm=new byte[960*2];
    private long samples;
    private boolean closed;
    public NativeAudio(Context context,Sink sink) throws IOException {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED) throw new SecurityException("RECORD_AUDIO permission not granted");
        this.sink=sink;
        int min=AudioRecord.getMinBufferSize(48000,AudioFormat.CHANNEL_IN_MONO,AudioFormat.ENCODING_PCM_16BIT);
        if (min<0) throw new IllegalStateException("48kHz PCM capture unsupported");
        recorder=new AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION).setAudioFormat(new AudioFormat.Builder().setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()).setBufferSizeInBytes(Math.max(min,960*2*4)).build();
        if (recorder.getState()!=AudioRecord.STATE_INITIALIZED) { recorder.release(); throw new IllegalStateException("microphone initialization failed"); }
        try { encoder=MediaCodec.createEncoderByType("audio/opus"); } catch (IOException | RuntimeException failure) { MediaReleaseFailure.releaseOrThrow(failure,recorder::release); throw failure; }
        MediaFormat format=MediaFormat.createAudioFormat("audio/opus",48000,1); format.setInteger(MediaFormat.KEY_BIT_RATE,32000); format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE,pcm.length);
        try { encoder.configure(format,null,null,MediaCodec.CONFIGURE_FLAG_ENCODE); encoder.start(); recorder.startRecording(); if(recorder.getRecordingState()!=AudioRecord.RECORDSTATE_RECORDING)throw new IllegalStateException("Microphone did not start recording"); } catch (RuntimeException failure) { MediaReleaseFailure.releaseOrThrow(failure,encoder::release,recorder::release); throw failure; }
    }
    /** Call repeatedly on one worker thread while the user keeps the microphone enabled. */
    public void pump() {
        if (closed) throw new IllegalStateException("microphone closed");
        int read=recorder.read(pcm,0,pcm.length,AudioRecord.READ_BLOCKING);
        if (read<=0) throw new IllegalStateException("microphone read failed: "+read);
        int inputIndex=encoder.dequeueInputBuffer(10000);
        long timestamp=samples*1000000/48000; samples+=read/2;
        if (inputIndex>=0) {
            ByteBuffer input=encoder.getInputBuffer(inputIndex);
            if (input==null || input.capacity()<read) { encoder.queueInputBuffer(inputIndex,0,0,timestamp,0); throw new IllegalStateException("encoder input capacity"); }
            input.clear(); input.put(pcm,0,read); encoder.queueInputBuffer(inputIndex,0,read,timestamp,0);
        }
        MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();
        for (int index=encoder.dequeueOutputBuffer(info,0); index>=0; index=encoder.dequeueOutputBuffer(info,0)) {
            try {
                ByteBuffer output=encoder.getOutputBuffer(index);
                if (output!=null && info.size>0 && info.size<=1275 && (info.flags&MediaCodec.BUFFER_FLAG_CODEC_CONFIG)==0) {
                    output.position(info.offset); output.limit(info.offset+info.size); byte[] data=new byte[info.size]; output.get(data); sink.encoded(data,info.presentationTimeUs);
                }
            } finally {encoder.releaseOutputBuffer(index,false);}
        }
    }
    public void stopInput() { if(recorder.getRecordingState()==AudioRecord.RECORDSTATE_RECORDING)recorder.stop(); }
    /** Host must stop/join the pump loop before close. This method releases the actual microphone. */
    @Override public void close() {
        if (closed) return; closed=true;
        MediaReleaseFailure.releaseOrThrow(new IllegalStateException("Closing microphone"),this::stopInput,recorder::release,encoder::stop,encoder::release);
    }
    public static final class Player implements AutoCloseable {
        private final MediaCodec decoder;
        private AudioTrack output;
        public Player() throws IOException {
            decoder=MediaCodec.createDecoderByType("audio/opus");
            try {
            MediaFormat format=MediaFormat.createAudioFormat("audio/opus",48000,2);
            format.setByteBuffer("csd-0",ByteBuffer.wrap(new byte[]{'O','p','u','s','H','e','a','d',1,2,0,0,(byte)0x80,(byte)0xbb,0,0,0,0,0}));
            ByteBuffer delay=ByteBuffer.allocate(8).order(ByteOrder.nativeOrder());
            delay.putLong(0); delay.flip();
            ByteBuffer preroll=ByteBuffer.allocate(8).order(ByteOrder.nativeOrder());
            preroll.putLong(80000000); preroll.flip();
            format.setByteBuffer("csd-1",delay);
            format.setByteBuffer("csd-2",preroll);
            decoder.configure(format,null,null,0); decoder.start();
            int min=AudioTrack.getMinBufferSize(48000,AudioFormat.CHANNEL_OUT_STEREO,AudioFormat.ENCODING_PCM_16BIT);
            output=new AudioTrack.Builder().setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()).setAudioFormat(new AudioFormat.Builder().setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()).setBufferSizeInBytes(Math.max(min,3840*4)).setTransferMode(AudioTrack.MODE_STREAM).build(); output.play();
            } catch(RuntimeException error){MediaReleaseFailure.releaseOrThrow(error,decoder::release,()->{if(output!=null)output.release();});throw error;}
        }
        /** Off UI thread. Host must map RTP timestamps to a monotonic microsecond timeline. */
        public boolean frame(byte[] opus,long timestampUs) {
            if (opus.length==0 || opus.length>1275) return false;
            int index=decoder.dequeueInputBuffer(0);
            if(index<0){drain();return false;}
            ByteBuffer input=decoder.getInputBuffer(index);
            if(input==null || input.capacity()<opus.length){decoder.queueInputBuffer(index,0,0,timestampUs,0);return false;}
            input.clear();input.put(opus);decoder.queueInputBuffer(index,0,opus.length,timestampUs,0);drain();return true;
        }
        private void drain(){
            MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();
            for(int index=decoder.dequeueOutputBuffer(info,0);index>=0;index=decoder.dequeueOutputBuffer(info,0)){
                try {ByteBuffer pcm=decoder.getOutputBuffer(index);if(pcm!=null && info.size>0){pcm.position(info.offset);pcm.limit(info.offset+info.size);output.write(pcm,info.size,AudioTrack.WRITE_NON_BLOCKING);}}
                finally {decoder.releaseOutputBuffer(index,false);}
            }
        }
        @Override public void close(){MediaReleaseFailure.releaseOrThrow(new IllegalStateException("Closing audio playback"),decoder::stop,decoder::release,output::stop,output::release);}
    }
}
