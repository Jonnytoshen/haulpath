'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowRight, Check, Download, FolderOpen, GripVertical, MapPin, Plus, Route as RouteIcon, X, AlertTriangle, Search, Menu, ChevronDown, Pencil, Trash2, ArrowLeft, RefreshCw, ListOrdered, SlidersHorizontal, TableProperties, LayoutList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { BrandLogo } from '@/components/brand-logo';
import { Dialog } from './app-dialog';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { PLANNING_NOTICE, formatKilometers, routeStatus, strategyGroups, type CoordinateSystem, type Point, type Project, type Route, type Strategy } from '@/lib/domain';
import MapPanel, { type MapCandidate, type MapConfig } from './map-panel';
import ImportDialog from './import-dialog';
import RouteOverview, { emptyOverviewBrowsing, type OverviewBrowsing } from './route-overview';
import ProjectLibrary from './project-library';
import { request } from '@/lib/client-request';
import { useProjectRoutes, type ProjectRouteRead } from './use-project-routes';
export { request } from '@/lib/client-request';

type Editor = { kind: 'project' | 'route'; id?: string; name: string };
type RemovedPoint = { projectId: string; routeId: string; point: Point; index: number; beforeId?: string; afterId?: string; scope: number };
type PointEditor = { target: 'route' | 'library'; index?: number; existing?: Point; candidate?: MapCandidate };
const routePath = (route: Route) => `/api/routes/${route.id}?projectId=${encodeURIComponent(route.projectId)}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
const strategyDescriptions = Object.fromEntries(strategyGroups.flatMap((group) => group.options.map((option) => [option.value, option.description])));

export default function Workbench() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const routeCache = useProjectRoutes(projectId);
  const { routes, routesRef, refreshing, loaded: routesLoaded, refreshError, refreshRoutes, captureRead, isReadCurrent, isSessionCurrent, beginWrite, commitRoute, removeRoute: removeCachedRoute, endWrite, planningRequests, beginPlanning, isPlanningCurrent, endPlanning } = routeCache;
  const [projectView, setProjectView] = useState<{ projectId: string; view: 'overview' | 'workbench' | 'library' }>({ projectId: '', view: 'overview' });
  const view = projectView.projectId === projectId ? projectView.view : 'overview';
  const setView = (next: 'overview' | 'workbench' | 'library') => setProjectView({ projectId, view: next });
  const [task, setTask] = useState<'edit' | 'plan' | 'results'>('edit');
  const [choosingPoints, setChoosingPoints] = useState(false);
  const [focusRequest, requestFocus] = useState(0);
  const consumedFocus = useRef(0);
  const [overviewSession, setOverviewSession] = useState(() => ({ projectId: '', value: emptyOverviewBrowsing() }));
  const overviewBrowsing = overviewSession.projectId === projectId ? overviewSession.value : emptyOverviewBrowsing();
  const setOverviewBrowsing: Dispatch<SetStateAction<OverviewBrowsing>> = (next) => setOverviewSession((current) => {
    const value = current.projectId === projectId ? current.value : emptyOverviewBrowsing();
    return { projectId, value: typeof next === 'function' ? next(value) : next };
  });
  const [route, setRoute] = useState<Route | null>(null);
  const routeRef = useRef<Route | null>(null);
  const projectRef = useRef('');
  const selection = useRef(0);
  const [library, setLibrary] = useState<Point[]>([]);
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [libraryLoading, setLoading] = useState(true);
  const loading = libraryLoading || routeCache.initialLoading;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pointEditor, setPointEditor] = useState<PointEditor | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<'project' | 'route' | null>(null);
  const [importing, setImporting] = useState(false);
  const [removedPoint, setRemovedPoint] = useState<RemovedPoint | null>(null);
  const undoScope = useRef(0);
  const [libraryDelete, setLibraryDelete] = useState<{ projectId: string; point: Point } | null>(null);
  const [configurationHelp, setConfigurationHelp] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [routeSearch, setRouteSearch] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [libraryLayer, setLibraryLayer] = useState(true);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const planningPending = planningRequests.some((pending) => route?.id === pending.id && route.inputVersion === pending.inputVersion);
  const planningRunning = planningPending || route?.planning?.status === 'running';
  const project = projects.find((item) => item.id === projectId);
  const valid = !!route?.snapshot && route.snapshot.inputVersion === route.inputVersion;
  const planningReady = config?.webServiceConfigured === true;
  const canUndo = removedPoint?.projectId === projectId && removedPoint?.routeId === route?.id && removedPoint.scope === undoScope.current;

  const selectRoute = useCallback((next: Route | null) => {
    if (routeRef.current?.id !== next?.id || routeRef.current?.projectId !== next?.projectId) {
      undoScope.current++; setRemovedPoint(null);
    }
    routeRef.current = next; setRoute(next);
  }, []);
  const applyRoute = useCallback((next: Route, read: ProjectRouteRead) => {
    if (routeCache.applyRoute(next, read) && routeRef.current?.id === next.id) selectRoute(next);
  }, [routeCache.applyRoute, selectRoute]);

  useEffect(() => {
    const current = routeRef.current;
    if (current) selectRoute(routes.find((item) => item.id === current.id) ?? null);
  }, [routes, routesLoaded, selectRoute]);

  useEffect(() => {
    let cancelled = false;
    request<Project[]>('/api/projects').then((items) => {
      if (cancelled) return;
      setProjects(items); setProjectId(items[0]?.id ?? '');
    }).catch((failure) => { if (!cancelled) setError(errorMessage(failure)); }).finally(() => { if (!cancelled) setLoading(false); });
    request<MapConfig>('/api/config').then((value) => { if (!cancelled) setConfig(value); }).catch(() => {
      if (!cancelled) setConfig({ mapKey: '', securityProxyPath: '/_AMapService', webServiceConfigured: false });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    projectRef.current = projectId;
    const epoch = ++selection.current;
    setView('overview'); setOverviewBrowsing(emptyOverviewBrowsing()); selectRoute(null); setLibrary([]); setPointEditor(null); setImporting(false); setError(''); setNotice(''); setRouteSearch(''); setLibrarySearch(''); setTask('edit'); setChoosingPoints(false); setLibraryDelete(null);
    if (!projectId) return;
    setLoading(true);
    const read = captureRead();
    request<Point[]>(`/api/projects/${projectId}/points`).then((nextLibrary) => {
      if (epoch !== selection.current || !isSessionCurrent(read)) return;
      setLibrary(nextLibrary);
    }).catch((failure) => { if (epoch === selection.current) setError(errorMessage(failure)); }).finally(() => { if (epoch === selection.current) setLoading(false); });
  }, [projectId, selectRoute, captureRead, isSessionCurrent]);

  useEffect(() => {
    if (focusRequest === consumedFocus.current) return;
    consumedFocus.current = focusRequest;
    document.getElementById(view === 'overview' ? 'route-overview' : view === 'library' ? 'point-library' : 'line-editor')?.focus({ preventScroll: true });
  }, [focusRequest, view, task]);

  function openRoute(item: Route) {
    if (busy) return;
    selectRoute(item); setView('workbench'); setTask('edit'); setChoosingPoints(false); setError(''); setNotice(''); setNavigationOpen(false); requestFocus((current) => current + 1);
    const read = captureRead();
    request<Route>(routePath(item)).then((next) => applyRoute(next, read)).catch((failure) => {
      if (isReadCurrent(read) && routeRef.current?.id === item.id) setError(errorMessage(failure));
    });
  }

  function showWorkbench() {
    const recent = routesRef.current.find((item) => item.id === routeRef.current?.id) ?? routesRef.current[0];
    if (recent) openRoute(recent);
    else { selectRoute(null); setView('workbench'); requestFocus((current) => current + 1); }
    setTask('edit'); setChoosingPoints(false); setNavigationOpen(false);
  }

  function showLibrary(choose = false) {
    if (busy) return;
    setChoosingPoints(choose && !!routeRef.current); setView('library'); setNavigationOpen(false); setError(''); setNotice(''); requestFocus((current) => current + 1);
  }

  function changeTask(next: 'edit' | 'plan' | 'results') {
    setTask(next); requestFocus((current) => current + 1);
  }

  function returnToRoute() {
    setChoosingPoints(false); setView('workbench'); changeTask('edit');
  }

  function showOverview() {
    setView('overview'); setChoosingPoints(false); setNavigationOpen(false); setError(''); setNotice(''); requestFocus((current) => current + 1);
    void refreshRoutes();
  }

  async function perform(action: () => Promise<void>, message?: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (message) setNotice(message); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function saveRoute(changes: { points?: Point[]; strategy?: Strategy; name?: string }) {
    const current = routeRef.current;
    if (!current) return;
    const write = beginWrite();
    try {
      const next = await request<Route>(routePath(current), 'PATCH', { ...changes, expectedVersion: current.inputVersion });
      if (commitRoute(next, write) && routeRef.current?.id === next.id) selectRoute(next);
    } finally { endWrite(write); }
  }

  async function saveName(event: FormEvent) {
    event.preventDefault();
    if (!editor || (editor.kind === 'route' && loading)) return;
    await perform(async () => {
      if (editor.kind === 'project') {
        const next = await request<Project>(editor.id ? `/api/projects/${editor.id}` : '/api/projects', editor.id ? 'PATCH' : 'POST', { name: editor.name.trim() });
        setProjects((items) => editor.id ? items.map((item) => item.id === next.id ? next : item) : [...items, next]);
        setProjectId(next.id);
      } else {
        const write = beginWrite();
        try {
          const next = await request<Route>(editor.id && routeRef.current ? routePath(routeRef.current) : `/api/projects/${projectId}/routes`, editor.id ? 'PATCH' : 'POST', { name: editor.name.trim() });
          if (!commitRoute(next, write)) return;
          selectRoute(next); setView('workbench'); if (!editor.id) setTask('edit'); setChoosingPoints(false); setRouteSearch(''); setNavigationOpen(false); requestFocus((current) => current + 1);
        } finally { endWrite(write); }
      }
      setEditor(null);
    }, '已保存到本机');
  }

  async function deleteSelected() {
    await perform(async () => {
      if (confirmDelete === 'project' && project) {
        await request(`/api/projects/${project.id}`, 'DELETE');
        const remaining = projects.filter((item) => item.id !== project.id);
        setProjects(remaining); setProjectId(remaining[0]?.id ?? '');
      } else if (confirmDelete === 'route' && route) {
        const write = beginWrite();
        try {
          await request(routePath(route), 'DELETE');
          if (!isSessionCurrent(write)) return;
          removeCachedRoute(route.id, write); selectRoute(null); setView('overview'); requestFocus((current) => current + 1);
        } finally { endWrite(write); }
      }
      setConfirmDelete(null);
    }, '已删除');
  }

  async function addLibraryPoint(point: Point) {
    if (!routeRef.current) { setError('请先选择或新建一条线路，再选用点位。'); return; }
    await perform(() => saveRoute({ points: [...routeRef.current!.points, { ...point, id: crypto.randomUUID(), source: 'library' }] }), '点位已复制到线路，之后独立维护');
  }

  async function savePoint(value: { name: string; longitude: string; latitude: string; coordinateSystem: CoordinateSystem }) {
    if (!pointEditor) return;
    await perform(async () => {
      const capturedProject = projectId;
      const previous = pointEditor.existing;
      const coordinatesUnchanged = previous && previous.originalLongitude === Number(value.longitude) && previous.originalLatitude === Number(value.latitude) && previous.coordinateSystem === value.coordinateSystem;
      const points = coordinatesUnchanged ? [{ ...previous, name: value.name.trim() }] : await request<Point[]>('/api/coordinates', 'POST', { points: [{ name: value.name.trim(), longitude: Number(value.longitude), latitude: Number(value.latitude), coordinateSystem: value.coordinateSystem, source: pointEditor.candidate?.source ?? previous?.source ?? 'manual', poiId: pointEditor.candidate?.poiId ?? previous?.poiId }] });
      if (projectRef.current !== capturedProject) return;
      if (pointEditor.target === 'library') {
        if (pointEditor.existing) {
          const updated = await request<Point>(`/api/projects/${capturedProject}/points/${pointEditor.existing.id}`, 'PATCH', points[0]);
          setLibrary((items) => items.map((item) => item.id === updated.id ? updated : item));
        } else {
          const added = await request<Point[]>(`/api/projects/${capturedProject}/points`, 'POST', { points });
          setLibrary((items) => [...items, ...added]);
        }
      } else {
        const current = routeRef.current;
        if (!current) return;
        const next = [...current.points];
        if (pointEditor.index !== undefined) next[pointEditor.index] = { ...points[0], id: pointEditor.existing!.id };
        else next.push(points[0]);
        await saveRoute({ points: next });
      }
      setPointEditor(null);
    }, '点位已保存');
  }

  async function removePoint(pointId: string) {
    const current = routeRef.current;
    if (!current) return;
    const index = current.points.findIndex((point) => point.id === pointId);
    if (index < 0) return;
    const removal: RemovedPoint = { projectId: current.projectId, routeId: current.id, point: current.points[index], index, beforeId: current.points[index - 1]?.id, afterId: current.points[index + 1]?.id, scope: undoScope.current };
    await perform(async () => {
      await saveRoute({ points: current.points.filter((point) => point.id !== pointId) });
      if (projectRef.current === removal.projectId && routeRef.current?.id === removal.routeId && undoScope.current === removal.scope) setRemovedPoint(removal);
    });
  }

  async function undoPointRemoval() {
    const removal = removedPoint;
    const current = routeRef.current;
    if (!removal || !current || removal.projectId !== projectRef.current || removal.routeId !== current.id || removal.scope !== undoScope.current) return;
    if (current.points.some((point) => point.id === removal.point.id)) { setRemovedPoint(null); return; }
    const points = [...current.points];
    const after = points.findIndex((point) => point.id === removal.afterId);
    const before = points.findIndex((point) => point.id === removal.beforeId);
    const index = after >= 0 ? after : before >= 0 ? before + 1 : Math.min(removal.index, points.length);
    points.splice(index, 0, removal.point);
    await perform(async () => {
      await saveRoute({ points });
      setRemovedPoint((pending) => pending === removal ? null : pending);
    }, '已撤销移除，点位已恢复');
  }

  async function deleteLibraryPoint() {
    const target = libraryDelete;
    if (!target || target.projectId !== projectRef.current) return;
    await perform(async () => {
      await request(`/api/projects/${target.projectId}/points/${target.point.id}`, 'DELETE');
      if (projectRef.current !== target.projectId) return;
      setLibrary((items) => items.filter((point) => point.id !== target.point.id));
      setLibraryDelete(null);
      setNotice('已删除点库点位，线路副本保留');
    });
  }

  async function movePoint(from: number, to: number) {
    const current = routeRef.current;
    if (!current || from === to || to < 0 || to >= current.points.length) return;
    const next = [...current.points]; const [point] = next.splice(from, 1); next.splice(to, 0, point);
    await perform(() => saveRoute({ points: next }), '点位顺序已保存');
  }

  async function plan() {
    const current = routeRef.current;
    if (!current || !planningReady) return;
    setError(''); setNotice('');
    const adjacent = current.points.findIndex((point, index) => index > 0 && point.longitude === current.points[index - 1].longitude && point.latitude === current.points[index - 1].latitude);
    if (adjacent > 0) { setError(`第 ${adjacent}、${adjacent + 1} 个点位坐标完全相同，请调整后规划。`); return; }
    const planning = beginPlanning(current);
    const showForCurrentRoute = () => isPlanningCurrent(planning) && routeRef.current?.id === current.id && routeRef.current.inputVersion === current.inputVersion;
    try {
      const result = await request<Route>(`${routePath(current).replace('?', '/plan?')}`, 'POST');
      if (!isPlanningCurrent(planning)) return;
      applyRoute(result, planning);
      if (showForCurrentRoute()) setNotice('路线方案已完整保存');
    } catch (failure) {
      if (!isPlanningCurrent(planning)) return;
      if (showForCurrentRoute()) setError(errorMessage(failure));
      // A network error does not prove the server task failed. Read its saved state.
      await refreshRoutes();
    } finally { endPlanning(planning); }
  }

  async function downloadExport(single = false) {
    await perform(async () => {
      const response = await fetch(`/api/projects/${projectId}/export${single && route ? `?routeId=${route.id}` : ''}`);
      if (!response.ok) { const payload = await response.json(); throw new Error(payload.error); }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${single ? route?.name : project?.name}-线路测算.xlsx`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'Excel 已导出，包含线路总览和区间明细');
  }

  const mapCandidate = useCallback((candidate: MapCandidate) => {
    if (!routeRef.current) { setError('请先选择或新建一条线路，再添加地图点位。'); return; }
    setPointEditor({ target: 'route', candidate });
  }, []);

  const visibleRoutes = routes.filter((item) => item.name.toLocaleLowerCase().includes(routeSearch.trim().toLocaleLowerCase()));
  const selectingRoute = choosingPoints ? route : null;
  const activeRoute = view === 'workbench' ? route : null;
  const taskItems = [
    { value: 'edit' as const, label: '编排点位', icon: ListOrdered, detail: `${route?.points.length ?? 0} 个点位` },
    { value: 'plan' as const, label: '测算线路', icon: SlidersHorizontal, detail: planningRunning ? '正在测算' : valid ? '已完成测算' : '偏好与地图' },
    { value: 'results' as const, label: '核对方案', icon: TableProperties, detail: valid ? `${formatKilometers(route!.snapshot!.totalDistanceMeters)} km` : '里程与导出' },
  ];
  const createRoute = () => setEditor({ kind: 'route', name: '' });
  const showUndo = canUndo && (view === 'workbench' || choosingPoints);

  const mapPanel = <section className="map-card panel" aria-label="地图预览">
    <div className="map-title"><h2>地图预览</h2><label className="checkbox-label"><Input type="checkbox" checked={libraryLayer} onChange={(event) => setLibraryLayer(event.target.checked)} />显示项目点位库</label></div>
    <MapPanel config={config} route={route} library={libraryLayer ? library : []} onCandidate={mapCandidate} onLibraryPoint={addLibraryPoint} />
    <div className="map-legend"><span><i className="legend-start" />起点</span><span><i className="legend-end" />终点</span><span><i className="legend-library" />项目点位</span><span className="map-hint">点击地图可添加点位 · 坐标 GCJ-02</span></div>
  </section>;

  const resultsPanel = <section className="results-card panel" aria-label="路线方案">
    <div className="panel-heading"><div><h2>路线方案</h2>{route && <span className={`status status-${routeStatus(route)}`}>{routeStatus(route)}</span>}</div><Button className="button" disabled={!route || busy} onClick={() => downloadExport(true)}><Download />导出当前线路</Button></div>
    <div className="result-summary"><div><span>线路总里程</span><strong>{valid ? formatKilometers(route!.snapshot!.totalDistanceMeters) : '—'}<small>km</small></strong></div><div><span>行驶区间</span><strong>{valid ? route!.snapshot!.legs.length : '—'}<small>个</small></strong></div><div className="calculation-time"><span>有效结果时间 · 北京时间</span><strong>{valid ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(route!.snapshot!.calculatedAt)) : '等待规划'}</strong></div></div>
    {valid ? <div className="table-scroll"><Table><TableHeader><TableRow><TableHead>区间</TableHead><TableHead>区间起点 → 终点</TableHead><TableHead>区间里程 / km</TableHead><TableHead>累计里程 / km</TableHead></TableRow></TableHeader><TableBody>{route!.snapshot!.legs.map((leg, index, legs) => <TableRow key={leg.index}><TableCell>{leg.index.toString().padStart(2, '0')}</TableCell><TableCell>{leg.from.name}<ArrowRight className="table-arrow" />{leg.to.name}</TableCell><TableCell>{formatKilometers(leg.distanceMeters)}</TableCell><TableCell>{formatKilometers(legs.slice(0, index + 1).reduce((total, item) => total + item.distanceMeters, 0))}</TableCell></TableRow>)}</TableBody></Table></div> : <div className="result-next"><p className="results-empty">{route && routeStatus(route) === '待重算' ? '当前输入待重算，旧方案不作为当前结果展示或导出。' : '添加至少两个点位并开始规划，查看区间与里程。'}</p><Button className="button" onClick={() => changeTask('plan')}>前往测算线路<ArrowRight /></Button></div>}
    {route?.planning?.status === 'failed' && <p className="planning-error">最近规划失败：{route.planning.error}{valid ? ' 当前有效方案仍可核对和导出。' : ''}</p>}
  </section>;

  return <div className="app-shell">
    <a className="skip-link" href={project ? view === 'overview' ? '#route-overview' : view === 'library' ? '#point-library' : '#line-editor' : '#workspace-content'}>{project ? view === 'overview' ? '跳到线路总览' : view === 'library' ? '跳到项目点位库' : '跳到线路编辑' : '跳到主内容'}</a>
    <aside className={`sidebar ${navigationOpen ? 'navigation-open' : ''}`} aria-label="项目与线路导航">
      <div className="brand-row"><a href="/" className="brand" aria-label="重途首页"><BrandLogo /></a><Button className="navigation-toggle" aria-label={navigationOpen ? '收起项目与线路' : '展开项目与线路'} aria-expanded={navigationOpen} aria-controls="workspace-navigation" onClick={() => setNavigationOpen((open) => !open)}>{navigationOpen ? <X /> : <Menu />}</Button></div>
      <div className="mobile-context"><span>{project?.name ?? '我的项目'}</span><ChevronDown aria-hidden="true" /><span>{activeRoute?.name ?? (view === 'library' ? '项目点位库' : '线路总览')}</span></div>
      <div id="workspace-navigation" className="sidebar-content">
        <div className="sidebar-section-title"><span>我的项目</span><Button className="sidebar-add" aria-label="新建项目" title="新建项目" onClick={() => setEditor({ kind: 'project', name: '' })}><Plus /></Button></div>
        <div className="project-list">{projects.map((item) => <Button className={`project-item ${item.id === projectId ? 'selected' : ''}`} key={item.id} aria-label={item.name} disabled={busy} onClick={() => { setProjectId(item.id); setNavigationOpen(false); }} aria-pressed={item.id === projectId}><FolderOpen className="folder-icon" /><span>{item.name}</span>{item.id === projectId && <Check className="project-check" />}</Button>)}</div>
        {!projects.length && !loading && <p className="sidebar-empty">创建项目，集中整理<br />线路和常用点位。</p>}
        {project && <>
          <nav className="project-navigation" aria-label="项目资源">
            <Button className={view === 'overview' ? 'active' : ''} aria-pressed={view === 'overview'} aria-label="线路总览" onClick={showOverview}><LayoutList />线路总览<span>{routes.length}</span></Button>
            <Button className={view === 'library' && !choosingPoints ? 'active' : ''} aria-pressed={view === 'library' && !choosingPoints} onClick={() => showLibrary()} aria-label="管理点位库"><MapPin />项目点位库<span>{library.length}</span></Button>
          </nav>
          <section className="route-sidebar" aria-label="项目线路">
            <div className="panel-heading"><div><h2>项目线路</h2><span className="count">{routes.length}</span></div><div><Button className="sidebar-add" aria-label="刷新线路" title="刷新线路" disabled={refreshing} onClick={() => void refreshRoutes()}><RefreshCw /></Button><Button className="sidebar-add" aria-label="新建线路" title="新建线路" disabled={busy || loading} onClick={createRoute}><Plus /></Button></div></div>
            <div className="nav-search"><Search aria-hidden="true" /><Input aria-label="搜索线路" placeholder="查找线路" value={routeSearch} onChange={(event) => setRouteSearch(event.target.value)} />{routeSearch && <Button className="search-clear" aria-label="清除线路搜索" onClick={() => setRouteSearch('')}><X /></Button>}</div>
            <div className="route-list">{visibleRoutes.map((item) => <Button key={item.id} className={`route-item ${item.id === activeRoute?.id ? 'active' : ''}`} disabled={busy} aria-pressed={item.id === activeRoute?.id} onClick={() => openRoute(item)}><span className="route-item-name">{item.name}</span><span className="route-item-meta"><span>{item.points.length} 个点位</span><span className={`status status-${routeStatus(item)}`}>{routeStatus(item)}</span></span></Button>)}</div>
            {routes.length > 0 && !visibleRoutes.length && <div className="empty compact"><Search /><p>没有匹配的线路</p><Button className="text-button" onClick={() => setRouteSearch('')}>清除筛选</Button></div>}
            {!routes.length && routesLoaded && <p className="sidebar-empty">新建一条线路，<br />开始编排行驶顺序。</p>}
            <Button className="resume-route" onClick={showWorkbench} disabled={busy || loading} aria-label="线路工作台"><RouteIcon /><span>{route ? '继续编辑线路' : '打开线路工作台'}</span><ArrowRight /></Button>
          </section>
        </>}
        <div className="sidebar-bottom"><span className="connection-dot" />本机工作台<span className="local-caption">项目资料自动保存在本机</span></div>
      </div>
    </aside>

    <main className="workspace" id="workspace-content" tabIndex={-1}>
      {(notice || showUndo) && <div className="message success" role="status"><div className="message-copy">{notice && <span>{notice}</span>}{showUndo && <span>已移除点位 {removedPoint!.point.name}</span>}</div>{showUndo && <Button className="undo-button" disabled={busy} onClick={undoPointRemoval}>撤销移除</Button>}<Button aria-label="关闭成功提示" onClick={() => { setNotice(''); setRemovedPoint(null); }}><X /></Button></div>}
      <header className="topbar">
        <div className="workspace-title">
          {project && <div className="workspace-breadcrumb">{view === 'workbench' || choosingPoints ? <Button className="text-button" onClick={showOverview}><ArrowLeft />返回线路总览</Button> : <span>项目工作区</span>}<span className="breadcrumb-divider">/</span><span>{project.name}</span></div>}
          <h1>{activeRoute?.name ?? (view === 'library' ? choosingPoints ? '选择线路点位' : '项目点位库' : project?.name ?? '从一个项目，规划下一程')}</h1>
          <p>{view === 'workbench' && route ? <><span className={`status status-${routeStatus(route)}`}>{routeStatus(route)}</span><span>{route.points.length} 个点位 · {Math.max(0, route.points.length - 1)} 个相邻区间</span></> : view === 'library' ? choosingPoints ? '从项目资料中选点，按选择顺序加入当前线路。' : '集中维护常用地点，供本项目的线路重复选用。' : project ? '查看行驶安排与测算状态，打开一条线路继续处理。' : '重途 · 行前线路与里程测算'}</p>
        </div>
        <div className="toolbar">{project && (view === 'workbench' && route ? <><Button className="icon-button" aria-label="重命名" title="重命名线路" disabled={busy} onClick={() => setEditor({ kind: 'route', id: route.id, name: route.name })}><Pencil /></Button><Button className="icon-button danger-text" aria-label="删除" title="删除线路" disabled={busy} onClick={() => setConfirmDelete('route')}><Trash2 /></Button></> : <><Button className="icon-button" aria-label="重命名项目" title="重命名项目" disabled={busy} onClick={() => setEditor({ kind: 'project', id: project.id, name: project.name })}><Pencil /></Button><Button className="icon-button danger-text" aria-label="删除项目" title="删除项目" disabled={busy} onClick={() => setConfirmDelete('project')}><Trash2 /></Button><Button className="button" disabled={busy || loading} onClick={() => downloadExport()}><Download />导出项目</Button></>)}</div>
      </header>
      <div className="capability-notice"><AlertTriangle aria-hidden="true" /><div><strong>行前测算参考</strong><span>{PLANNING_NOTICE}</span></div><small>普通驾车测算</small></div>
      {refreshError && <div className="message error" role="alert"><span>读取项目线路失败：{refreshError}</span><Button className="text-button" disabled={refreshing} onClick={() => void refreshRoutes()}>重试读取线路</Button></div>}
      {error && <div className="message error" role="alert"><span>{error}</span><Button aria-label="关闭错误提示" onClick={() => setError('')}><X /></Button></div>}
      {project && loading && <p className="message" role="status">正在加载项目线路与点位库…</p>}

      {!project ? <div className="welcome"><BrandLogo variant="mark" /><h2>把点位连成线路，让里程有据可查。</h2><p>创建项目，整理常用地点；按实际行驶顺序编排线路，<br />手动测算后核对地图与里程，最后导出 Excel。</p><Button className="button primary" onClick={() => setEditor({ kind: 'project', name: '' })}><Plus />创建第一个项目</Button><div className="welcome-flow"><span>创建项目</span><ArrowRight /><span>编排线路</span><ArrowRight /><span>测算与导出</span></div></div>
      : view === 'overview' ? <RouteOverview key={projectId} browsing={overviewBrowsing} onBrowsingChange={setOverviewBrowsing} planningRequests={planningRequests} routes={routes.filter((item) => item.projectId === projectId)} loaded={routesLoaded} refreshError={refreshError} onOpen={openRoute} onCreate={createRoute} createDisabled={busy || loading} />
      : view === 'library' ? <div className="library-view" id="point-library" tabIndex={-1}><ProjectLibrary points={library} loading={loading} busy={busy} route={selectingRoute} query={librarySearch} onQueryChange={setLibrarySearch} onAdd={() => setPointEditor({ target: 'library' })} onImport={() => setImporting(true)} onEdit={(point) => setPointEditor({ target: 'library', existing: point })} onDelete={(point) => setLibraryDelete({ projectId, point })} onSelect={addLibraryPoint} onReturn={returnToRoute} /></div>
      : <section className="route-workspace" aria-label="线路编辑" id="line-editor" tabIndex={-1}>
        {route ? <>
          <nav className="task-navigation" aria-label="线路任务">{taskItems.map((item, index) => <Button key={item.value} className={task === item.value ? 'active' : ''} aria-label={item.label} aria-pressed={task === item.value} aria-current={task === item.value ? 'step' : undefined} onClick={() => changeTask(item.value)}><span className="task-index">{index + 1}</span><item.icon /><span className="task-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>{item.value === 'edit' ? route.points.length >= 2 && <Check className="task-complete" /> : valid && <Check className="task-complete" />}</Button>)}</nav>

          {task === 'edit' ? <div className="task-canvas edit-canvas">
            <section className="editor-panel panel"><div className="panel-heading"><div><h2>有序点位</h2><span className="overview-count">{route.points.length} 个点位</span></div><span className="editor-order-note">按实际行驶顺序测算</span></div>
              <div className="editor-scroll"><div className="point-list" aria-label="有序点位">{route.points.map((point, index) => <div className={`point-card ${dragIndex === index ? 'dragging' : ''}`} key={point.id} draggable={!busy} onDragStart={(event) => { setDragIndex(index); event.dataTransfer.setData('text/plain', String(index)); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDragIndex(null)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const from = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(from)) void movePoint(from, index); setDragIndex(null); }}><GripVertical className="drag-handle" aria-hidden="true" /><span className={`point-number ${index === 0 ? 'start' : index === route.points.length - 1 ? 'end' : ''}`}>{index + 1}</span><div className="point-details"><span className="point-role">{index === 0 ? '起点' : index === route.points.length - 1 ? '终点' : '途经点'}</span><strong>{point.name}</strong><small>{point.longitude.toFixed(6)}, {point.latitude.toFixed(6)}</small></div><div className="point-actions"><Button aria-label={`编辑点位 ${point.name}`} title="编辑点位" disabled={busy} onClick={() => setPointEditor({ target: 'route', index, existing: point })}><Pencil /></Button><Button aria-label={`上移点位 ${index + 1}`} title="上移" disabled={busy || index === 0} onClick={() => movePoint(index, index - 1)}><ArrowUp /></Button><Button aria-label={`下移点位 ${index + 1}`} title="下移" disabled={busy || index === route.points.length - 1} onClick={() => movePoint(index, index + 1)}><ArrowDown /></Button><Button aria-label={`删除点位 ${index + 1}`} title="移除点位" disabled={busy} onClick={() => removePoint(point.id)}><X /></Button></div></div>)}</div>
              {!route.points.length && <div className="empty point-empty"><MapPin /><h3>先确定起点，再编排行程</h3><p>手动输入坐标，或从项目点位库选入常用地点。<br />添加终点后，即可进入线路测算。</p></div>}
              {route.points.length === 1 && <p className="point-guidance"><MapPin aria-hidden="true" />再添加一个点位，即可开始规划。</p>}
              </div>
              <div className="add-points"><Button className="button" disabled={busy} onClick={() => setPointEditor({ target: 'route' })}><Plus />手动添加点位</Button><Button className="button" disabled={busy} onClick={() => showLibrary(true)}><MapPin />从点位库选择</Button></div>
            </section>
            <aside className="task-guide"><div><h2>从地点到行驶安排</h2><p>起点、途经点、终点由排列顺序决定。拖动点位，或用上移、下移按钮调整。</p></div><div className="route-outline"><span>本次行程</span>{route.points.length ? <><strong>{route.points[0].name}</strong><div><span>{Math.max(0, route.points.length - 2)} 个途经点</span><ArrowDown /></div><strong>{route.points.length > 1 ? route.points.at(-1)!.name : '等待添加终点'}</strong></> : <p>起点 → 途经点 → 终点</p>}</div><p className="helper">需要查找地点或地图选点时，进入“测算线路”。点位和顺序变更会自动保存，测算由您手动发起。</p></aside>
          </div> : task === 'plan' ? <div className="task-canvas plan-canvas">
            <section className="planning-panel panel"><div className="panel-heading"><h2>测算设置</h2><span className={`status status-${routeStatus(route)}`}>{routeStatus(route)}</span></div>
              <div className="planning-controls"><div className="strategy-row"><label htmlFor="strategy">规划偏好</label><NativeSelect id="strategy" aria-describedby="strategy-description" value={route.strategy} disabled={busy} onChange={(event) => perform(() => saveRoute({ strategy: Number(event.target.value) as Strategy }))}>{strategyGroups.map((group) => <optgroup label={group.label} key={group.label}>{group.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</optgroup>)}</NativeSelect></div><p className="strategy-description" id="strategy-description" aria-live="polite">{strategyDescriptions[route.strategy]}</p>
              <div className="planning-itinerary"><h3>本次测算范围</h3><p>{route.points.length} 个点位<ArrowRight />{Math.max(0, route.points.length - 1)} 个相邻区间</p><span>各区间使用同一规划偏好，保留当前点位顺序。</span><Button className="text-button" onClick={() => changeTask('edit')}><ListOrdered />调整点位与顺序</Button></div>
              <div className="planning-readiness" id="planning-readiness"><span>{config === null ? '正在读取测算配置…' : !planningReady ? '配置 Web 服务后可测算' : route.points.length < 2 ? '至少需要两个点位，才能开始规划。' : `将测算 ${route.points.length - 1} 个相邻区间，保留当前点位顺序。`}</span>{config !== null && !planningReady && <Button className="text-button" onClick={() => setConfigurationHelp(true)}>查看测算配置</Button>}</div>
              <Button className="button primary plan-button" aria-describedby="planning-readiness" disabled={busy || !planningReady || route.points.length < 2 || planningRunning} onClick={plan}>{planningRunning ? `规划中 ${route.planning?.completed ?? 0}/${route.planning?.total ?? route.points.length - 1}` : valid ? '重新规划' : '开始规划'}<RouteIcon /></Button>
              {planningRunning && <progress aria-label="区间规划进度" max={route.planning?.total ?? route.points.length - 1} value={route.planning?.completed ?? 0} />}{!planningRunning && route.planning?.status === 'failed' && <p className="planning-error" role="alert">{route.planning.error}</p>}{routeStatus(route) === '待重算' && <p className="stale-message">点位或偏好已变更，请重新规划。最近成功方案已保留。</p>}
              {valid && <div className="plan-success"><Check /><div><strong>完整路线方案已就绪</strong><span>{formatKilometers(route.snapshot!.totalDistanceMeters)} km · {route.snapshot!.legs.length} 个区间</span></div></div>}
              </div>
            </section>
            {mapPanel}
          </div> : <div className="task-canvas results-canvas">{resultsPanel}{mapPanel}</div>}

          <div className="task-actionbar"><span className="save-indicator"><Check />{busy ? '正在保存…' : '所有修改自动保存到本机'}</span><div>{task !== 'edit' && <Button className="button subtle" onClick={() => changeTask(task === 'plan' ? 'edit' : 'plan')}><ArrowLeft />{task === 'plan' ? '返回编排点位' : '返回测算线路'}</Button>}{task === 'edit' ? <Button className="button primary" onClick={() => changeTask('plan')}>下一步：测算线路<ArrowRight /></Button> : task === 'plan' && <Button className="button" onClick={() => changeTask('results')}>核对路线方案<ArrowRight /></Button>}</div></div>
        </> : <div className="empty empty-workbench"><RouteIcon /><h2>选择一条线路开始编辑</h2><p>每条线路都有独立的点位顺序、规划偏好和路线方案。</p><Button className="button primary" disabled={busy || loading} onClick={createRoute}><Plus />新建线路</Button></div>}
      </section>}
      <footer className="workspace-footer"><span>重途 · 让线路与里程清晰可见</span><span>本机保存 / 手动测算 / Excel 导出</span></footer>
    </main>
    {editor && <Dialog title={`${editor.id ? '重命名' : '新建'}${editor.kind === 'project' ? '项目' : '线路'}`} error={error} onClose={() => !busy && setEditor(null)}><form onSubmit={saveName}><label className="field">{editor.kind === 'project' ? '项目名称' : '线路名称'}<Input autoFocus required maxLength={200} value={editor.name} placeholder={editor.kind === 'project' ? '例如：长三角运输项目' : '例如：上海仓—南京客户'} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label><p className="helper">{editor.kind === 'project' ? '将相关线路和常用点位归入同一个项目。' : '先保存线路草稿，随时添加和调整点位。'}</p><div className="dialog-actions"><Button type="button" className="button" onClick={() => setEditor(null)} disabled={busy}>取消</Button><Button type="submit" className="button primary" disabled={busy || !editor.name.trim() || (editor.kind === 'route' && loading)}>{busy ? '保存中…' : editor.id ? '保存名称' : editor.kind === 'project' ? '创建项目' : '创建线路'}</Button></div></form></Dialog>}
    {confirmDelete && <Dialog title={`删除${confirmDelete === 'project' ? '项目' : '线路'}`} description="确认永久删除，此操作无法撤销。" error={error} onClose={() => !busy && setConfirmDelete(null)}><p className="delete-description">确定删除“{confirmDelete === 'project' ? project?.name : route?.name}”？{confirmDelete === 'project' ? '项目下的全部线路、点位库和路线方案将一并删除。' : '该线路及其路线方案将一并删除。'}此操作无法撤销。</p><div className="dialog-actions"><Button className="button" disabled={busy} onClick={() => setConfirmDelete(null)}>取消</Button><Button className="button danger" disabled={busy} onClick={deleteSelected}>确认删除</Button></div></Dialog>}
    {libraryDelete && <Dialog title="删除点库点位" description="永久删除点库点位，已选入线路的副本保留。此操作无法撤销。" error={error} onClose={() => !busy && setLibraryDelete(null)}><p className="delete-description">确认永久删除点库点位 <strong>{libraryDelete.point.name}</strong>？已选入线路的副本会保留，此操作无法撤销。</p><div className="dialog-actions"><Button className="button" disabled={busy} onClick={() => setLibraryDelete(null)}>取消</Button><Button className="button danger" disabled={busy} onClick={deleteLibraryPoint}>确认删除点位</Button></div></Dialog>}
    {configurationHelp && <Dialog title="测算配置帮助" description="查看本机测算与地图配置方法。" onClose={() => setConfigurationHelp(false)}><div className="configuration-help"><p>驾车测算需要本机服务端的高德 Web 服务 Key。点位与线路草稿可以继续保存。</p><ol><li>在本机 <code>.env.local</code> 中设置 <code>AMAP_WEB_SERVICE_KEY</code>。</li><li>重启重途服务，然后刷新此页面。</li></ol><p>仅使用地图预览或地点搜索时，还需配置 <code>AMAP_JS_KEY</code> 与 <code>AMAP_JS_SECURITY_CODE</code>。缺少 JS 地图配置不会阻止已配置的服务端测算。</p><p className="helper">密钥仅在本机环境文件中配置，不要在界面或文档中粘贴真实密钥。</p></div><div className="dialog-actions"><Button className="button primary" onClick={() => setConfigurationHelp(false)}>我知道了</Button></div></Dialog>}
    {pointEditor && <PointDialog key={`${pointEditor.target}-${pointEditor.index}-${pointEditor.existing?.id}-${pointEditor.candidate?.longitude}`} editor={pointEditor} error={error} busy={busy} onClose={() => !busy && setPointEditor(null)} onSubmit={savePoint} />}
    {importing && project && <ImportDialog targetRouteName={choosingPoints ? route?.name : undefined} projectId={project.id} onClose={() => setImporting(false)} onImported={(points) => { setLibrary((items) => [...items, ...points]); setImporting(false); setNotice(`已导入 ${points.length} 个点位${choosingPoints ? '，请选入当前线路' : '到项目点位库'}`); }} />}
  </div>;
}

function PointDialog({ editor, busy, error, onClose, onSubmit }: { editor: PointEditor; error: string; busy: boolean; onClose: () => void; onSubmit: (value: { name: string; longitude: string; latitude: string; coordinateSystem: CoordinateSystem }) => Promise<void> }) {
  const [name, setName] = useState(editor.existing?.name ?? editor.candidate?.name ?? '');
  const [longitude, setLongitude] = useState(String(editor.existing?.originalLongitude ?? editor.candidate?.longitude ?? ''));
  const [latitude, setLatitude] = useState(String(editor.existing?.originalLatitude ?? editor.candidate?.latitude ?? ''));
  const [coordinateSystem, setCoordinateSystem] = useState<CoordinateSystem>(editor.existing?.coordinateSystem ?? 'GCJ-02');
  const title = editor.existing ? '编辑点位' : editor.candidate ? '确认地图点位' : '添加点位';
  return <Dialog title={title} error={error} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void onSubmit({ name, longitude, latitude, coordinateSystem }); }}><p className="helper">{editor.target === 'library' ? '保存到当前项目点位库。' : '确认后保存到当前线路的有序点位中。'}</p><label className="field">点位名称<Input required autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：上海仓" /></label><div className="coordinate-fields"><label className="field">经度<Input required type="number" min="-180" max="180" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} placeholder="121.473701" /></label><label className="field">纬度<Input required type="number" min="-90" max="90" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} placeholder="31.230416" /></label></div><label className="field">原始坐标系<NativeSelect aria-label="原始坐标系" value={coordinateSystem} disabled={!!editor.candidate} onChange={(event) => setCoordinateSystem(event.target.value as CoordinateSystem)}><option value="GCJ-02">GCJ-02（高德，默认）</option><option value="WGS84">WGS84（GPS）</option></NativeSelect></label><p className="helper">请确认坐标系。WGS84 将经高德服务转换，原始坐标会保留。</p><div className="dialog-actions"><Button type="button" className="button" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" className="button primary" disabled={busy || !name.trim()}>{busy ? '校验并保存中…' : '确认保存点位'}</Button></div></form></Dialog>;
}
