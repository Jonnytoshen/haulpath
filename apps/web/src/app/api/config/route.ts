export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    mapKey: process.env.AMAP_JS_KEY ?? '',
    securityProxyPath: '/_AMapService',
    webServiceConfigured: Boolean(process.env.AMAP_WEB_SERVICE_KEY),
  });
}
