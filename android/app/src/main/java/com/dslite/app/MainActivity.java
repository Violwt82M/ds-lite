package com.dslite.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 分享 / 打开方式进来的归档由这个插件接住
        registerPlugin(SharedArchivePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
