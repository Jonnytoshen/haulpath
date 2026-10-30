import { HttpError } from './http';

export function amapUrl(path: string): URL {
  let base = 'https://restapi.amap.com';
  if (process.env.HAULPATH_TEST_MODE === '1' && process.env.AMAP_API_BASE_URL) {
    const candidate = new URL(process.env.AMAP_API_BASE_URL);
    if (candidate.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname)
      || candidate.username || candidate.password || candidate.pathname !== '/' || candidate.search || candidate.hash) {
      throw new HttpError(500, '高德测试地址必须为本机 HTTP 服务');
    }
    base = candidate.origin;
  }
  return new URL(path, base);
}

export function coordinateText(longitude: number, latitude: number): string {
  return `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
}

export function parsePosition(value: unknown): [number, number] {
  if (typeof value !== 'string') throw new HttpError(502, '高德返回的坐标无效，请重试');
  const parts = value.split(',');
  if (parts.length !== 2 || parts.some((part) => !part.trim())) throw new HttpError(502, '高德返回的坐标无效，请重试');
  const [longitude, latitude] = parts.map(Number);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    throw new HttpError(502, '高德返回的坐标无效，请重试');
  }
  return [longitude, latitude];
}

export async function amapFetch(url: URL): Promise<Response> {
  try {
    return await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new HttpError(504, '高德服务请求超时，请重试');
    }
    throw new HttpError(502, '无法连接高德服务，请检查网络后重试');
  }
}

export async function amapJson(path: string, parameters: Record<string, string>): Promise<Record<string, unknown>> {
  const key = process.env.AMAP_WEB_SERVICE_KEY;
  if (!key) throw new HttpError(503, '缺少高德 Web 服务 Key，请配置 AMAP_WEB_SERVICE_KEY');
  const url = amapUrl(path);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  url.searchParams.set('key', key);
  url.searchParams.set('output', 'JSON');
  const response = await amapFetch(url);
  if (!response.ok) throw new HttpError(502, '高德服务暂时不可用，请稍后重试');
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new HttpError(502, '高德返回的数据无效，请重试'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HttpError(502, '高德返回的数据无效，请重试');
  const data = result as Record<string, unknown>;
  if (data.status !== '1') {
    if (['10003', '10004', '10014', '10019', '10020', '10021', '10044'].includes(String(data.infocode))) {
      throw new HttpError(502, '高德调用额度不足或频率受限，请稍后重试');
    }
    if (['10001', '10002', '10005', '10006', '10007', '10008', '10009', '10012', '10013'].includes(String(data.infocode))) {
      throw new HttpError(502, '高德密钥或权限校验失败，请检查配置');
    }
    throw new HttpError(502, '高德未能完成请求，请检查点位后重试');
  }
  return data;
}
