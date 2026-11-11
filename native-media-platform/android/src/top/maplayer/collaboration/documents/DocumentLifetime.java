package top.maplayer.collaboration.documents;

/** Per-Activity result ownership. Configuration recreation leaves the OS request outstanding. */
final class DocumentLifetime {
    private boolean terminal;
    boolean acceptResult() {
        if (terminal) return false;
        terminal = true;
        return true;
    }
    boolean cancelOnDestroy(boolean changingConfigurations) {
        if (changingConfigurations || terminal) return false;
        terminal = true;
        return true;
    }
}
