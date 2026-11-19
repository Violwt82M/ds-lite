package com.dslite.app;

import android.content.Context;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.SocketException;
import java.util.Enumeration;

/**
 * 局域网 HTTP server + 本机 IP 查询。
 * 用途：Capacitor APK 在局域网里暴露本地 HTTP 端口，
 * 让同一 WiFi 下的其他设备能自动发现、并交换 SDP 配对信息。
 */
@CapacitorPlugin(name = "HttpServer")
public class HttpServerPlugin extends Plugin {

    private com.sun.net.httpserver.HttpServer httpServer;
    private int runningPort = -1;

    /** 开一个本地 HTTP server，返回 url / ip / port */
    @PluginMethod
    public void startServer(PluginCall call) {
        int port = call.getInt("port", 7321);

        if (httpServer != null) {
            // 已经在跑了，直接返回现有信息
            String ip = getWifiIp();
            JSObject r = new JSObject();
            r.put("url", "http://" + ip + ":" + runningPort);
            r.put("ip", ip);
            r.put("port", runningPort);
            r.put("alreadyRunning", true);
            call.resolve(r);
            return;
        }

        try {
            httpServer = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress(port), 0);

            // 路由 1: 健康检查 / 设备发现
            httpServer.createContext("/ping", exchange -> {
                JSObject body = new JSObject();
                body.put("ok", true);
                body.put("app", "DS Lite");
                try { body.put("deviceId", getContext().getPackageName()); } catch (Exception ignored) {}
                writeJson(exchange, 200, body.toString());
            });

            // 路由 2: 设备列表（占位，Phase 2A 完整版做真正的 mDNS 发现）
            httpServer.createContext("/devices", exchange -> {
                JSObject body = new JSObject();
                body.put("devices", new org.json.JSONArray());
                writeJson(exchange, 200, body.toString());
            });

            httpServer.setExecutor(null);
            httpServer.start();
            runningPort = port;

            String ip = getWifiIp();
            JSObject r = new JSObject();
            r.put("url", "http://" + ip + ":" + port);
            r.put("ip", ip);
            r.put("port", port);
            r.put("alreadyRunning", false);
            call.resolve(r);

        } catch (IOException e) {
            httpServer = null;
            call.reject("启动 HTTP server 失败: " + e.getMessage(), "SERVER_START_FAILED", e);
        }
    }

    /** 关 server */
    @PluginMethod
    public void stopServer(PluginCall call) {
        if (httpServer != null) {
            httpServer.stop(0);
            httpServer = null;
            runningPort = -1;
            JSObject r = new JSObject();
            r.put("stopped", true);
            call.resolve(r);
        } else {
            JSObject r = new JSObject();
            r.put("stopped", true);
            call.resolve(r);
        }
    }

    /** 只查本机 WiFi IP，不开 server */
    @PluginMethod
    public void getLocalIp(PluginCall call) {
        String ip = getWifiIp();
        JSObject r = new JSObject();
        r.put("ip", ip);
        call.resolve(r);
    }

    /** 查所有网络接口的 IP（WiFi、蜂窝、VPN 可能各一个） */
    @PluginMethod
    public void getAllIps(PluginCall call) {
        java.util.List<String> ips = new java.util.ArrayList<>();
        try {
            Enumeration<NetworkInterface> nets = NetworkInterface.getNetworkInterfaces();
            while (nets.hasMoreElements()) {
                NetworkInterface ni = nets.nextElement();
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!a.isLoopbackAddress() && !a.isLinkLocalAddress()
                            && a instanceof java.net.Inet4Address) {
                        ips.add(a.getHostAddress());
                    }
                }
            }
        } catch (SocketException ignored) {}

        org.json.JSONArray arr = new org.json.JSONArray(ips);
        JSObject r = new JSObject();
        try { r.put("ips", arr); } catch (JSONException ignored) {}
        call.resolve(r);
    }

    /** 避免 Activity 被销毁时 server 悬空 */
    @Override
    protected void handleOnDestroy() {
        if (httpServer != null) {
            httpServer.stop(0);
            httpServer = null;
            runningPort = -1;
        }
        super.handleOnDestroy();
    }

    // ============ 辅助 ============

    /** 优先返回 WiFi IP（192.168.x.x 或 10.x.x.x），拿不到就用第一个非回环的 */
    private String getWifiIp() {
        // 方案 A: WiFiManager（需要 ACCESS_WIFI_STATE，没装也不会崩）
        try {
            Context ctx = getContext();
            WifiManager wm = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                WifiInfo wi = wm.getConnectionInfo();
                int ipInt = wi.getIpAddress();
                if (ipInt != 0) {
                    return String.format(Locale.CHINA,
                        "%d.%d.%d.%d",
                        ipInt & 0xFF,
                        (ipInt >> 8) & 0xFF,
                        (ipInt >> 16) & 0xFF,
                        (ipInt >> 24) & 0xFF);
                }
            }
        } catch (Exception ignored) {}

        // 方案 B: 扫所有接口找 IPv4 非回环
        try {
            Enumeration<NetworkInterface> nets = NetworkInterface.getNetworkInterfaces();
            while (nets.hasMoreElements()) {
                NetworkInterface ni = nets.nextElement();
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!a.isLoopbackAddress() && !a.isLinkLocalAddress()
                            && a instanceof java.net.Inet4Address) {
                        return a.getHostAddress();
                    }
                }
            }
        } catch (SocketException ignored) {}

        return "127.0.0.1";
    }

    private void writeJson(com.sun.net.httpserver.HttpExchange ex, int code, String json) {
        try {
            byte[] bytes = json.getBytes("UTF-8");
            ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
            ex.sendResponseHeaders(code, bytes.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(bytes);
            }
        } catch (IOException ignored) {}
    }
}
