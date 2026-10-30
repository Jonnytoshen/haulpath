'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Route } from '@haulpath/domain';
import { loadMapSDK, resetMapSDK, type MapConfig } from './amap-loader';

export type MapCamera = { center: [number, number]; zoom: number; request: number };
export type MapViewRequest = { version: number; target: 'all' | 'selected' };
interface Overlay { on: (event: string, callback: () => void) => void; off: (event: string, callback: () => void) => void }
interface MapInstance {
  on: (event: string, callback: () => void) => void;
  off: (event: string, callback: () => void) => void;
  add: (items: Overlay[]) => void;
  remove: (items: Overlay[]) => void;
  getCenter: () => { getLng: () => number; getLat: () => number };
  getZoom: () => number;
  setZoomAndCenter: (zoom: number, center: [number, number], immediately: boolean) => void;
  setFitView: (items: Overlay[], immediately: boolean, padding: number[], maxZoom: number) => void;
  destroy: () => void;
}
interface AMapSDK {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => MapInstance;
  Marker: new (options: Record<string, unknown>) => Overlay;
  Polyline: new (options: Record<string, unknown>) => Overlay;
  Pixel: new (x: number, y: number) => unknown;
}

const routeColors = ['#176b55', '#356aa0', '#a16225', '#89528f', '#247d8b', '#a1485d', '#657b28', '#596e82'];
export function overviewRouteColor(id: string) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return routeColors[hash % routeColors.length];
}

function pointRole(index: number, count: number) {
  const role = index === 0 ? 'start' : index === count - 1 ? 'end' : 'waypoint';
  return { name: count === 1 ? '起点（单点草稿）' : { start: '起点', waypoint: '途经点', end: '终点' }[role], className: `marker-${role}` };
}

type Props = {
  config: MapConfig | null;
  routes: Route[];
  selectedId: string | null;
  camera: MapCamera | null;
  viewRequest: MapViewRequest;
  onSelect: (route: Route) => void;
  onCameraChange: (camera: MapCamera) => void;
};

export default function OverviewMap(props: Props) {
  const { config, routes, selectedId, viewRequest } = props;
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ map: MapInstance; api: AMapSDK } | null>(null);
  const current = useRef(props); current.current = props;
  const appliedRequest = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setReady(false); setFailure(''); appliedRequest.current = null;
    if (!config?.mapKey || !container.current) return;
    let cancelled = false;
    let instance: MapInstance | null = null;
    const rememberCamera = () => {
      if (cancelled || !instance) return;
      const center = instance.getCenter();
      current.current.onCameraChange({ center: [center.getLng(), center.getLat()], zoom: instance.getZoom(), request: current.current.viewRequest.version });
    };
    (async () => {
      try {
        const api = await loadMapSDK<AMapSDK>(config);
        if (cancelled || !container.current) return;
        const { camera, viewRequest: request } = current.current;
        instance = new api.Map(container.current, { center: camera?.center ?? [112.5, 33], zoom: camera?.zoom ?? 5, viewMode: '2D', resizeEnable: true });
        runtime.current = { map: instance, api };
        appliedRequest.current = camera?.request === request.version ? request.version : null;
        instance.on('moveend', rememberCamera); instance.on('zoomend', rememberCamera);
        setReady(true);
      } catch (error) {
        if (!cancelled) setFailure(`地图加载失败：${error instanceof Error ? error.message : String(error)}。请检查网络、JS Key 与 JS 安全密钥配置。`);
      }
    })();
    return () => {
      cancelled = true;
      instance?.off('moveend', rememberCamera); instance?.off('zoomend', rememberCamera); instance?.destroy();
      runtime.current = null;
    };
  }, [config?.mapKey, config?.securityProxyPath, retry]);

  const overlayKey = JSON.stringify(routes.map((route) => [route.id, route.name, route.snapshot?.inputVersion === route.inputVersion ? route.snapshot?.legs.map((leg) => leg.polyline) : null, route.id === selectedId ? route.points : null]));
  useEffect(() => {
    if (!ready || !runtime.current) return;
    const { map, api } = runtime.current;
    const overlays: Overlay[] = [];
    const selectedOverlays: Overlay[] = [];
    const listeners: { overlay: Overlay; callback: () => void }[] = [];
    for (const route of routes) {
      if (!route.snapshot || route.snapshot.inputVersion !== route.inputVersion) continue;
      const selected = route.id === selectedId;
      for (const leg of route.snapshot.legs) {
        const line = new api.Polyline({ path: leg.polyline, strokeColor: overviewRouteColor(route.id), strokeWeight: selected ? 7 : 4, strokeOpacity: selected ? 1 : 0.8, lineJoin: 'round', showDir: selected, isOutline: true, outlineColor: '#ffffff', borderWeight: selected ? 2 : 1, zIndex: selected ? 100 : 50, bubble: false, extData: { routeId: route.id, routeName: route.name } });
        const select = () => { const latest = current.current.routes.find((item) => item.id === route.id); if (latest) current.current.onSelect(latest); };
        line.on('click', select); listeners.push({ overlay: line, callback: select });
        overlays.push(line); if (selected) selectedOverlays.push(line);
      }
    }
    const selected = routes.find((route) => route.id === selectedId);
    selected?.points.forEach((point, index) => {
      const role = pointRole(index, selected.points.length);
      const label = `${index + 1}. ${role.name} · ${point.name}`;
      const content = document.createElement('span');
      content.className = `map-marker ${role.className}`;
      content.textContent = String(index + 1); content.title = label;
      content.setAttribute('role', 'img'); content.setAttribute('aria-label', label);
      const marker = new api.Marker({ position: [point.longitude, point.latitude], content, offset: new api.Pixel(-15, -31), zIndex: 150, title: label });
      overlays.push(marker); selectedOverlays.push(marker);
    });
    map.add(overlays);
    if (appliedRequest.current !== viewRequest.version) {
      appliedRequest.current = viewRequest.version;
      const target = viewRequest.target === 'selected' ? selectedOverlays : overlays;
      if (target.length) map.setFitView(target, true, [45, 35, 45, 35], 15);
      else if (viewRequest.target === 'all') map.setZoomAndCenter(5, [112.5, 33], true);
      const center = map.getCenter();
      current.current.onCameraChange({ center: [center.getLng(), center.getLat()], zoom: map.getZoom(), request: viewRequest.version });
    }
    return () => {
      listeners.forEach(({ overlay, callback }) => overlay.off('click', callback));
      if (runtime.current?.map === map) map.remove(overlays);
    };
  }, [ready, overlayKey, selectedId, viewRequest.version]);

  const validCount = routes.filter((route) => route.snapshot?.inputVersion === route.inputVersion).length;
  const selectedPointCount = routes.find((route) => route.id === selectedId)?.points.length ?? 0;
  const legendRoles = selectedPointCount ? [pointRole(0, selectedPointCount), ...(selectedPointCount > 2 ? [pointRole(1, selectedPointCount)] : []), ...(selectedPointCount > 1 ? [pointRole(selectedPointCount - 1, selectedPointCount)] : [])] : [];
  return <div className="overview-map-surface" role="region" aria-label="线路总览地图" aria-busy={!!config?.mapKey && !ready && !failure}>
    <div className="map-body">
      <div ref={container} className="map-canvas" aria-label="高德地图" />
      {!ready && <div className="map-placeholder" role="status">
        <span className="map-placeholder-icon"><MapPin /></span>
        <h3>{failure ? '暂时无法加载地图' : config === null ? '正在读取地图配置' : !config.mapKey ? '配置高德地图，查看真实线路' : '正在加载高德地图'}</h3>
        <p>{failure || (!config?.mapKey ? '仍可在列表中预览线路资料，或打开线路继续编排。' : '将显示当前匹配线路的有效方案与所选点位。')}</p>
        {config && !config.mapKey && <details className="map-config-help"><summary>查看地图配置说明</summary><p>在本机环境文件配置 AMAP_JS_KEY 与 AMAP_JS_SECURITY_CODE，重启服务后刷新。</p></details>}
        {failure && <Button className="button" onClick={async () => { await resetMapSDK(); setRetry((value) => value + 1); }}>重新加载地图</Button>}
        <span className="map-provider-note">高德地图 JS API 2.0</span>
      </div>}
    </div>
    <div className="overview-map-note"><p>{validCount ? `${validCount} 条有效方案 · 色标对应线路，颜色可能重复` : '当前匹配线路暂无有效方案，可选择线路查看当前点位。'}</p>
      {legendRoles.length > 0 && <ul className="overview-map-legend" aria-label="所选线路点位图例">{legendRoles.map((role) => <li key={role.className}><span className={`overview-map-legend-swatch ${role.className}`} aria-hidden="true" />{role.name}</li>)}</ul>}
    </div>
  </div>;
}
