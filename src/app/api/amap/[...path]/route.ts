import { amapFetch, amapUrl } from '@/server/amap';
import { api, HttpError } from '@/server/http';

const allowedPaths = new Set(['/v3/assistant/inputtips', '/v3/place/text', '/v3/place/detail']);
type Context = { params: Promise<{ path: string[] }> };
export const runtime = 'nodejs';

export function GET(request: Request, context: Context) {
  return api(async () => {
    const path = `/${(await context.params).path.join('/')}`;
    if (!allowedPaths.has(path)) throw new HttpError(404, '不支持此高德地图服务');
    const key = process.env.AMAP_JS_KEY;
    const securityCode = process.env.AMAP_JS_SECURITY_CODE;
    if (!key || !securityCode) throw new HttpError(503, '缺少高德地图 JS Key 或安全密钥，请检查本机配置');
    const upstream = amapUrl(path);
    upstream.search = new URL(request.url).search;
    upstream.searchParams.set('key', key);
    upstream.searchParams.set('jscode', securityCode);
    const response = await amapFetch(upstream);
    if (!response.ok) throw new HttpError(502, '高德地图服务暂时不可用，请稍后重试');
    let body = await response.text();
    for (const secret of [securityCode, process.env.AMAP_WEB_SERVICE_KEY]) {
      if (secret) body = body.replaceAll(secret, '[redacted]');
    }
    return new Response(body, {
      headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  });
}
