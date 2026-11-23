package com.dslite.app;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.JavascriptInterface;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * 给网页侧的最小原生接口：负责切换状态栏/导航栏底色与图标明暗。
 * Android 15（API 35+）强制边到边后 setStatusBarColor/setNavigationBarColor 会被忽略，
 * 系统栏后面露出的是 Window/DecorView/根容器背景，因此必须一并刷背景色并关闭对比度白蒙层。
 */
public class StatusBarBridge {

    private final MainActivity activity;

    StatusBarBridge(MainActivity activity) {
        this.activity = activity;
    }

    /** light = true 表示深色背景，需要使用浅色图标 + 深色状态栏/导航栏底色 */
    @SuppressWarnings("deprecation")
    @JavascriptInterface
    public void setLightIcons(final boolean light) {
        activity.runOnUiThread(
                () -> {
                    int barColor = light ? Color.parseColor("#14161c") : Color.WHITE;
                    Window window = activity.getWindow();
                    window.setBackgroundDrawable(new ColorDrawable(barColor));
                    View decor = window.getDecorView();
                    decor.setBackgroundColor(barColor);
                    View content = activity.findViewById(android.R.id.content);
                    if (content != null) {
                        content.setBackgroundColor(barColor);
                        if (content instanceof ViewGroup && ((ViewGroup) content).getChildCount() > 0) {
                            ((ViewGroup) content).getChildAt(0).setBackgroundColor(barColor);
                        }
                    }
                    window.setStatusBarColor(barColor);
                    // 底部导航栏保持透明，让聊天壁纸自然延伸至屏幕最底端
                    window.setNavigationBarColor(Color.TRANSPARENT);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        window.setStatusBarContrastEnforced(false);
                        window.setNavigationBarContrastEnforced(false);
                    }
                    WindowInsetsControllerCompat controller =
                            WindowCompat.getInsetsController(window, decor);
                    controller.setAppearanceLightStatusBars(!light);
                    controller.setAppearanceLightNavigationBars(!light);
                });
    }
}
