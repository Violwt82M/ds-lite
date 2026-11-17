package com.dslite.app;

import android.webkit.JavascriptInterface;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * 给网页侧的最小原生接口：只负责切换状态栏/导航栏图标的明暗。
 * Android 15 上 App 是边到边，网页画在状态栏下面，换成深色壁纸后系统默认的深色图标
 * （时间、电量、信号）在黑色底上完全看不见，这一段 WebView 自己改不了。
 */
public class StatusBarBridge {

    private final MainActivity activity;

    StatusBarBridge(MainActivity activity) {
        this.activity = activity;
    }

    /** light = true 表示要用浅色图标（深色背景时） */
    @JavascriptInterface
    public void setLightIcons(final boolean light) {
        activity.runOnUiThread(
                () -> {
                    WindowInsetsControllerCompat controller =
                            WindowCompat.getInsetsController(
                                    activity.getWindow(), activity.getWindow().getDecorView());
                    controller.setAppearanceLightStatusBars(!light);
                    controller.setAppearanceLightNavigationBars(!light);
                });
    }
}
