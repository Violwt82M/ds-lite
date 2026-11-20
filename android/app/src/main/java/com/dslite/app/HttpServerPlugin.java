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
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.InetSocketAddress;
import java.util.Enumeration;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 局域网 HTTP server + 本机 IP 查询（纯 ServerSocket 实现，无 JDK 内部 API）。
 * 用途：Capacitor APK 在局域网里暴露本地 HTTP 端口，
 * 让同一 WiFi 下的其他设备能自动发现、并交换 SDP 配对信息。
 */
@CapacitorPlugin(name = "HttpServer")
public class HttpServerPlugin extends Plugin {

    private volatile ServerSocket serverSocket;
    private Thread acceptThread;
    private ExecutorService pool;
    private int runningPort = -1;
    private volatile boolean running = false;
    /** 通过 HTTP 信令交换的 SDP：本机发布 offer，浏览器/其他设备 POST answer 回来 */
    private volatile String pairingOffer = null;
    private volatile String pairingAnswer = null;

    /** WebView 侧生成 Offer 后调用，把这个码挂到 /offer 上供浏览器拉取 */
    @PluginMethod
    public void setPairingOffer(PluginCall call) {
        pairingOffer = call.getString("code");
        pairingAnswer = null;
        JSObject r = new JSObject();
        r.put("ok", true);
        call.resolve(r);
    }

    /** 断开 / 停止热点时清空信令 */
    @PluginMethod
    public void clearPairing(PluginCall call) {
        pairingOffer = null;
        pairingAnswer = null;
        call.resolve();
    }

    /** 开一个本地 HTTP server，返回 url / ip / port */
    @PluginMethod
    public void startServer(PluginCall call) {
        int port = call.getInt("port", 7321);

        if (running && serverSocket != null && !serverSocket.isClosed()) {
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
            serverSocket = new ServerSocket();
            serverSocket.setReuseAddress(true);
            serverSocket.bind(new InetSocketAddress(port));
            pool = Executors.newCachedThreadPool();
            running = true;
            runningPort = serverSocket.getLocalPort();

            acceptThread = new Thread(() -> {
                while (running) {
                    try {
                        Socket client = serverSocket.accept();
                        pool.execute(() -> handleClient(client));
                    } catch (IOException e) {
                        if (running) {
                            // 非 running 状态下是 close 导致的正常退出
                        }
                        break;
                    }
                }
            }, "DSLite-HttpServer-Accept");
            acceptThread.setDaemon(true);
            acceptThread.start();

            String ip = getWifiIp();
            JSObject r = new JSObject();
            r.put("url", "http://" + ip + ":" + runningPort);
            r.put("ip", ip);
            r.put("port", runningPort);
            r.put("alreadyRunning", false);
            call.resolve(r);

        } catch (IOException e) {
            serverSocket = null;
            pool = null;
            running = false;
            runningPort = -1;
            call.reject("启动 HTTP server 失败: " + e.getMessage(), "SERVER_START_FAILED", e);
        }
    }

    /** 关 server */
    @PluginMethod
    public void stopServer(PluginCall call) {
        running = false;
        pairingOffer = null;
        pairingAnswer = null;
        if (pool != null) {
            pool.shutdownNow();
            pool = null;
        }
        if (serverSocket != null) {
            try { serverSocket.close(); } catch (IOException ignored) {}
            serverSocket = null;
        }
        runningPort = -1;
        JSObject r = new JSObject();
        r.put("stopped", true);
        call.resolve(r);
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
        r.put("ips", arr);
        call.resolve(r);
    }

    /** 避免 Activity 被销毁时 server 悬空 */
    @Override
    protected void handleOnDestroy() {
        running = false;
        pairingOffer = null;
        pairingAnswer = null;
        if (pool != null) { pool.shutdownNow(); pool = null; }
        if (serverSocket != null) {
            try { serverSocket.close(); } catch (IOException ignored) {}
            serverSocket = null;
        }
        runningPort = -1;
        super.handleOnDestroy();
    }

    // ============ Server 逻辑 ============

    private void handleClient(Socket client) {
        try {
            InputStreamReader isr = new InputStreamReader(client.getInputStream(), "UTF-8");
            BufferedReader br = new BufferedReader(isr);
            String line = br.readLine();
            if (line == null) { client.close(); return; }

            // 解析 "GET /ping HTTP/1.1"
            String[] parts = line.split(" ");
            if (parts.length < 2) { client.close(); return; }
            String method = parts[0];
            String path = parts[1];

            // 读 headers（主要是 Content-Length，用来读 POST body）
            int contentLength = 0;
            String headerLine;
            while ((headerLine = br.readLine()) != null && !headerLine.isEmpty()) {
                String lower = headerLine.toLowerCase(Locale.ROOT);
                if (lower.startsWith("content-length:")) {
                    try {
                        contentLength = Integer.parseInt(headerLine.substring(15).trim());
                    } catch (Exception ignored) {}
                }
            }

            // 浏览器 POST JSON 前会先发 OPTIONS 预检
            if ("OPTIONS".equals(method)) {
                writeCorsPreflight(client);
                return;
            }

            // GET /offer：返回本机发布的 Offer 配对码
            if ("GET".equals(method) && "/offer".equals(path)) {
                if (pairingOffer == null || pairingOffer.isEmpty()) {
                    writeJson(client, 404, "{\"error\":\"no offer\"}");
                    return;
                }
                try {
                    JSONObject body = new JSONObject();
                    body.put("code", pairingOffer);
                    body.put("app", "DS Lite");
                    writeJson(client, 200, body.toString());
                } catch (JSONException e) {
                    writeJson(client, 500, "{\"error\":\"encode failed\"}");
                }
                return;
            }

            // POST /answer：其他设备返回 Answer，转交给 WebView 应用
            if ("POST".equals(method) && "/answer".equals(path)) {
                StringBuilder body = new StringBuilder();
                int remaining = contentLength;
                char[] buffer = new char[1024];
                while (remaining > 0) {
                    int read = br.read(buffer, 0, Math.min(buffer.length, remaining));
                    if (read < 0) break;
                    body.append(buffer, 0, read);
                    remaining -= read;
                }
                try {
                    JSONObject payload = new JSONObject(body.toString());
                    String code = payload.optString("code", null);
                    if (code == null || code.isEmpty()) {
                        writeJson(client, 400, "{\"error\":\"missing code\"}");
                        return;
                    }
                    pairingAnswer = code;
                    JSObject data = new JSObject();
                    data.put("code", code);
                    notifyListeners("answer", data);
                    writeJson(client, 200, "{\"ok\":true}");
                } catch (Exception e) {
                    writeJson(client, 400, "{\"error\":\"bad json\"}");
                }
                return;
            }

            String json;
            switch (path) {
                case "/ping":
                    JSObject ping = new JSObject();
                    ping.put("ok", true);
                    ping.put("app", "DS Lite");
                    try { ping.put("deviceId", getContext().getPackageName()); } catch (Exception ignored) {}
                    json = ping.toString();
                    break;
                case "/devices":
                    org.json.JSONArray arr = new org.json.JSONArray();
                    json = arr.toString();
                    break;
                default:
                    json = "{\"error\":\"not found\"}";
                    break;
            }
            boolean known = path.equals("/ping") || path.equals("/devices");
            if (!known) {
                // 让 POST /answer 之外的方法也有明确响应
                writeJson(client, 404, "{\"error\":\"not found\"}");
                return;
            }
            writeJson(client, 200, json);
        } catch (IOException ignored) {
        } finally {
            try { client.close(); } catch (IOException ignored) {}
        }
    }

    private void writeCorsPreflight(Socket client) {
        try {
            String header = "HTTP/1.1 204 No Content\r\n"
                    + "Access-Control-Allow-Origin: *\r\n"
                    + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                    + "Access-Control-Allow-Headers: Content-Type\r\n"
                    + "Access-Control-Max-Age: 86400\r\n"
                    + "Content-Length: 0\r\n\r\n";
            OutputStream os = client.getOutputStream();
            os.write(header.getBytes("UTF-8"));
            os.flush();
        } catch (IOException ignored) {}
    }

    private void writeJson(Socket client, int code, String json) {
        try {
            byte[] bytes = json.getBytes("UTF-8");
            String statusText =
                code == 200 ? "OK" :
                code == 204 ? "No Content" :
                code == 400 ? "Bad Request" :
                code == 404 ? "Not Found" :
                code == 503 ? "Service Unavailable" : "Error";
            String header = "HTTP/1.1 " + code + " " + statusText + "\r\n"
                    + "Content-Type: application/json; charset=utf-8\r\n"
                    + "Content-Length: " + bytes.length + "\r\n"
                    + "Access-Control-Allow-Origin: *\r\n"
                    + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                    + "Access-Control-Allow-Headers: Content-Type\r\n"
                    + "Connection: close\r\n\r\n";
            OutputStream os = client.getOutputStream();
            os.write(header.getBytes("UTF-8"));
            os.write(bytes);
            os.flush();
        } catch (IOException ignored) {}
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
                    return String.format(Locale.US,
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
}
