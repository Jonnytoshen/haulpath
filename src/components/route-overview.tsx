'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { Map, Plus, Route as RouteIcon, Search, TableProperties } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import type { LocalPlanningRequest } from './use-project-routes';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatKilometers, routeStatus, strategyLabels, type Route } from '@/lib/domain';
import OverviewMap, { overviewRouteColor, type MapCamera, type MapViewRequest } from './overview-map';
import type { MapConfig } from './amap-loader';

const resultTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
type OverviewSort = 'created' | 'name-asc' | 'name-desc' | 'distance-asc' | 'distance-desc' | 'time-asc' | 'time-desc';
export type OverviewBrowsing = { query: string; status: 'all' | ReturnType<typeof routeStatus>; sort: OverviewSort; expanded: string[]; left: number; top: number; view: 'table' | 'map'; previewRouteId: string | null; mapCamera: MapCamera | null; mapRequest: MapViewRequest; listTop: number };
export const emptyOverviewBrowsing = (): OverviewBrowsing => ({ query: '', status: 'all', sort: 'created', expanded: [], left: 0, top: 0, view: 'table', previewRouteId: null, mapCamera: null, mapRequest: { version: 0, target: 'all' }, listTop: 0 });
type Props = { config: MapConfig | null; browsing: OverviewBrowsing; onBrowsingChange: Dispatch<SetStateAction<OverviewBrowsing>>; planningRequests: LocalPlanningRequest[]; routes: Route[]; loaded: boolean; refreshError: string; onOpen: (route: Route) => void; onCreate: () => void; createDisabled: boolean };

export default function RouteOverview({ config, browsing, onBrowsingChange, planningRequests, routes, loaded, refreshError, onOpen, onCreate, createDisabled }: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scroll.current?.scrollTo(browsing.left, browsing.top);
    list.current?.scrollTo(0, browsing.listTop);
  }, [loaded, browsing.view]);
  const query = browsing.query.trim().toLocaleLowerCase();
  const visible = routes.filter((route) => (browsing.status === 'all' || routeStatus(route) === browsing.status) && (!query || [route.name, ...route.points.map((point) => point.name)].some((name) => name.toLocaleLowerCase().includes(query))));
  if (browsing.sort !== 'created') {
    const direction = browsing.sort.endsWith('desc') ? -1 : 1;
    const names = new Intl.Collator('zh-CN');
    visible.sort((left, right) => {
      if (browsing.sort.startsWith('name')) return names.compare(left.name, right.name) * direction;
      const leftSnapshot = left.snapshot?.inputVersion === left.inputVersion ? left.snapshot : null;
      const rightSnapshot = right.snapshot?.inputVersion === right.inputVersion ? right.snapshot : null;
      if (!leftSnapshot || !rightSnapshot) return leftSnapshot ? -1 : rightSnapshot ? 1 : 0;
      return (browsing.sort.startsWith('distance') ? leftSnapshot.totalDistanceMeters - rightSnapshot.totalDistanceMeters : Date.parse(leftSnapshot.calculatedAt) - Date.parse(rightSnapshot.calculatedAt)) * direction;
    });
  }
  const selected = visible.find((route) => route.id === browsing.previewRouteId) ?? null;
  useEffect(() => {
    if (loaded && browsing.previewRouteId && !selected) onBrowsingChange((current) => ({ ...current, previewRouteId: null }));
  }, [loaded, browsing.previewRouteId, selected, onBrowsingChange]);
  const changeConditions = (conditions: Partial<Pick<OverviewBrowsing, 'query' | 'status'>>) => onBrowsingChange((current) => ({ ...current, ...conditions, mapRequest: { version: current.mapRequest.version + 1, target: 'all' } }));
  const clearConditions = () => changeConditions({ query: '', status: 'all' });
  const selectPreview = (route: Route) => onBrowsingChange((current) => ({ ...current, previewRouteId: route.id, mapRequest: { version: current.mapRequest.version + 1, target: 'selected' } }));
  const togglePoints = (id: string) => onBrowsingChange((current) => ({ ...current, expanded: current.expanded.includes(id) ? current.expanded.filter((value) => value !== id) : [...current.expanded, id] }));
  return <section className="route-overview panel" id="route-overview" aria-label="线路总览" tabIndex={-1}>
    <div className="panel-heading"><div><h2>线路总览</h2><span className="overview-count" aria-live="polite">{visible.length} / {routes.length} 条线路</span></div><div className="overview-actions"><div className="overview-view-switch" role="group" aria-label="总览视图">{(['table', 'map'] as const).map((view) => <Button key={view} aria-pressed={browsing.view === view} onClick={() => onBrowsingChange((current) => ({ ...current, view }))}>{view === 'table' ? <TableProperties /> : <Map />}{view === 'table' ? '表格' : '地图'}</Button>)}</div>{routes.length > 0 && <Button className="button primary" disabled={createDisabled} onClick={onCreate}><Plus />新建线路</Button>}</div></div>
    <div className="overview-controls">
      <label className="overview-search" htmlFor="overview-search">搜索线路与点位<div><Search aria-hidden="true" /><Input id="overview-search" aria-label="搜索总览线路与点位" placeholder="线路名称或任意点位名称" value={browsing.query} onChange={(event) => changeConditions({ query: event.target.value })} /></div></label>
      <label htmlFor="overview-status">结果状态<NativeSelect id="overview-status" aria-label="结果状态筛选" value={browsing.status} onChange={(event) => changeConditions({ status: event.target.value as OverviewBrowsing['status'] })}><option value="all">全部状态</option>{['已规划', '待重算', '未规划'].map((status) => <option key={status} value={status}>{status}</option>)}</NativeSelect></label>
      <label htmlFor="overview-sort">排序<NativeSelect id="overview-sort" aria-label="总览排序" value={browsing.sort} onChange={(event) => onBrowsingChange({ ...browsing, sort: event.target.value as OverviewSort })}>{[['created', '创建顺序'], ['name-asc', '名称升序'], ['name-desc', '名称降序'], ['distance-asc', '有效里程从短到长'], ['distance-desc', '有效里程从长到短'], ['time-asc', '有效结果从旧到新'], ['time-desc', '有效结果从新到旧']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></label>
    </div>
    {!loaded ? <div className="empty"><RouteIcon /><p>{refreshError ? '线路尚未载入，请重试读取。' : '正在读取项目线路…'}</p></div> : !routes.length ? <div className="empty"><RouteIcon /><h3>还没有线路</h3><p>先创建线路草稿，再按实际行驶顺序添加点位。</p><Button className="button primary" disabled={createDisabled} onClick={onCreate}><Plus />新建线路</Button></div> : !visible.length ? <div className="empty"><Search /><h3>没有匹配的线路</h3><p>试试其他线路或点位名称，或清除当前条件。</p><Button className="button" onClick={clearConditions}>清除搜索和筛选</Button></div> : browsing.view === 'map' ? <div className="overview-map-layout">
      <aside className="overview-map-sidebar" aria-label="地图线路资料">
        <div ref={list} className="overview-map-list" role="region" aria-label="地图线路列表" tabIndex={0} onScroll={(event) => { const listTop = event.currentTarget.scrollTop; onBrowsingChange((current) => ({ ...current, listTop })); }}>
          {visible.map((route) => <Button key={route.id} className="overview-map-route" aria-label={`预览 ${route.name}`} aria-pressed={selected?.id === route.id} onClick={() => selectPreview(route)}>
            <span className="overview-route-color" style={{ backgroundColor: overviewRouteColor(route.id) }} aria-hidden="true" />
            <span className="overview-map-route-info"><strong>{route.name}</strong><span><span className={`status status-${routeStatus(route)}`}>{routeStatus(route)}</span><span>{route.points.length} 个点</span><span>{route.snapshot?.inputVersion === route.inputVersion ? `${formatKilometers(route.snapshot!.totalDistanceMeters)} km` : '— km'}</span></span></span>
          </Button>)}
        </div>
        {selected ? <section className="overview-map-summary" role="region" aria-label="所选线路摘要">
          <div className="overview-summary-heading"><h3>{selected.name}</h3><Button className="button" onClick={() => onOpen(selected)}>打开线路</Button></div>
          <RouteState route={selected} planningRequests={planningRequests} />
          <dl><div><dt>有序点位 · {selected.points.length} 个点</dt><dd><OrderedPoints route={selected} expanded={browsing.expanded.includes(selected.id)} onToggle={() => togglePoints(selected.id)} /></dd></div>
            <div><dt>规划偏好</dt><dd>{strategyLabels[selected.strategy]}</dd></div>
            <div className="overview-summary-metrics"><div><dt>总里程（km）</dt><dd>{selected.snapshot?.inputVersion === selected.inputVersion ? formatKilometers(selected.snapshot!.totalDistanceMeters) : '—'}</dd></div><div><dt>有效结果时间 · 北京时间</dt><dd>{selected.snapshot?.inputVersion === selected.inputVersion ? resultTime.format(new Date(selected.snapshot!.calculatedAt)) : '—'}</dd></div></div>
          </dl>
          {selected.snapshot?.inputVersion !== selected.inputVersion && <p className="overview-preview-note">{selected.points.length ? '暂无有效道路方案，地图仅显示当前点位。' : '尚未添加点位，可打开线路继续编排。'}</p>}
        </section> : <p className="overview-preview-hint">选择一条线路，查看点位、规划偏好和有效结果。</p>}
      </aside>
      <div className="overview-map-column"><div className="overview-map-heading"><h3>{selected ? selected.name : '项目线路分布'}</h3><Button className="button" onClick={() => onBrowsingChange((current) => ({ ...current, previewRouteId: null, mapRequest: { version: current.mapRequest.version + 1, target: 'all' } }))}>查看全部</Button></div>
        <OverviewMap config={config} routes={visible} selectedId={selected?.id ?? null} camera={browsing.mapCamera} viewRequest={browsing.mapRequest} onSelect={selectPreview} onCameraChange={(camera) => onBrowsingChange((current) => camera.request === current.mapRequest.version ? { ...current, mapCamera: camera } : current)} />
      </div>
    </div> : <div ref={scroll} className="overview-scroll" role="region" aria-label="线路总览表格" tabIndex={0} onScroll={(event) => { const left = event.currentTarget.scrollLeft; const top = event.currentTarget.scrollTop; onBrowsingChange((current) => ({ ...current, left, top })); }}>
      <Table className="overview-table"><colgroup><col className="overview-name-col" /><col className="overview-points-col" /><col className="overview-count-col" /><col className="overview-strategy-col" /><col className="overview-status-col" /><col className="overview-distance-col" /><col className="overview-time-col" /></colgroup><TableHeader><TableRow>{['线路名称', '有序点位', '点位数', '规划偏好', '状态', '总里程（km）', '有效结果时间 · 北京时间'].map((label) => <TableHead key={label} scope="col">{label}</TableHead>)}</TableRow></TableHeader><TableBody>{visible.map((route) => {
        const valid = route.snapshot?.inputVersion === route.inputVersion;
        return <TableRow key={route.id}><TableCell><Button className="overview-route-name" onClick={() => onOpen(route)}>{route.name}</Button></TableCell><TableCell><OrderedPoints route={route} expanded={browsing.expanded.includes(route.id)} onToggle={() => togglePoints(route.id)} /></TableCell><TableCell className="overview-number">{route.points.length}</TableCell><TableCell>{strategyLabels[route.strategy]}</TableCell><TableCell><RouteState route={route} planningRequests={planningRequests} /></TableCell><TableCell className="overview-number">{valid ? formatKilometers(route.snapshot!.totalDistanceMeters) : '—'}</TableCell><TableCell className="overview-time">{valid ? resultTime.format(new Date(route.snapshot!.calculatedAt)) : '—'}</TableCell></TableRow>;
      })}</TableBody></Table>
    </div>}
  </section>;
}

function RouteState({ route, planningRequests }: { route: Route; planningRequests: LocalPlanningRequest[] }) {
  const task = route.planning?.inputVersion === route.inputVersion ? route.planning : null;
  const running = task?.status === 'running' || planningRequests.some((pending) => pending.id === route.id && pending.inputVersion === route.inputVersion);
  return <><span className={`status status-${routeStatus(route)}`}>{routeStatus(route)}</span>{running ? <span className="overview-task">规划中 {task?.status === 'running' ? task.completed : 0}/{task?.status === 'running' ? task.total : Math.max(0, route.points.length - 1)}</span> : task?.status === 'failed' ? <span className="overview-task overview-task-error">最近规划失败</span> : null}</>;
}

function OrderedPoints({ route, expanded, onToggle }: { route: Route; expanded: boolean; onToggle: () => void }) {
  const text = route.points.map((point) => point.name).join(' → ');
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * 2 + 1);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  if (!route.points.length) return <span className="overview-muted">尚未添加点位</span>;
  return <><div ref={content} id={id} className={`overview-points${expanded ? ' expanded' : ''}`}>{text}</div>{(overflowing || expanded) && <Button className="text-button overview-expand" aria-label={`${expanded ? '收起' : '展开'} ${route.name} 的全部点位`} aria-expanded={expanded} aria-controls={id} onClick={onToggle}>{expanded ? '收起' : '展开全部点位'}</Button>}</>;
}
