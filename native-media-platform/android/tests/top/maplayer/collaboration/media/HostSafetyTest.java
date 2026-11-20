package top.maplayer.collaboration.media;
/** Pure host state tests. No Android stub is executed, no permission is granted, no capture starts. */
public final class HostSafetyTest {
    private HostSafetyTest() {}
    private static void check(boolean value){if(!value)throw new AssertionError();}
    private static void stopInvalidatesOutstandingPermission(){
        CaptureRequests requests=new CaptureRequests();
        long permission=requests.issue(1);
        check(requests.valid(1,permission));
        requests.invalidate(-1); // Notification stop during the OS permission dialog.
        check(!requests.valid(1,permission)); // Later consent cannot resurrect the old request.
        long next=requests.issue(1);
        check(requests.valid(1,next));check(!requests.valid(1,permission));
    }
    private static void stoppingOneTrackPreservesOtherAuthorization(){
        CaptureRequests requests=new CaptureRequests();
        long microphone=requests.issue(0),camera=requests.issue(1),screen=requests.issue(2);
        requests.invalidate(1);
        check(requests.valid(0,microphone));check(!requests.valid(1,camera));check(requests.valid(2,screen));
        requests.invalidate(-1);
        check(!requests.valid(0,microphone));check(!requests.valid(2,screen));
    }
    private static void repeatedRequestNeverRestoresOldToken(){
        CaptureRequests requests=new CaptureRequests();
        long first=requests.issue(2),second=requests.issue(2);
        check(!requests.valid(2,first));check(requests.valid(2,second));
        requests.invalidate(2);requests.invalidate(2);
        check(!requests.valid(2,first));check(!requests.valid(2,second));
        long third=requests.issue(2);check(requests.valid(2,third));
        check(!requests.valid(2,first));check(!requests.valid(2,second));
        check(!requests.valid(-1,third));check(!requests.valid(3,third));check(!requests.valid(0,0));
    }
    private static void cleanupAttemptsEveryDistinctResource(){
        int[] mask={0};IllegalStateException original=new IllegalStateException("construction");
        boolean failed=false;
        try{MediaReleaseFailure.releaseOrThrow(original,
            ()->{mask[0]|=1;throw new IllegalStateException("codec release");},
            ()->{mask[0]|=2;throw new IllegalStateException("recorder release");},
            ()->mask[0]|=4);
        }catch(MediaReleaseFailure expected){
            failed=true;check(expected.getCause()==original);check(expected.getSuppressed().length==1);
            check(expected.getSuppressed()[0].getSuppressed().length==1);
        }
        check(failed&&mask[0]==7); // All three distinct resources attempted; still unconfirmed.
    }
    private static void successfulCleanupDoesNotFabricateFailure(){
        int[] mask={0};
        MediaReleaseFailure.releaseOrThrow(new IllegalStateException("not thrown"),()->mask[0]|=1,()->mask[0]|=2);
        check(mask[0]==3);
    }
    public static void main(String[] args){
        stopInvalidatesOutstandingPermission();stoppingOneTrackPreservesOtherAuthorization();
        repeatedRequestNeverRestoresOldToken();cleanupAttemptsEveryDistinctResource();successfulCleanupDoesNotFabricateFailure();
        System.out.println("PASS: 5 pure permission-generation and resource-cleanup negative/positive tests");
    }
}
