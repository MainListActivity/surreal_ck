package top.maplayer.collaboration.update;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.security.MessageDigest;

/** 仅供已通过签名策略验证的 Rust/JNI 宿主调用。此类不提供 Ready 状态。 */
public final class RequiredUpdater {
    private RequiredUpdater() {}
    public static String privateDataDirectory(Context context) {
        return context.getFilesDir().getAbsolutePath();
    }
    public static boolean installationAllowed(Context context) {
        return context.getPackageManager().canRequestPackageInstalls();
    }
    private static String sha256(byte[] bytes) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder result = new StringBuilder();
        for (byte value : hash) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
    /** 返回 session id，只表示提交；成功/等待权限/失败由平台回调判定。 */
    public static int install(Context context, byte[] verifiedApk, String expectedSha256,
                              String expectedSignerSha256,
                              String expectedVersionName) throws Exception {
        if (!sha256(verifiedApk).equalsIgnoreCase(expectedSha256)) throw new SecurityException("APK digest mismatch");
        if (!context.getPackageManager().canRequestPackageInstalls()) {
            // 不自动打开设置、不尝试 adb/root/accessibility 绕过。
            throw new SecurityException("System install permission requires user action");
        }
        File staged = File.createTempFile("required-update-", ".apk", context.getCacheDir());
        try {
            try (FileOutputStream output = new FileOutputStream(staged)) {
                output.write(verifiedApk); output.getFD().sync();
            }
            PackageInfo info = context.getPackageManager().getPackageArchiveInfo(staged.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
            if (info == null || !context.getPackageName().equals(info.packageName)
                || info.getLongVersionCode() <= context.getPackageManager().getPackageInfo(context.getPackageName(), 0).getLongVersionCode()
                || !expectedVersionName.equals(info.versionName)
                || info.signingInfo == null) throw new SecurityException("APK identity/version mismatch");
            android.content.pm.Signature[] signers = info.signingInfo.getApkContentsSigners();
            if (signers.length != 1 || !sha256(signers[0].toByteArray()).equalsIgnoreCase(expectedSignerSha256))
                throw new SecurityException("APK publisher mismatch");
            PackageInstaller installer = context.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(context.getPackageName());
            params.setSize(verifiedApk.length);
            if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            int id = installer.createSession(params);
            boolean committed = false;
            try (PackageInstaller.Session session = installer.openSession(id)) {
                try (OutputStream output = session.openWrite("base.apk", 0, verifiedApk.length)) {
                    output.write(verifiedApk); session.fsync(output);
                }
                Intent result = new Intent(context, UpdateResultReceiver.class).setAction(context.getPackageName() + ".UPDATE_RESULT");
                // 显式目标、每session独立requestCode。系统必须能填充状态，故为 MUTABLE。
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                session.commit(PendingIntent.getBroadcast(context, id, result, flags).getIntentSender());
                committed = true;
            } finally { if (!committed) installer.abandonSession(id); }
            return id;
        } finally { if (!staged.delete()) staged.deleteOnExit(); }
    }
}
