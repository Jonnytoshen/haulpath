'use client';

import { useId, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { ArrowUpRight, Check, Scan } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatKilometers, routeStatus, strategyLabels, type Route } from '@haulpath/domain';
import OverviewMap, { overviewRouteColor } from './overview-map';
import { OrderedPoints, RouteState, resultTime } from './route-overview-details';
import type { OverviewBrowsing } from './route-overview';
import type { LocalPlanningRequest } from './use-project-routes';
import type { MapConfig } from './amap-loader';

type Props = {
  config: MapConfig | null;
  routes: Route[];
  selected: Route | null;
  browsing: OverviewBrowsing;
  onBrowsingChange: Dispatch<SetStateAction<OverviewBrowsing>>;
  planningRequests: LocalPlanningRequest[];
  onSelect: (route: Route) => void;
  onOpen: (route: Route) => void;
  onTogglePoints: (id: string) => void;
};

export default function RouteOverviewMap({ config, routes, selected, browsing, onBrowsingChange, planningRequests, onSelect, onOpen, onTogglePoints }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const id = useId();
  const summaryId = `${id}-summary`;
  const initialListTop = useRef(browsing.listTop);
  useLayoutEffect(() => { list.current?.scrollTo(0, initialListTop.current); }, []);
  useLayoutEffect(() => {
    details.current?.scrollTo(0, 0);
    summary.current?.scrollTo(0, 0);
  }, [selected?.id]);
  const valid = selected?.snapshot?.inputVersion === selected?.inputVersion && !!selected?.snapshot;

  return <div className="overview-map-layout">
    <div className="overview-map-column">
      <div className="overview-map-heading">
        <div><h3>项目线路分布</h3><p>{selected ? <><span className="overview-route-color" style={{ backgroundColor: overviewRouteColor(selected.id) }} aria-hidden="true" />{selected.name}</> : '选择线路，查看道路走向与有序点位'}</p></div>
        <Button className="button" onClick={() => onBrowsingChange((current) => ({ ...current, previewRouteId: null, mapRequest: { version: current.mapRequest.version + 1, target: 'all' } }))}><Scan aria-hidden="true" />查看全部</Button>
      </div>
      <OverviewMap config={config} routes={routes} selectedId={selected?.id ?? null} camera={browsing.mapCamera} viewRequest={browsing.mapRequest} onSelect={onSelect} onCameraChange={(camera) => onBrowsingChange((current) => camera.request === current.mapRequest.version ? { ...current, mapCamera: camera } : current)} />
    </div>

    <aside className="overview-map-sidebar" aria-label="地图线路资料">
      <div className="overview-map-list-heading"><h3>线路列表</h3><span>{routes.length} 条</span></div>
      <span className="sr-only" role="status" aria-label="线路预览状态" aria-live="polite" aria-atomic="true">{selected ? `已预览 ${selected.name}。${previewDescription(selected)}` : ''}</span>
      <div ref={list} className="overview-map-list" role="region" aria-label="地图线路列表" tabIndex={0} onScroll={(event) => { const listTop = event.currentTarget.scrollTop; onBrowsingChange((current) => ({ ...current, listTop })); }}>
        {routes.map((route) => {
          const routeValid = route.snapshot?.inputVersion === route.inputVersion;
          const isSelected = selected?.id === route.id;
          const descriptionId = `${id}-${route.id}-description`;
          return <div className="overview-map-route-item" key={route.id}>
            <Button className="overview-map-route" aria-label={`预览 ${route.name}`} aria-describedby={descriptionId} aria-pressed={isSelected} onClick={() => onSelect(route)}>
              <span className="overview-route-color" style={{ backgroundColor: overviewRouteColor(route.id) }} aria-hidden="true" />
              <span className="overview-map-route-info"><strong>{route.name}</strong><span><span className={`status status-${routeStatus(route)}`}>{routeStatus(route)}</span><span>{route.points.length} 个点</span></span></span>
              <span className="overview-map-route-end">{isSelected && <Check aria-hidden="true" />}<span>{routeValid ? formatKilometers(route.snapshot!.totalDistanceMeters) : '—'} <small>km</small></span></span>
            </Button>
            <span className="sr-only" id={descriptionId}>{previewDescription(route)}</span>
            {isSelected && <a className="overview-summary-shortcut" href={`#${summaryId}`} onClick={(event) => {
              event.preventDefault();
              summary.current?.focus({ preventScroll: true });
              summary.current?.scrollIntoView({ block: 'nearest' });
            }}>跳到所选线路摘要</a>}
          </div>;
        })}
      </div>

      {selected ? <section ref={summary} id={summaryId} className="overview-map-summary" role="region" aria-label="所选线路摘要" tabIndex={-1}>
        <div className="overview-summary-core">
          <div className="overview-summary-heading"><h3>{selected.name}</h3><RouteState route={selected} planningRequests={planningRequests} /></div>
          <dl><div className="overview-summary-distance"><dt>总里程（km）</dt><dd>{valid ? formatKilometers(selected.snapshot!.totalDistanceMeters) : '—'}</dd></div></dl>
        </div>
        <div ref={details} className="overview-summary-scroll" role="region" aria-label="所选线路详细资料" tabIndex={0}>
          <dl>
            <div><dt>有序点位 · {selected.points.length} 个点</dt><dd><OrderedPoints route={selected} expanded={browsing.expanded.includes(selected.id)} onToggle={() => onTogglePoints(selected.id)} /></dd></div>
            <div><dt>规划偏好</dt><dd>{strategyLabels[selected.strategy]}</dd></div>
            <div><dt>有效结果时间 · 北京时间</dt><dd>{valid ? resultTime.format(new Date(selected.snapshot!.calculatedAt)) : '—'}</dd></div>
          </dl>
          {!valid && <p className="overview-preview-note">{selected.points.length ? '暂无有效道路方案，地图仅显示当前点位。' : '尚未添加点位，可打开线路继续编排。'}</p>}
        </div>
        <div className="overview-summary-action"><Button className="button primary" onClick={() => onOpen(selected)}>打开线路<ArrowUpRight aria-hidden="true" /></Button></div>
      </section> : <div className="overview-preview-hint"><p>尚未选择线路</p><span>选择地图折线或列表中的线路，核对点位、偏好和有效结果。</span></div>}
    </aside>
  </div>;
}

function previewDescription(route: Route) {
  const distance = route.snapshot?.inputVersion === route.inputVersion ? `总里程 ${formatKilometers(route.snapshot.totalDistanceMeters)} 公里` : '暂无有效里程';
  return `${routeStatus(route)}，${route.points.length} 个点，${distance}。`;
}
