/** 虚拟 HTTPS 源。使用 RFC 2606 保留的 .invalid，避免与公网域名冲突。 */
export const VIRTUAL_HOST: string = 'ds-lite.invalid';
export const VIRTUAL_ORIGIN: string = 'https://ds-lite.invalid';
export const VIRTUAL_HOME: string = 'https://ds-lite.invalid/';
export const RAWFILE_WEB_PREFIX: string = 'web';
export const BRIDGE_NAME: string = 'DsLiteHarmony';

/** 仅在本虚拟源注入平台标记，供前端跳过 SW、走导出桥。 */
export const PLATFORM_INJECT_SCRIPT: string =
  '(function(){try{window.__DS_LITE_PLATFORM__=\'harmonyos\';}catch(_e){}})();';

/**
 * JavaScriptProxy 权限：只允许虚拟源调用桥。格式见官方文档
 * https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-in-page-app-function-invoking
 */
export const PROXY_PERMISSION: string =
  '{"javascriptProxyPermission":{"urlPermissionList":[' +
  '{"scheme":"https","host":"ds-lite.invalid","port":"","path":""}' +
  '],"methodList":[]}}';

export const MAX_EXPORT_BYTES: number = 80 * 1024 * 1024;
export const MAX_EXPORT_CHUNK_BYTES: number = 2 * 1024 * 1024;
