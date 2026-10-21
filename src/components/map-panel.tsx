'use client';

import { useEffect, useRef, useState } from 'react';
import type { Point, Route } from '@/lib/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MapPin, Search } from 'lucide-react';

export interface MapConfig { mapKey: string; securityProxyPath: string; webServiceConfigured: boolean }
export interface MapCandidate { name: string; longitude: number; latitude: number; source: 'map' | 'search'; poiId?: string }
interface LngLat { lng?: number; lat?: number; getLng?: () => number; getLat?: () => number }
interface MapEvent { lnglat: LngLat }
interface Poi { id?: string; name?: string; district?: string; address?: string; location?: LngLat | string }
interface SearchResult { tips?: Poi[]; poiList?: { pois?: Poi[] }; info?: string }
interface Overlay { on: (event: string, callback: () => void) => void; off?: (event: string, callback: () => void) => void; setContent?: (content: HTMLElement) => void }
interface MapInstance { on: (event: string, handler: (event: MapEvent) => void) => void; off: (event: string, handler: (event: MapEvent) => void) => void; add: (items: Overlay[]) => void; remove: (items: Overlay[]) => void; setFitView: (items?: Overlay[], immediately?: boolean, padding?: number[]) => void; destroy: () => void }
interface Cluster { setMap: (map: MapInstance | null) => void; on?: (event: string, callback: (event: { clusterData?: { extData?: Point }[]; lnglat?: LngLat }) => void) => void }
interface SearchService { search: (keyword: string, callback: (status: string, result: SearchResult) => void) => void; getDetails?: (id: string, callback: (status: string, result: SearchResult) => void) => void }
interface AMapSDK {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => MapInstance;
  Marker: new (options: Record<string, unknown>) => Overlay;
  Polyline: new (options: Record<string, unknown>) => Overlay;
  Pixel: new (x: number, y: number) => unknown;
  MarkerCluster: new (map: MapInstance, points: { lnglat: [number, number]; extData: Point }[], options: Record<string, unknown>) => Cluster;
  AutoComplete: new (options: Record<string, unknown>) => SearchService;
  PlaceSearch: new (options: Record<string, unknown>) => SearchService;
}

function coordinates(value?: LngLat | string): [number, number] | null {
  if (!value) return null;
  if (typeof value === 'string' && (value.split(',').length !== 2 || value.split(',').some((part) => !part.trim()))) return null;
  const pair = typeof value === 'string' ? value.split(',').map(Number) : [value.getLng?.() ?? value.lng, value.getLat?.() ?? value.lat];
  const [longitude, latitude] = pair;
  return typeof longitude === 'number' && typeof latitude === 'number' && Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90 ? [longitude, latitude] : null;
}

export default function MapPanel({ config, route, library, onCandidate, onLibraryPoint }: { config: MapConfig | null; route: Route | null; library: Point[]; onCandidate: (candidate: MapCandidate) => void; onLibraryPoint: (point: Point) => void | Promise<void> }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapInstance | null>(null);
  const sdk = useRef<AMapSDK | null>(null);
  const services = useRef<{ autocomplete: SearchService; places: SearchService } | null>(null);
  const callbacks = useRef({ onCandidate, onLibraryPoint });
  callbacks.current = { onCandidate, onLibraryPoint };
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState('');
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [candidates, setCandidates] = useState<Poi[]>([]);
  const searchVersion = useRef(0);

  useEffect(() => {
    setReady(false); setFailure('');
    if (!config?.mapKey || !container.current) return;
    let cancelled = false;
    let instance: MapInstance | null = null;
    const onClick = (event: MapEvent) => {
      const position = coordinates(event.lnglat);
      if (position && !cancelled) callbacks.current.onCandidate({ name: '', longitude: position[0], latitude: position[1], source: 'map' });
    };
    (async () => {
      try {
        const loader = await import('@amap/amap-jsapi-loader');
        if (cancelled) return;
        (window as Window & { _AMapSecurityConfig?: { serviceHost: string } })._AMapSecurityConfig = { serviceHost: `${location.origin}${config.securityProxyPath}` };
        const api = await loader.load({ key: config.mapKey, version: '2.0', plugins: ['AMap.AutoComplete', 'AMap.PlaceSearch', 'AMap.MarkerCluster'] }) as AMapSDK;
        if (cancelled || !container.current) return;
        sdk.current = api;
        instance = new api.Map(container.current, { zoom: 5, center: [112.5, 33], viewMode: '2D', resizeEnable: true });
        map.current = instance;
        services.current = { autocomplete: new api.AutoComplete({ city: '全国' }), places: new api.PlaceSearch({ city: '全国', pageSize: 10, extensions: 'base' }) };
        instance.on('click', onClick);
        setReady(true);
      } catch (error) {
        if (!cancelled) setFailure(`地图加载失败：${error instanceof Error ? error.message : String(error)}。请检查网络、JS Key 与 JS 安全密钥配置。`);
      }
    })();
    return () => {
      cancelled = true; searchVersion.current++;
      services.current = null; sdk.current = null; map.current = null;
      instance?.off('click', onClick); instance?.destroy();
    };
  }, [config?.mapKey, config?.securityProxyPath, retry]);

  useEffect(() => { searchVersion.current++; setQuery(''); setCandidates([]); setSearchError(''); setSearching(false); }, [route?.id]);

  const overlayKey = JSON.stringify({ points: route?.points.map(({ id, name, longitude, latitude }) => [id, name, longitude, latitude]), legs: route?.snapshot?.inputVersion === route?.inputVersion ? route?.snapshot?.legs.map(({ polyline }) => polyline) : null, library: library.map(({ id, name, longitude, latitude }) => [id, name, longitude, latitude]) });
  useEffect(() => {
    if (!ready || !map.current || !sdk.current) return;
    const instance = map.current;
    const api = sdk.current;
    const overlays: Overlay[] = [];
    const routeOverlays: Overlay[] = [];
    const listeners: { marker: Overlay; handler: () => void }[] = [];
    const markerContent = (point: Point, text: string, className: string) => {
      const content = document.createElement('button'); content.type = 'button'; content.className = `map-marker ${className}`; content.textContent = text; content.title = point.name; content.setAttribute('aria-label', `地图点位 ${point.name}`); return content;
    };
    const points = route?.points ?? [];
    points.forEach((point, index) => {
      const content = markerContent(point, String(index + 1), index === 0 ? 'marker-start' : index === points.length - 1 ? 'marker-end' : 'marker-waypoint');
      const marker = new api.Marker({ position: [point.longitude, point.latitude], content, offset: new api.Pixel(-15, -31), zIndex: 150, title: `${index + 1}. ${point.name}` });
      overlays.push(marker); routeOverlays.push(marker);
    });
    if (route?.snapshot && route.snapshot.inputVersion === route.inputVersion) {
      route.snapshot.legs.forEach((leg) => {
        const line = new api.Polyline({ path: leg.polyline, strokeColor: '#0d8c81', strokeWeight: 6, strokeOpacity: 0.9, lineJoin: 'round', showDir: true, outlineColor: '#ffffff', isOutline: true, borderWeight: 2 });
        overlays.unshift(line); routeOverlays.push(line);
      });
    }
    let cluster: Cluster | null = null;
    if (library.length >= 100) {
      cluster = new api.MarkerCluster(instance, library.map((point) => ({ lnglat: [point.longitude, point.latitude], extData: point })), { gridSize: 60, maxZoom: 17 });
      cluster.on?.('click', (event) => { const point = event.clusterData?.length === 1 ? event.clusterData[0].extData : undefined; if (point) void callbacks.current.onLibraryPoint(point); else instance.setFitView(); });
    } else {
      library.forEach((point) => {
        const marker = new api.Marker({ position: [point.longitude, point.latitude], content: markerContent(point, '', 'marker-library'), offset: new api.Pixel(-11, -20), title: `${point.name} · 点击选入线路`, zIndex: 90 });
        const handler = () => { void callbacks.current.onLibraryPoint(point); };
        marker.on('click', handler); listeners.push({ marker, handler }); overlays.push(marker);
      });
    }
    instance.add(overlays);
    if (routeOverlays.length) instance.setFitView(routeOverlays, false, [65, 45, 45, 45]);
    else if (overlays.length) instance.setFitView(overlays, false, [65, 45, 45, 45]);
    return () => { listeners.forEach(({ marker, handler }) => marker.off?.('click', handler)); cluster?.setMap(null); if (map.current === instance) instance.remove(overlays); };
  }, [ready, overlayKey]);

  useEffect(() => {
    const version = ++searchVersion.current;
    setSearchError('');
    if (!query.trim() || !ready || !services.current) { setCandidates([]); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => services.current?.autocomplete.search(query.trim(), (status, result) => {
      if (version !== searchVersion.current) return;
      setSearching(false);
      if (status === 'complete') setCandidates(result.tips ?? []);
      else { setCandidates([]); if (status === 'error') setSearchError('地点提示失败，请检查高德配置或点击搜索重试。'); }
    }), 300);
    return () => { clearTimeout(timer); searchVersion.current++; };
  }, [query, ready]);

  function searchPlaces() {
    if (!query.trim() || !services.current) return;
    const version = ++searchVersion.current;
    setSearching(true); setSearchError('');
    services.current.places.search(query.trim(), (status, result) => {
      if (version !== searchVersion.current) return;
      setSearching(false);
      if (status === 'complete') { const pois = result.poiList?.pois ?? []; setCandidates(pois); if (!pois.length) setSearchError('未找到可用地点，请调整关键词。'); }
      else { setCandidates([]); setSearchError('地点搜索未成功，请调整关键词或检查高德服务配置。'); }
    });
  }

  function choose(poi: Poi) {
    const position = coordinates(poi.location);
    if (position) {
      callbacks.current.onCandidate({ name: poi.name ?? query, longitude: position[0], latitude: position[1], source: 'search', poiId: poi.id });
      searchVersion.current++; setCandidates([]); setSearching(false); return;
    }
    const places = services.current?.places;
    if (poi.id && places?.getDetails) {
      const version = ++searchVersion.current; setSearching(true);
      places.getDetails(poi.id, (status, result) => {
        if (version !== searchVersion.current) return;
        setSearching(false);
        const detail = result.poiList?.pois?.[0];
        if (status === 'complete' && detail && coordinates(detail.location)) choose(detail);
        else setSearchError('该地点没有可用坐标，请选择更具体的地点或在地图上选点。');
      });
    } else { setSearchError('该提示没有可用坐标，请点击搜索寻找具体地点。'); }
  }

  return <div className="map-body">
    <div ref={container} className="map-canvas" role="region" aria-label="高德地图" />
    {ready && <div className="map-search"><form onSubmit={(event) => { event.preventDefault(); searchPlaces(); }}><Search aria-hidden="true" /><Input aria-label="搜索地点" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索地点，确认后加入线路" autoComplete="off" /><Button type="submit" disabled={!query.trim()}>搜索</Button></form>{(searching || candidates.length > 0 || searchError) && <div className="search-results">{searching && <p role="status">搜索中…</p>}{searchError && <p role="alert">{searchError}</p>}{candidates.map((poi, index) => <Button key={`${poi.id}-${index}`} onClick={() => choose(poi)}><strong>{poi.name}</strong><small>{poi.district} {typeof poi.address === 'string' ? poi.address : ''}</small></Button>)}<Button className="search-dismiss" onClick={() => { searchVersion.current++; setCandidates([]); setSearching(false); setSearchError(''); }}>收起搜索结果</Button></div>}</div>}
    {!ready && <div className="map-placeholder"><span className="map-placeholder-icon"><MapPin /></span><h3>{failure ? '暂时无法加载地图' : config === null ? '正在读取地图配置' : !config.mapKey ? '配置高德地图，查看真实线路' : '正在加载高德地图'}</h3><p>{failure || (!config?.mapKey ? '在本机环境文件中配置 AMAP_JS_KEY 和 AMAP_JS_SECURITY_CODE，重启服务后刷新。项目、点位与草稿管理仍可使用。' : '地图将显示编号点位与完整路线方案。')}</p>{failure && <Button className="button" onClick={async () => { const module = await import('@amap/amap-jsapi-loader'); const loader = module as unknown as { reset?: () => void; default?: { reset?: () => void } }; (loader.reset ?? loader.default?.reset)?.(); setRetry((value) => value + 1); }}>重新加载地图</Button>}<span className="map-provider-note">高德地图 JS API 2.0</span></div>}
    {config && !config.webServiceConfigured && <div className="map-service-warning">驾车规划与 WGS84 转换需要服务端配置 AMAP_WEB_SERVICE_KEY。</div>}
  </div>;
}
