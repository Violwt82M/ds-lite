import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DsLiteBridge } from '../dslite/DsLiteBridge';
import {
  BRIDGE_NAME,
  PLATFORM_INJECT_SCRIPT,
  PROXY_PERMISSION,
  VIRTUAL_HOME,
  VIRTUAL_ORIGIN
} from '../dslite/DsLiteConstants';
import { isTextMime, mapVirtualUrlToRawfile, mimeTypeForRawPath, UrlMapResult } from '../dslite/VirtualWebResources';

const DOMAIN: number = 0xD51E;

@Entry
@Component
struct Index {
  private webController: webview.WebviewController = new webview.WebviewController();
  private bridge: DsLiteBridge = new DsLiteBridge();
  private hostContext: common.UIAbilityContext | undefined = undefined;
  @State loadError: string = '';

  aboutToAppear(): void {
    const host = this.getUIContext().getHostContext();
    if (host !== undefined) {
      const context: common.UIAbilityContext = host as common.UIAbilityContext;
      this.hostContext = context;
      this.bridge.bind(this.webController, context);
    }
  }

  build() {
    Column() {
      if (this.loadError.length > 0) {
        Text(this.loadError)
          .fontSize(14)
          .fontColor('#B00020')
          .padding(16)
          .width('100%')
      }
      Web({ src: VIRTUAL_HOME, controller: this.webController })
        .width('100%')
        .layoutWeight(1)
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(false)
        .geolocationAccess(false)
        .mixedMode(MixedMode.None)
        .javaScriptOnDocumentStart([
          {
            script: PLATFORM_INJECT_SCRIPT,
            scriptRules: ['https://ds-lite.invalid', 'https://ds-lite.invalid/']
          }
        ])
        .javaScriptProxy({
          object: this.bridge,
          name: BRIDGE_NAME,
          methodList: ['beginExport', 'appendExport', 'cancelExport'],
          asyncMethodList: ['finishExport'],
          controller: this.webController,
          permission: PROXY_PERMISSION
        })
        .keyboardAvoidMode(WebKeyboardAvoidMode.RESIZE_CONTENT)
        .onInterceptRequest((event: OnInterceptRequestEvent) => {
          return this.intercept(event);
        })
        .onPermissionRequest((event: OnPermissionRequestEvent) => {
          event.request.deny();
        })
        .onErrorReceive((event: OnErrorReceiveEvent) => {
          this.handleLoadError(event);
        })
    }
    .width('100%')
    .height('100%')
  }

  private intercept(event: OnInterceptRequestEvent): WebResourceResponse | null {
    const requestUrl: string = event.request.getRequestUrl();
    const mapped: UrlMapResult = mapVirtualUrlToRawfile(requestUrl);
    if (!mapped.intercept) {
      return null;
    }
    const method: string = event.request.getRequestMethod().toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return this.makeTextResponse(405, 'Method Not Allowed', 'Method Not Allowed');
    }
    if (mapped.invalid || mapped.rawPath.length === 0) {
      return this.makeTextResponse(404, 'Not Found', 'Not Found');
    }
    const context: common.UIAbilityContext | undefined = this.hostContext;
    if (context === undefined) {
      return this.makeTextResponse(500, 'Internal Server Error', 'Context unavailable');
    }
    try {
      const bytes: Uint8Array = context.resourceManager.getRawFileContentSync(mapped.rawPath);
      const mime: string = mimeTypeForRawPath(mapped.rawPath);
      const response: WebResourceResponse = new WebResourceResponse();
      response.setResponseCode(200);
      response.setReasonMessage('OK');
      response.setResponseMimeType(mime);
      response.setResponseEncoding('utf-8');
      const cache: string = mapped.rawPath.endsWith('/index.html') || mapped.rawPath === 'web/index.html' ?
        'no-cache' : 'public, max-age=31536000';
      response.setResponseHeader([
        { headerKey: 'Cache-Control', headerValue: cache }
      ]);
      response.setResponseData(copyToArrayBuffer(bytes));
      return response;
    } catch (err) {
      hilog.error(DOMAIN, 'DsLiteWeb', 'rawfile miss or read error: %{public}d %{public}s',
        (err as BusinessError).code, mapped.rawPath);
      return this.makeTextResponse(404, 'Not Found', 'Not Found');
    }
  }

  private makeTextResponse(code: number, reason: string, body: string): WebResourceResponse {
    const response: WebResourceResponse = new WebResourceResponse();
    response.setResponseCode(code);
    response.setReasonMessage(reason);
    response.setResponseMimeType('text/plain');
    response.setResponseEncoding('utf-8');
    response.setResponseData(body);
    return response;
  }

  private handleLoadError(event: OnErrorReceiveEvent): void {
    try {
      const url: string = event.request.getRequestUrl();
      hilog.error(DOMAIN, 'DsLiteWeb', 'resource error url=%{public}s', url);
      if (url === VIRTUAL_HOME || url === VIRTUAL_ORIGIN || url === (VIRTUAL_ORIGIN + '/index.html')) {
        this.loadError = '本地页面加载失败。请确认已在仓库根目录执行 pnpm build:harmonyos 后再编译 HAP。';
      }
    } catch (_e) {
      // 忽略解析失败，避免把页面内容写入日志
    }
  }
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out: ArrayBuffer = new ArrayBuffer(bytes.byteLength);
  const view: Uint8Array = new Uint8Array(out);
  for (let i = 0; i < bytes.byteLength; i++) {
    view[i] = bytes[i];
  }
  return out;
}
