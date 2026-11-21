package com.dslite.app;

import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.PowerManager;
import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 同步保活：连接建立后拿 WiFi 锁 + CPU 锁 + 保持屏幕常亮 + 前台服务，
 * 避免息屏/后台时 WebRTC 连接被系统掐断。
 */
@CapacitorPlugin(name = "SyncKeepAlive")
public class SyncKeepAlivePlugin extends Plugin {

    private WifiManager.WifiLock wifiLock;
    private PowerManager.WakeLock wakeLock;

    @PluginMethod
    public void acquire(PluginCall call) {
        Context context = getContext();

        // 1) WiFi 高性能锁：防止息屏后 WiFi 进入省电模式
        if (wifiLock == null) {
            WifiManager wifiManager = (WifiManager) context.getApplicationContext()
                .getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "dslite:sync");
                wifiLock.setReferenceCounted(false);
            }
        }
        if (wifiLock != null && !wifiLock.isHeld()) {
            try { wifiLock.acquire(); } catch (Exception ignored) {}
        }

        // 2) CPU 局部唤醒锁：息屏后仍能处理 DataChannel 消息
        if (wakeLock == null) {
            PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (powerManager != null) {
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dslite:sync");
                wakeLock.setReferenceCounted(false);
            }
        }
        if (wakeLock != null && !wakeLock.isHeld()) {
            try { wakeLock.acquire(); } catch (Exception ignored) {}
        }

        // 3) 屏幕常亮：同步期间不让系统自动息屏（用户手动锁屏不受影响）
        try {
            if (getActivity() != null) {
                getActivity().runOnUiThread(() ->
                    getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                );
            }
        } catch (Exception ignored) {}

        // 4) 前台服务：降低后台被系统回收的概率
        try {
            Intent intent = new Intent(context, SyncKeepAliveService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception ignored) {}

        call.resolve();
    }

    @PluginMethod
    public void release(PluginCall call) {
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {}
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {}
        try {
            if (getActivity() != null) {
                getActivity().runOnUiThread(() ->
                    getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                );
            }
        } catch (Exception ignored) {}
        try {
            getContext().stopService(new Intent(getContext(), SyncKeepAliveService.class));
        } catch (Exception ignored) {}
        call.resolve();
    }
}
