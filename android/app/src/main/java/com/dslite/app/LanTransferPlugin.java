package com.dslite.app;

import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 轻量局域网临时网页快传插件：
 * - 纯 Java 标准库 ServerSocket / Socket，不引入第三方依赖、不常驻后台、不需要额外权限；
 * - 每次启动生成随机 6 位数字口令，关窗即停端口；
 * - 电脑或另一台手机打开 http://<手机IP>:<端口> 输入 6 位口令即可高速收发 ZIP 备份包。
 */
@CapacitorPlugin(name = "LanTransfer")
public class LanTransferPlugin extends Plugin {
    private static final int DEFAULT_PORT = 18666;
    private static final long MAX_UPLOAD_BYTES = 512L * 1024L * 1024L;

    private final Object lock = new Object();
    private ServerSocket serverSocket;
    private ExecutorService pool;
    private volatile boolean running = false;
    private volatile String activePin = "";
    private volatile File exportFile = null;
    private volatile String exportFileName = "deepseek_data-sync.zip";

    @PluginMethod
    public void startServer(PluginCall call) {
        String rawPath = call.getString("filePath");
        String fileName = call.getString("fileName", "deepseek_data-sync.zip");
        int preferredPort = call.getInt("port", DEFAULT_PORT);

        File targetFile = resolveLocalFile(rawPath);
        if (targetFile == null || !targetFile.exists() || !targetFile.isFile()) {
            call.reject("待传输的备份文件不存在");
            return;
        }

        String lanIp = detectLanIp();
        if (lanIp == null) {
            call.reject("未检测到局域网 Wi-Fi 地址，请确认手机已连接 Wi-Fi 或开启个人热点");
            return;
        }

        synchronized (lock) {
            stopServerInternal();
            ServerSocket ss = openServerSocket(preferredPort);
            if (ss == null) {
                call.reject("无法开启局域网端口，请稍后重试");
                return;
            }
            String pin = String.format(Locale.US, "%06d", new SecureRandom().nextInt(1_000_000));
            this.serverSocket = ss;
            this.activePin = pin;
            this.exportFile = targetFile;
            this.exportFileName = sanitizeFileName(fileName);
            this.running = true;
            this.pool = Executors.newCachedThreadPool();

            final ServerSocket bound = ss;
            Thread acceptThread = new Thread(() -> acceptLoop(bound), "ds-lite-lan-accept");
            acceptThread.setDaemon(true);
            acceptThread.start();

            int port = ss.getLocalPort();
            JSObject res = new JSObject();
            res.put("ip", lanIp);
            res.put("port", port);
            res.put("pin", pin);
            res.put("url", "http://" + lanIp + ":" + port);
            call.resolve(res);
        }
    }

    @PluginMethod
    public void stopServer(PluginCall call) {
        synchronized (lock) {
            stopServerInternal();
        }
        JSObject res = new JSObject();
        res.put("stopped", true);
        call.resolve(res);
    }

    /** 安卓端直接拉取另一台手机的局域网分享：走原始 Socket 避开明文 HTTP 全局策略限制 */
    @PluginMethod
    public void pullFromLan(PluginCall call) {
        String rawAddress = call.getString("address", "").trim();
        String pin = call.getString("pin", "").trim();
        if (rawAddress.isEmpty() || pin.isEmpty()) {
            call.reject("请填写局域网地址和 6 位口令");
            return;
        }

        String normalized = rawAddress.startsWith("http://") || rawAddress.startsWith("https://")
                ? rawAddress
                : "http://" + rawAddress;
        Uri uri = Uri.parse(normalized);
        String host = uri.getHost();
        int port = uri.getPort() > 0 ? uri.getPort() : DEFAULT_PORT;
        if (host == null || !isPrivateLanIpv4(host)) {
            call.reject("仅支持连接局域网内网地址（如 192.168.x.x）");
            return;
        }

        Executors.newSingleThreadExecutor().execute(() -> {
            File outFile = new File(getContext().getCacheDir(), "lan-pulled-" + System.currentTimeMillis() + ".zip");
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(host, port), 6000);
                socket.setSoTimeout(30_000);

                OutputStream out = socket.getOutputStream();
                String req = "GET /download?pin=" + pin + " HTTP/1.1\r\n"
                        + "Host: " + host + ":" + port + "\r\n"
                        + "Connection: close\r\n\r\n";
                out.write(req.getBytes(StandardCharsets.US_ASCII));
                out.flush();

                BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
                String statusLine = readHeaderLine(in);
                if (statusLine == null) {
                    throw new IOException("对方设备无响应");
                }
                int statusCode = parseStatusCode(statusLine);
                Map<String, String> headers = readHeaders(in);
                if (statusCode == 403) {
                    throw new IOException("6 位口令不正确，请核对后重试");
                }
                if (statusCode != 200) {
                    throw new IOException("拉取失败（状态码 " + statusCode + "）");
                }

                long total = 0;
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    byte[] buf = new byte[32768];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        fos.write(buf, 0, n);
                        total += n;
                    }
                }
                if (!isZipFile(outFile)) {
                    //noinspection ResultOfMethodCallIgnored
                    outFile.delete();
                    throw new IOException("收到的文件不是有效的 ZIP 备份包");
                }

                String fileName = parseContentDispositionName(headers.get("content-disposition"));
                JSObject res = new JSObject();
                res.put("path", outFile.getAbsolutePath());
                res.put("name", fileName);
                res.put("size", total);
                call.resolve(res);
            } catch (Exception e) {
                if (outFile.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    outFile.delete();
                }
                call.reject(e.getMessage() != null ? e.getMessage() : "局域网拉取失败");
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (lock) {
            stopServerInternal();
        }
        super.handleOnDestroy();
    }

    private void stopServerInternal() {
        running = false;
        activePin = "";
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
            serverSocket = null;
        }
        if (pool != null) {
            pool.shutdownNow();
            pool = null;
        }
    }

    private ServerSocket openServerSocket(int preferredPort) {
        try {
            ServerSocket ss = new ServerSocket();
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress(preferredPort));
            return ss;
        } catch (IOException e) {
            try {
                ServerSocket fallback = new ServerSocket(0);
                fallback.setReuseAddress(true);
                return fallback;
            } catch (IOException ignored) {
                return null;
            }
        }
    }

    private void acceptLoop(ServerSocket ss) {
        while (running && !ss.isClosed()) {
            try {
                Socket client = ss.accept();
                ExecutorService currentPool = this.pool;
                if (currentPool != null && !currentPool.isShutdown()) {
                    currentPool.execute(() -> handleClient(client));
                } else {
                    client.close();
                }
            } catch (IOException e) {
                if (!running || ss.isClosed()) {
                    break;
                }
            }
        }
    }

    private void handleClient(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(30_000);
            BufferedInputStream in = new BufferedInputStream(s.getInputStream());
            BufferedOutputStream out = new BufferedOutputStream(s.getOutputStream());

            String requestLine = readHeaderLine(in);
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                sendText(out, 400, "Bad Request", "text/plain; charset=utf-8", "Bad Request");
                return;
            }
            String method = parts[0];
            String fullTarget = parts[1];
            String path = fullTarget;
            Map<String, String> query = new HashMap<>();
            int qIdx = fullTarget.indexOf('?');
            if (qIdx >= 0) {
                path = fullTarget.substring(0, qIdx);
                parseQuery(fullTarget.substring(qIdx + 1), query);
            }

            Map<String, String> headers = readHeaders(in);

            if ("GET".equalsIgnoreCase(method) && ("/".equals(path) || "/index.html".equals(path))) {
                sendText(out, 200, "OK", "text/html; charset=utf-8", buildLandingHtml());
                return;
            }

            String pin = query.get("pin");
            if (pin == null || !pin.equals(activePin) || activePin.isEmpty()) {
                sendText(out, 403, "Forbidden", "application/json; charset=utf-8", "{\"error\":\"口令错误\"}");
                return;
            }

            if ("GET".equalsIgnoreCase(method) && "/download".equals(path)) {
                File file = this.exportFile;
                if (file == null || !file.exists()) {
                    sendText(out, 404, "Not Found", "text/plain; charset=utf-8", "File not found");
                    return;
                }
                String header = "HTTP/1.1 200 OK\r\n"
                        + "Content-Type: application/zip\r\n"
                        + "Content-Disposition: attachment; filename=\"" + exportFileName + "\"\r\n"
                        + "Content-Length: " + file.length() + "\r\n"
                        + "Connection: close\r\n\r\n";
                out.write(header.getBytes(StandardCharsets.US_ASCII));
                try (FileInputStream fis = new FileInputStream(file)) {
                    byte[] buf = new byte[32768];
                    int n;
                    while ((n = fis.read(buf)) != -1) {
                        out.write(buf, 0, n);
                    }
                }
                out.flush();
                return;
            }

            if ("POST".equalsIgnoreCase(method) && "/upload".equals(path)) {
                long contentLength = parseLong(headers.get("content-length"), -1);
                if (contentLength <= 0 || contentLength > MAX_UPLOAD_BYTES) {
                    sendText(out, 400, "Bad Request", "application/json; charset=utf-8", "{\"error\":\"文件大小无效\"}");
                    return;
                }
                String uploadName = sanitizeFileName(query.get("name"));
                File received = new File(getContext().getCacheDir(), "lan-received-" + System.currentTimeMillis() + ".zip");
                long remaining = contentLength;
                try (FileOutputStream fos = new FileOutputStream(received)) {
                    byte[] buf = new byte[32768];
                    while (remaining > 0) {
                        int read = in.read(buf, 0, (int) Math.min(buf.length, remaining));
                        if (read == -1) {
                            break;
                        }
                        fos.write(buf, 0, read);
                        remaining -= read;
                    }
                }
                if (remaining != 0 || !isZipFile(received)) {
                    //noinspection ResultOfMethodCallIgnored
                    received.delete();
                    sendText(out, 400, "Bad Request", "application/json; charset=utf-8", "{\"error\":\"请上传有效的 ZIP 备份包\"}");
                    return;
                }
                sendText(out, 200, "OK", "application/json; charset=utf-8", "{\"ok\":true}");

                JSObject payload = new JSObject();
                payload.put("path", received.getAbsolutePath());
                payload.put("name", uploadName);
                payload.put("size", received.length());
                notifyListeners("fileReceived", payload);
                return;
            }

            sendText(out, 404, "Not Found", "text/plain; charset=utf-8", "Not Found");
        } catch (Exception ignored) {
        }
    }

    private static void sendText(OutputStream out, int code, String reason, String contentType, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + code + " " + reason + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
        out.flush();
    }

    private static String readHeaderLine(InputStream in) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        int prev = -1;
        int cur;
        while ((cur = in.read()) != -1) {
            if (cur == '\n') {
                byte[] arr = baos.toByteArray();
                int len = arr.length;
                if (len > 0 && arr[len - 1] == '\r') {
                    len -= 1;
                }
                return new String(arr, 0, len, StandardCharsets.UTF_8);
            }
            if (baos.size() > 8192) {
                throw new IOException("Header line too long");
            }
            baos.write(cur);
            prev = cur;
        }
        return prev == -1 && baos.size() == 0 ? null : baos.toString("UTF-8");
    }

    private static Map<String, String> readHeaders(InputStream in) throws IOException {
        Map<String, String> map = new HashMap<>();
        String line;
        while ((line = readHeaderLine(in)) != null && !line.isEmpty()) {
            int idx = line.indexOf(':');
            if (idx > 0) {
                map.put(line.substring(0, idx).trim().toLowerCase(Locale.US), line.substring(idx + 1).trim());
            }
        }
        return map;
    }

    private static void parseQuery(String qs, Map<String, String> out) {
        for (String pair : qs.split("&")) {
            int idx = pair.indexOf('=');
            if (idx > 0) {
                try {
                    String k = URLDecoder.decode(pair.substring(0, idx), "UTF-8");
                    String v = URLDecoder.decode(pair.substring(idx + 1), "UTF-8");
                    out.put(k, v);
                } catch (Exception ignored) {
                }
            }
        }
    }

    private static int parseStatusCode(String statusLine) {
        String[] parts = statusLine.split(" ");
        if (parts.length < 2) {
            return 0;
        }
        try {
            return Integer.parseInt(parts[1]);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static long parseLong(String value, long fallback) {
        if (value == null) {
            return fallback;
        }
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static String parseContentDispositionName(String header) {
        if (header != null) {
            int idx = header.indexOf("filename=");
            if (idx >= 0) {
                String raw = header.substring(idx + 9).trim().replace("\"", "");
                if (!raw.isEmpty()) {
                    return sanitizeFileName(raw);
                }
            }
        }
        return "deepseek_data-lan.zip";
    }

    private static String sanitizeFileName(String name) {
        if (name == null || name.trim().isEmpty()) {
            return "deepseek_data-sync.zip";
        }
        String safe = name.trim().replaceAll("[^a-zA-Z0-9._\\-\\u4e00-\\u9fa5]", "_");
        return safe.isEmpty() ? "deepseek_data-sync.zip" : safe;
    }

    private static File resolveLocalFile(String rawPath) {
        if (rawPath == null || rawPath.trim().isEmpty()) {
            return null;
        }
        if (rawPath.startsWith("file://")) {
            Uri uri = Uri.parse(rawPath);
            return uri.getPath() != null ? new File(uri.getPath()) : null;
        }
        return new File(rawPath);
    }

    private static boolean isZipFile(File file) {
        if (file == null || !file.exists() || file.length() < 4) {
            return false;
        }
        try (FileInputStream fis = new FileInputStream(file)) {
            int b0 = fis.read();
            int b1 = fis.read();
            return b0 == 0x50 && b1 == 0x4B;
        } catch (IOException e) {
            return false;
        }
    }

    private static boolean isPrivateLanIpv4(String host) {
        String[] parts = host.split("\\.");
        if (parts.length != 4) {
            return false;
        }
        int[] nums = new int[4];
        for (int i = 0; i < 4; i++) {
            try {
                nums[i] = Integer.parseInt(parts[i]);
                if (nums[i] < 0 || nums[i] > 255) {
                    return false;
                }
            } catch (NumberFormatException e) {
                return false;
            }
        }
        if (nums[0] == 10 || nums[0] == 127) {
            return true;
        }
        if (nums[0] == 192 && nums[1] == 168) {
            return true;
        }
        return nums[0] == 172 && nums[1] >= 16 && nums[1] <= 31;
    }

    private static String detectLanIp() {
        String fallback = null;
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback() || nif.isVirtual()) {
                    continue;
                }
                String name = nif.getName().toLowerCase(Locale.US);
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (!(addr instanceof Inet4Address) || addr.isLoopbackAddress()) {
                        continue;
                    }
                    String ip = addr.getHostAddress();
                    if (ip == null || !isPrivateLanIpv4(ip)) {
                        continue;
                    }
                    if (name.startsWith("wlan") || name.startsWith("ap") || name.startsWith("eth")) {
                        return ip;
                    }
                    if (fallback == null) {
                        fallback = ip;
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }

    private static String buildLandingHtml() {
        return "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'/>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'/>"
                + "<title>DS Lite 局域网快传</title>"
                + "<style>"
                + "body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f5f7fb;color:#1f2329;margin:0;padding:24px;}"
                + ".card{max-width:440px;margin:24px auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 6px 24px rgba(0,0,0,.08);}"
                + "h1{font-size:20px;margin:0 0 8px;}p{font-size:13px;color:#646a73;line-height:1.6;margin:0 0 18px;}"
                + "label{display:block;font-size:13px;font-weight:600;margin-bottom:6px;}"
                + "input[type=text]{width:100%;box-sizing:border-box;height:42px;padding:0 12px;border:1px solid #d0d5dd;border-radius:10px;font-size:18px;letter-spacing:4px;text-align:center;margin-bottom:16px;}"
                + "button{width:100%;height:42px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px;}"
                + ".primary{background:#4d6bfe;color:#fff;}.secondary{background:#eef2ff;color:#3347b0;}"
                + ".status{font-size:13px;margin-top:8px;min-height:20px;color:#4d6bfe;word-break:break-all;}"
                + ".err{color:#e5484d;}"
                + "</style></head><body><div class='card'>"
                + "<h1>DS Lite 局域网快传</h1>"
                + "<p>同一 Wi-Fi 下高速互传聊天记录（包含完整上下文、附件、记忆笔记与人设，不含 API Key）。</p>"
                + "<label for='pin'>请输入手机屏幕上的 6 位数字口令</label>"
                + "<input id='pin' type='text' inputmode='numeric' maxlength='6' placeholder='6位口令'/>"
                + "<button class='primary' onclick='downloadZip()'>从手机下载数据（ZIP）</button>"
                + "<button class='secondary' onclick='pickUpload()'>发送本地 ZIP 备份包到手机</button>"
                + "<input id='file' type='file' accept='.zip,application/zip' style='display:none' onchange='uploadZip(this.files[0])'/>"
                + "<div id='status' class='status'></div></div>"
                + "<script>"
                + "function getPin(){return document.getElementById('pin').value.trim();}"
                + "function setMsg(t,e){var s=document.getElementById('status');s.textContent=t;s.className=e?'status err':'status';}"
                + "function downloadZip(){var p=getPin();if(p.length!==6){setMsg('请先输入完整的 6 位数字口令',1);return;}setMsg('正在从手机拉取备份包…');window.location.href='/download?pin='+encodeURIComponent(p);}"
                + "function pickUpload(){var p=getPin();if(p.length!==6){setMsg('请先输入完整的 6 位数字口令',1);return;}document.getElementById('file').click();}"
                + "async function uploadZip(f){if(!f)return;var p=getPin();setMsg('正在发送到手机（'+(f.size/1024/1024).toFixed(2)+' MB）…');"
                + "try{var r=await fetch('/upload?pin='+encodeURIComponent(p)+'&name='+encodeURIComponent(f.name),{method:'POST',body:f});"
                + "var j=await r.json().catch(function(){return {};});if(!r.ok){throw new Error(j.error||('发送失败 '+r.status));}"
                + "setMsg('已发送到手机！请在手机上挑选要导入的会话。');}catch(e){setMsg(e.message||'发送失败',1);}finally{document.getElementById('file').value='';}}"
                + "</script></body></html>";
    }
}
