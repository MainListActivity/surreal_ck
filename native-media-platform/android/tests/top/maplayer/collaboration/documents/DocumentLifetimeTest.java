package top.maplayer.collaboration.documents;
/** Pure lifecycle ownership tests; does not simulate Android or provider I/O. */
public final class DocumentLifetimeTest {
    private DocumentLifetimeTest() {}
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) {
        DocumentLifetime closed = new DocumentLifetime();
        check(closed.cancelOnDestroy(false));
        check(!closed.acceptResult());
        check(!closed.cancelOnDestroy(false));
        DocumentLifetime rotating = new DocumentLifetime();
        check(!rotating.cancelOnDestroy(true));
        DocumentLifetime recreated = new DocumentLifetime();
        check(recreated.acceptResult());
        check(!recreated.cancelOnDestroy(false));
        DocumentLifetime copying = new DocumentLifetime();
        check(copying.acceptResult());
        check(!copying.acceptResult());
        check(!copying.cancelOnDestroy(false));
        System.out.println("PASS: SAF final destruction, recreation, duplicate result and copy ownership");
    }
}
