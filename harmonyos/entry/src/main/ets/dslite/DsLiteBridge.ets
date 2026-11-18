import { common } from '@kit.AbilityKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { fileIo, fileUri } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { systemShare } from '@kit.ShareKit';
import { webview } from '@kit.ArkWeb';
import { BRIDGE_NAME, MAX_EXPORT_BYTES, MAX_EXPORT_CHUNK_BYTES } from './DsLiteConstants';
import { isAllowedBridgeCaller } from './VirtualWebResources';

const DOMAIN: number = 0xD51E;
const EXPORT_SUBDIR: string = 'dslite-exports';

class ExportSession {
  token: string = '';
  fileName: string = '';
  filePath: string = '';
  written: number = 0;
}

/**
 * 前端仅可调用的最小导出/分享桥。
 * 不提供任意读路径、不接收本地文件路径、不记录文件内容或 API Key。
 */
export class DsLiteBridge {
  private controller: webview.WebviewController = new webview.WebviewController();
  private context: common.UIAbilityContext | undefined = undefined;
  private session: ExportSession | undefined = undefined;

  bind(controller: webview.WebviewController, context: common.UIAbilityContext): void {
    this.controller = controller;
    this.context = context;
  }

  beginExport(fileName: string): string {
    if (!this.callerAllowed()) {
      return this.fail('来源不受信任');
    }
    const safeName: string = sanitizeFileName(fileName);
    if (safeName.length === 0) {
      return this.fail('文件名不合法');
    }
    const ctx: common.UIAbilityContext | undefined = this.context;
    if (ctx === undefined) {
      return this.fail('应用上下文不可用');
    }
    this.discardSession();
    const dir: string = ctx.cacheDir + '/' + EXPORT_SUBDIR;
    try {
      fileIo.mkdirSync(dir, true);
    } catch (_e) {
      // 目录可能已存在
    }
    const filePath: string = dir + '/' + safeName;
    if (!filePath.startsWith(dir + '/')) {
      return this.fail('文件名不合法');
    }
    try {
      const file = fileIo.openSync(filePath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.closeSync(file);
    } catch (err) {
      hilog.error(DOMAIN, BRIDGE_NAME, 'beginExport open failed: %{public}d',
        (err as BusinessError).code);
      return this.fail('无法在应用缓存中创建文件');
    }
    const session: ExportSession = new ExportSession();
    session.token = util.generateRandomUUID(true);
    session.fileName = safeName;
    session.filePath = filePath;
    session.written = 0;
    this.session = session;
    hilog.info(DOMAIN, BRIDGE_NAME, 'export session started, name=%{public}s', safeName);
    return this.okWithToken(session.token);
  }

  appendExport(token: string, base64Chunk: string): string {
    if (!this.callerAllowed()) {
      return this.fail('来源不受信任');
    }
    const session: ExportSession | undefined = this.requireSession(token);
    if (session === undefined) {
      return this.fail('导出会话无效');
    }
    if (typeof base64Chunk !== 'string' || base64Chunk.length === 0) {
      return this.fail('数据块无效');
    }
    let bytes: Uint8Array;
    try {
      bytes = new util.Base64Helper().decodeSync(base64Chunk);
    } catch (_e) {
      return this.fail('数据块无法解码');
    }
    if (bytes.byteLength > MAX_EXPORT_CHUNK_BYTES) {
      this.discardSession();
      return this.fail('数据块过大');
    }
    if (session.written + bytes.byteLength > MAX_EXPORT_BYTES) {
      this.discardSession();
      return this.fail('导出文件超过大小限制');
    }
    try {
      const file = fileIo.openSync(session.filePath, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.APPEND);
      try {
        fileIo.writeSync(file.fd, toArrayBuffer(bytes));
      } finally {
        fileIo.closeSync(file);
      }
    } catch (err) {
      hilog.error(DOMAIN, BRIDGE_NAME, 'appendExport write failed: %{public}d',
        (err as BusinessError).code);
      this.discardSession();
      return this.fail('写入应用缓存失败');
    }
    session.written += bytes.byteLength;
    return '{"ok":true}';
  }

  cancelExport(token: string): string {
    if (!this.callerAllowed()) {
      return this.fail('来源不受信任');
    }
    const session: ExportSession | undefined = this.requireSession(token);
    if (session === undefined) {
      return this.fail('导出会话无效');
    }
    this.discardSession();
    return '{"ok":true}';
  }

  finishExport(token: string): void {
    if (!this.callerAllowed()) {
      this.notify('{"ok":false,"error":"来源不受信任"}');
      return;
    }
    const session: ExportSession | undefined = this.requireSession(token);
    if (session === undefined) {
      this.notify('{"ok":false,"error":"导出会话无效"}');
      return;
    }
    const ctx: common.UIAbilityContext | undefined = this.context;
    if (ctx === undefined) {
      this.notify('{"ok":false,"error":"应用上下文不可用"}');
      return;
    }
    const filePath: string = session.filePath;
    const fileName: string = session.fileName;
    // 分享过程中保留文件，成功或失败后再决定是否清理。失败时保留缓存以便用户知情，但不宣称已分享。
    try {
      const uri: string = fileUri.getUriFromPath(filePath);
      const dot: number = fileName.lastIndexOf('.');
      const ext: string = dot >= 0 ? fileName.substring(dot) : '.bin';
      let typeId: string = utd.UniformDataType.FILE;
      try {
        typeId = utd.getUniformDataTypeByFilenameExtension(ext, utd.UniformDataType.FILE);
      } catch (_e) {
        typeId = utd.UniformDataType.FILE;
      }
      const shareData: systemShare.SharedData = new systemShare.SharedData({
        utd: typeId,
        uri: uri,
        title: fileName
      });
      const controller: systemShare.ShareController = new systemShare.ShareController(shareData);
      controller.show(ctx, {
        selectionMode: systemShare.SelectionMode.SINGLE,
        previewMode: systemShare.SharePreviewMode.DEFAULT
      }).then(() => {
        this.session = undefined;
        this.notify('{"ok":true}');
        hilog.info(DOMAIN, BRIDGE_NAME, 'share panel opened, name=%{public}s', fileName);
      }).catch((error: BusinessError) => {
        hilog.error(DOMAIN, BRIDGE_NAME, 'share panel failed: %{public}d', error.code);
        this.session = undefined;
        this.notify('{"ok":false,"error":"文件已写入应用缓存，但未能打开系统分享面板"}');
      });
    } catch (err) {
      hilog.error(DOMAIN, BRIDGE_NAME, 'finishExport failed: %{public}d', (err as BusinessError).code);
      this.session = undefined;
      this.notify('{"ok":false,"error":"无法打开系统分享"}');
    }
  }

  private callerAllowed(): boolean {
    try {
      const frameUrl: string = this.controller.getLastJavascriptProxyCallingFrameUrl();
      return isAllowedBridgeCaller(frameUrl);
    } catch (_e) {
      return false;
    }
  }

  private requireSession(token: string): ExportSession | undefined {
    const session: ExportSession | undefined = this.session;
    if (session === undefined || token.length === 0 || token !== session.token) {
      return undefined;
    }
    return session;
  }

  private discardSession(): void {
    const session: ExportSession | undefined = this.session;
    this.session = undefined;
    if (session === undefined) {
      return;
    }
    try {
      fileIo.unlinkSync(session.filePath);
    } catch (_e) {
      // 文件可能尚未创建或已删除
    }
  }

  private notify(json: string): void {
    const script: string = 'window.__dsLiteHarmonyShareDone && window.__dsLiteHarmonyShareDone(' + json + ');';
    try {
      this.controller.runJavaScript(script);
    } catch (err) {
      hilog.error(DOMAIN, BRIDGE_NAME, 'notify failed: %{public}d', (err as BusinessError).code);
    }
  }

  private fail(message: string): string {
    return '{"ok":false,"error":"' + escapeJsonString(message) + '"}';
  }

  private okWithToken(token: string): string {
    return '{"ok":true,"token":"' + escapeJsonString(token) + '"}';
  }
}

function sanitizeFileName(fileName: string): string {
  if (typeof fileName !== 'string') {
    return '';
  }
  let name: string = fileName;
  const slash: number = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (slash >= 0) {
    name = name.substring(slash + 1);
  }
  name = name.replace(/[\/:*?"<>|\u0000-\u001F]/g, '_');
  name = name.trim();
  if (name === '.' || name === '..') {
    return '';
  }
  if (name.length === 0 || name.length > 200) {
    return '';
  }
  return name;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out: ArrayBuffer = new ArrayBuffer(bytes.byteLength);
  const view: Uint8Array = new Uint8Array(out);
  for (let i = 0; i < bytes.byteLength; i++) {
    view[i] = bytes[i];
  }
  return out;
}

function escapeJsonString(value: string): string {
  let out: string = '';
  for (let i = 0; i < value.length; i++) {
    const ch: string = value.charAt(i);
    if (ch === '"' || ch === '\\') {
      out += '\\' + ch;
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else {
      out += ch;
    }
  }
  return out;
}
