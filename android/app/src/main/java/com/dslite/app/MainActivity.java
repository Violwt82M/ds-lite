package com.dslite.app;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 分享 / 打开方式进来的归档由这个插件接住
        registerPlugin(SharedArchivePlugin.class);
        // 轻量局域网临时网页快传插件（用完即关，不常驻后台）
        registerPlugin(LanTransferPlugin.class);
        super.onCreate(savedInstanceState);
        // 顶部保留状态栏安全区，底部让 WebView 与聊天壁纸铺满至系统导航栏下方，
        // 同时将导航栏高度注入 --ds-nav-inset，确保悬浮输入框与软键盘避让正常。
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        View content = findViewById(android.R.id.content);
        if (content != null) {
            ViewCompat.setOnApplyWindowInsetsListener(
                    content,
                    (v, windowInsets) -> {
                        Insets statusBars = windowInsets.getInsets(WindowInsetsCompat.Type.statusBars());
                        Insets navBars = windowInsets.getInsets(WindowInsetsCompat.Type.navigationBars());
                        Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                        int bottomPad = Math.max(0, ime.bottom);
                        v.setPadding(navBars.left, statusBars.top, navBars.right, bottomPad);
                        float density = getResources().getDisplayMetrics().density;
                        int navCssPx = ime.bottom > 0 ? 0 : Math.round(navBars.bottom / Math.max(1f, density));
                        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                        if (webView != null) {
                            webView.post(
                                    () ->
                                            webView.evaluateJavascript(
                                                    "document.documentElement.style.setProperty('--ds-nav-inset','"
                                                            + navCssPx
                                                            + "px');",
                                                    null));
                        }
                        return WindowInsetsCompat.CONSUMED;
                    });
        }
        // 深色壁纸下状态栏图标要反过来，否则时间和电量在黑色底上看不见
        getBridge().getWebView().addJavascriptInterface(new StatusBarBridge(this), "DSLiteNative");
        // 应用内更新：下载 APK + 拉起系统安装器
        getBridge().getWebView().addJavascriptInterface(new ApkUpdaterBridge(this), "DSLiteUpdater");
    }
}
