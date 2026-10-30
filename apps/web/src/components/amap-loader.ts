export interface MapConfig { mapKey: string; securityProxyPath: string; webServiceConfigured: boolean }

// The loader rejects only the first caller when an in-flight script fails.
// Serialize callers so every mounted consumer receives that rejection.
let pendingMapLoad: Promise<unknown> | null = null;

export async function loadMapSDK<T>(config: MapConfig, plugins: string[] = []): Promise<T> {
  const loader = await import('@amap/amap-jsapi-loader');
  (window as Window & { _AMapSecurityConfig?: { serviceHost: string } })._AMapSecurityConfig = { serviceHost: `${location.origin}${config.securityProxyPath}` };
  const load = () => loader.load({ key: config.mapKey, version: '2.0', plugins });
  const request = pendingMapLoad ? pendingMapLoad.then(load) : load();
  pendingMapLoad = request;
  const clear = () => { if (pendingMapLoad === request) pendingMapLoad = null; };
  void request.then(clear, clear);
  return request as Promise<T>;
}

export async function resetMapSDK() {
  const module = await import('@amap/amap-jsapi-loader');
  const loader = module as unknown as { reset?: () => void; default?: { reset?: () => void } };
  (loader.reset ?? loader.default?.reset)?.();
}
