package top.maplayer.collaboration.media;
/** Each UI permission flow retains its original token. Stopping invalidates pending as well as active flows. */
final class CaptureRequests {
    private final long[] revisions=new long[3];
    synchronized long issue(int source){if(revisions[source]==Long.MAX_VALUE)throw new IllegalStateException("Capture generation exhausted");return ++revisions[source];}
    synchronized boolean valid(int source,long token){return source>=0&&source<3&&token>0&&revisions[source]==token;}
    synchronized void invalidate(int source){if(source<0){for(int i=0;i<3;i++)issue(i);}else issue(source);}
}
