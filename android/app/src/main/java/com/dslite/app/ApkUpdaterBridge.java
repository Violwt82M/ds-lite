package com.dslite.app;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;

import androidx.core.content.FileProvider;

import java.io.File;

/**
 * 应用内更新：下载 APK，再拉起系统安装器。
 *
 * 为什么用 DownloadManager：它走系统下载（通知栏有进度、支持断点续传、不受 WebView
 * 的跨域限制），比网页里 fetch 一个 5 MB 的包稳。
 * Android 不允许应用静默安装，所以最后那下「安装」按钮永远是用户自己点的，我们只能
 * 把文件准备好、把安装器叫起来。
 */
public class ApkUpdaterBridge {

    private final MainActivity activity;
    private long downloadId = -1L;
    private String destPath;
    private BroadcastReceiver receiver;

    ApkUpdaterBridge(MainActivity activity) {
        this.activity = activity;
    }

    /** 系统是否已经允许本应用安装 APK（Android 8+ 需要用户手动开） */
    @JavascriptInterface
    public boolean canInstall() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return activity.getPackageManager().canRequestPackageInstalls();
        }
        return true;
    }

    /** 跳到「安装未知应用」的系统设置页 */
    @JavascriptInterface
    public void openInstallSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(intent);
        } catch (Exception ignored) {
            // 个别 ROM 换了这个页面的入口，打不开就算了，用户可以走浏览器下载
        }
    }

    /** 把下载请求入队；false 表示只能退回浏览器下载 */
    @JavascriptInterface
    public boolean download(String url, String version) {
        try {
            DownloadManager manager = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null || url == null || !url.startsWith("https://")) {
                return false;
            }
            String safeVersion = (version == null || version.isEmpty() ? "update" : version)
                    .replaceAll("[^0-9A-Za-z._-]", "");
            File dir = new File(activity.getExternalFilesDir(null), "updates");
            if (!dir.exists() && !dir.mkdirs()) {
                return false;
            }
            File apk = new File(dir, "ds-lite-" + safeVersion + ".apk");
            if (apk.exists() && !apk.delete()) {
                return false;
            }
            destPath = apk.getAbsolutePath();

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle("DS Lite " + safeVersion);
            request.setDescription("正在下载更新包…");
            request.setMimeType("application/vnd.android.package-archive");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(activity, null, "updates/" + apk.getName());
            downloadId = manager.enqueue(request);
            registerReceiver();
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    private void registerReceiver() {
        if (receiver != null) {
            return;
        }
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null || !DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
                    return;
                }
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id != downloadId) {
                    return;
                }
                unregisterReceiver();
                activity.runOnUiThread(ApkUpdaterBridge.this::install);
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            activity.registerReceiver(receiver, filter);
        }
    }

    private void unregisterReceiver() {
        if (receiver == null) {
            return;
        }
        try {
            activity.unregisterReceiver(receiver);
        } catch (Exception ignored) {
            // 已经注销过了
        }
        receiver = null;
    }

    private void install() {
        if (destPath == null) {
            return;
        }
        File apk = new File(destPath);
        if (!apk.exists()) {
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception ignored) {
            // 没有安装权限时系统会自己弹「允许安装」，这里失败就让用户去发布页下
        }
    }
}
