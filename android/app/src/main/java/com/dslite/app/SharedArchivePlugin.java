package com.dslite.app;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 接收系统分享过来的归档文件（浏览器下载完「分享 → DS Lite」，
 * 或在文件管理器里「用其他应用打开 → DS Lite」）。
 * 复制到缓存目录后把路径交给前端，由前端走现有的导入流程。
 */
@CapacitorPlugin(name = "SharedArchive")
public class SharedArchivePlugin extends Plugin {

    private JSObject pending = null;

    @Override
    public void load() {
        pending = extract(getActivity() == null ? null : getActivity().getIntent());
    }

    @PluginMethod
    public void getShared(PluginCall call) {
        JSObject shared = pending;
        pending = null;
        call.resolve(shared == null ? new JSObject() : shared);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject shared = extract(intent);
        if (shared != null) {
            notifyListeners("shared", shared);
        }
    }

    private JSObject extract(Intent intent) {
        if (intent == null) {
            return null;
        }
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_SEND.equals(action)) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        } else if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        }
        if (uri == null) {
            return null;
        }
        try {
            return copyToCache(uri);
        } catch (Exception error) {
            return null;
        }
    }

    private String displayName(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = getContext()
                .getContentResolver()
                .query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    return cursor.getString(index);
                }
            }
        } catch (Exception ignored) {
            // 拿不到名字就用默认的
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return null;
    }

    private JSObject copyToCache(Uri uri) throws Exception {
        File dir = new File(getContext().getCacheDir(), "shared-import");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new Exception("cannot create cache dir");
        }
        String name = displayName(uri);
        String safe = (name == null || !name.toLowerCase().endsWith(".zip"))
            ? "shared-history.zip"
            : name.replaceAll("[^A-Za-z0-9._-]", "_");
        File target = new File(dir, safe);
        InputStream input = getContext().getContentResolver().openInputStream(uri);
        if (input == null) {
            throw new Exception("cannot open stream");
        }
        try (OutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        } finally {
            input.close();
        }
        JSObject result = new JSObject();
        result.put("path", target.getAbsolutePath());
        result.put("name", target.getName());
        result.put("size", target.length());
        return result;
    }
}
