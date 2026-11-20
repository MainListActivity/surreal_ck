package top.maplayer.collaboration.media;
/** Construction/cleanup did not confirm all owned resources released. Never convert this to Stopped. */
final class MediaReleaseFailure extends IllegalStateException {
    private static final long serialVersionUID=1L;
    private MediaReleaseFailure(Throwable original,Throwable cleanup){super("Native media resource release is unconfirmed",original);addSuppressed(cleanup);}
    static void releaseOrThrow(Throwable original,Runnable... actions){
        RuntimeException failed=null;
        for(Runnable action:actions){try{action.run();}catch(RuntimeException error){if(failed==null)failed=error;else failed.addSuppressed(error);}}
        if(failed!=null)throw new MediaReleaseFailure(original,failed);
    }
}
