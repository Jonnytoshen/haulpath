export interface MapConfig { mapKey: string; securityProxyPath: string; webServiceConfigured: boolean }

export async function loadMapSDK<T>(config: MapConfig, plugins: string[] = []): Promise<T> {
  const loader = await import('@amap/amap-jsapi-loader');
  (window as Window & { _AMapSecurityConfig?: { serviceHost: string } })._AMapSecurityConfig = { serviceHost: `${location.origin}${config.securityProxyPath}` };
  return loader.load({ key: config.mapKey, version: '2.0', plugins }) as Promise<T>;
}

export async function resetMapSDK() {
  const module = await import('@amap/amap-jsapi-loader');
  const loader = module as unknown as { reset?: () => void; default?: { reset?: () => void } };
  (loader.reset ?? loader.default?.reset)?.();
}
