package top.maplayer.collaboration.update;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/** 非导出 receiver；只记录结果，不解锁旧版本或自行启动系统授权页面。 */
public final class UpdateResultReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!(context.getPackageName() + ".UPDATE_RESULT").equals(intent.getAction())) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String state;
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) state = "system-consent-required";
        else if (status == PackageInstaller.STATUS_SUCCESS) state = "installed-recheck-on-launch";
        else state = "failed";
        context.getSharedPreferences("required-update", Context.MODE_PRIVATE).edit().putString("state", state).apply();
        // 安装可能杀死进程；新进程仍必须重新经过 Rust 签名策略门。
    }
}
