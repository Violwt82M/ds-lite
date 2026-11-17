import { RAWFILE_WEB_PREFIX, VIRTUAL_HOST } from './DsLiteConstants';

export class UrlMapResult {
  intercept: boolean = false;
  rawPath: string = '';
  invalid: boolean = false;
}

/**
 * 只映射虚拟主机 https://ds-lite.invalid 下的路径到 rawfile/web。
 * 其他主机（含 api.deepseek.com 及用户自定义 API 源）返回 intercept=false，由系统走真实网络。
 */
export function mapVirtualUrlToRawfile(requestUrl: string): UrlMapResult {
  const result: UrlMapResult = new UrlMapResult();
  const pathOrEmpty: string = extractVirtualPath(requestUrl);
  if (pathOrEmpty === '') {
    return result;
  }
  result.intercept = true;
  const rawPath: string = sanitizeToRawfile(pathOrEmpty);
  if (rawPath.length === 0) {
    result.invalid = true;
    return result;
  }
  result.rawPath = rawPath;
  return result;
}

export function isAllowedBridgeCaller(frameUrl: string): boolean {
  return extractVirtualPath(frameUrl) !== '';
}

export function mimeTypeForRawPath(rawPath: string): string {
  const lower: string = rawPath.toLowerCase();
  const dot: number = lower.lastIndexOf('.');
  const ext: string = dot >= 0 ? lower.substring(dot) : '';
  if (ext === '.html' || ext === '.htm') {
    return 'text/html';
  }
  if (ext === '.js' || ext === '.mjs') {
    return 'application/javascript';
  }
  if (ext === '.css') {
    return 'text/css';
  }
  if (ext === '.json') {
    return 'application/json';
  }
  if (ext === '.webmanifest') {
    return 'application/manifest+json';
  }
  if (ext === '.png') {
    return 'image/png';
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    return 'image/jpeg';
  }
  if (ext === '.gif') {
    return 'image/gif';
  }
  if (ext === '.svg') {
    return 'image/svg+xml';
  }
  if (ext === '.webp') {
    return 'image/webp';
  }
  if (ext === '.ico') {
    return 'image/x-icon';
  }
  if (ext === '.woff') {
    return 'font/woff';
  }
  if (ext === '.woff2') {
    return 'font/woff2';
  }
  if (ext === '.ttf') {
    return 'font/ttf';
  }
  if (ext === '.txt') {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/javascript' || mime === 'application/json' ||
    mime === 'application/manifest+json';
}

/**
 * 若 URL 属于虚拟主机则返回 pathname（至少为 "/"），否则返回空字符串。
 */
function extractVirtualPath(requestUrl: string): string {
  const schemeSep: number = requestUrl.indexOf('://');
  if (schemeSep < 0) {
    return '';
  }
  const scheme: string = requestUrl.substring(0, schemeSep).toLowerCase();
  if (scheme !== 'https') {
    return '';
  }
  const after: string = requestUrl.substring(schemeSep + 3);
  let hostEnd: number = after.length;
  const slash: number = after.indexOf('/');
  const query: number = after.indexOf('?');
  const hash: number = after.indexOf('#');
  if (slash >= 0 && slash < hostEnd) {
    hostEnd = slash;
  }
  if (query >= 0 && query < hostEnd) {
    hostEnd = query;
  }
  if (hash >= 0 && hash < hostEnd) {
    hostEnd = hash;
  }
  let hostPort: string = after.substring(0, hostEnd);
  const at: number = hostPort.lastIndexOf('@');
  if (at >= 0) {
    hostPort = hostPort.substring(at + 1);
  }
  let host: string = hostPort;
  const colon: number = hostPort.indexOf(':');
  if (colon >= 0) {
    host = hostPort.substring(0, colon);
    const port: string = hostPort.substring(colon + 1);
    if (port.length > 0 && port !== '443') {
      return '';
    }
  }
  if (host.toLowerCase() !== VIRTUAL_HOST) {
    return '';
  }
  let pathPart: string = '/';
  if (slash >= 0) {
    let pathEnd: number = after.length;
    if (query >= 0 && query < pathEnd) {
      pathEnd = query;
    }
    if (hash >= 0 && hash < pathEnd) {
      pathEnd = hash;
    }
    pathPart = after.substring(slash, pathEnd);
  }
  return pathPart;
}

function sanitizeToRawfile(pathname: string): string {
  let decoded: string = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_e) {
    return '';
  }
  if (decoded.indexOf('\\') >= 0 || decoded.indexOf('\0') >= 0) {
    return '';
  }
  let work: string = decoded;
  if (work === '/' || work.length === 0) {
    work = '/index.html';
  }
  const parts: string[] = work.split('/');
  const safe: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part: string = parts[i];
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      return '';
    }
    safe.push(part);
  }
  if (safe.length === 0) {
    return '';
  }
  return RAWFILE_WEB_PREFIX + '/' + safe.join('/');
}
