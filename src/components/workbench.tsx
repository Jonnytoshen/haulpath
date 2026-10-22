'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowRight, Check, Download, FolderOpen, GripVertical, MapPin, Plus, Route as RouteIcon, Upload, X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { DialogRoot, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { PLANNING_NOTICE, formatKilometers, routeStatus, strategyLabels, type CoordinateSystem, type Point, type Project, type Route, type Strategy } from '@/lib/domain';
import MapPanel, { type MapCandidate, type MapConfig } from './map-panel';
import ImportDialog from './import-dialog';

export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, cache: 'no-store', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error ?? `操作失败（${response.status}），请稍后重试。`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function Dialog({ title, children, onClose, wide = false, error }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; error?: string }) {
  return <DialogRoot open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className={wide ? 'max-w-4xl' : ''}><div className="dialog-title"><DialogTitle>{title}</DialogTitle><Button className="icon-button" aria-label="关闭对话框" onClick={onClose}><X /></Button></div><DialogDescription className="sr-only">{title}，填写内容并确认保存。</DialogDescription>{error && <p className="message error" role="alert">{error}</p>}{children}</DialogContent></DialogRoot>;
}

type Editor = { kind: 'project' | 'route'; id?: string; name: string };
type PointEditor = { target: 'route' | 'library'; index?: number; existing?: Point; candidate?: MapCandidate };
const routePath = (route: Route) => `/api/routes/${route.id}?projectId=${encodeURIComponent(route.projectId)}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';

export default function Workbench() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [routes, setRoutes] = useState<Route[]>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const routeRef = useRef<Route | null>(null);
  const projectRef = useRef('');
  const selection = useRef(0);
  const [library, setLibrary] = useState<Point[]>([]);
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pointEditor, setPointEditor] = useState<PointEditor | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<'project' | 'route' | null>(null);
  const [importing, setImporting] = useState(false);
  const [tab, setTab] = useState<'route' | 'library'>('route');
  const [librarySearch, setLibrarySearch] = useState('');
  const [libraryLayer, setLibraryLayer] = useState(true);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [planningRequest, setPlanningRequest] = useState<{ id: string; inputVersion: number } | null>(null);
  const planningPending = route?.id === planningRequest?.id && route?.inputVersion === planningRequest?.inputVersion;
  const planningRunning = planningPending || route?.planning?.status === 'running';
  const project = projects.find((item) => item.id === projectId);
  const valid = !!route?.snapshot && route.snapshot.inputVersion === route.inputVersion;

  const selectRoute = useCallback((next: Route | null) => { routeRef.current = next; setRoute(next); }, []);
  const applyRoute = useCallback((next: Route) => {
    if (projectRef.current !== next.projectId || routeRef.current?.id !== next.id) return;
    const previous = routeRef.current;
    if (previous && (next.inputVersion < previous.inputVersion || next.updatedAt < previous.updatedAt)) return;
    selectRoute(next);
    setRoutes((items) => items.map((item) => item.id === next.id ? next : item));
  }, [selectRoute]);

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
    selectRoute(null); setRoutes([]); setLibrary([]); setPointEditor(null); setImporting(false); setError('');
    if (!projectId) return;
    setLoading(true);
    Promise.all([request<Route[]>(`/api/projects/${projectId}/routes`), request<Point[]>(`/api/projects/${projectId}/points`)]).then(([nextRoutes, nextLibrary]) => {
      if (epoch !== selection.current) return;
      setRoutes(nextRoutes); setLibrary(nextLibrary); selectRoute(nextRoutes[0] ?? null);
    }).catch((failure) => { if (epoch === selection.current) setError(errorMessage(failure)); }).finally(() => { if (epoch === selection.current) setLoading(false); });
  }, [projectId, selectRoute]);

  useEffect(() => {
    if (!route || (!planningPending && route.planning?.status !== 'running')) return;
    let cancelled = false;
    const poll = async () => {
      try { const next = await request<Route>(routePath(route)); if (!cancelled) applyRoute(next); }
      catch { /* The planning request reports actionable failures; polling retries. */ }
    };
    const timer = setInterval(poll, 500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [route?.id, route?.planning?.status, route?.planning?.taskId, planningPending, applyRoute]);

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
    const next = await request<Route>(routePath(current), 'PATCH', { ...changes, expectedVersion: current.inputVersion });
    applyRoute(next);
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
        const next = await request<Route>(editor.id && routeRef.current ? routePath(routeRef.current) : `/api/projects/${projectId}/routes`, editor.id ? 'PATCH' : 'POST', { name: editor.name.trim() });
        selection.current++; setLoading(false);
        setRoutes((items) => editor.id ? items.map((item) => item.id === next.id ? next : item) : [...items, next]);
        selectRoute(next); setTab('route');
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
        await request(routePath(route), 'DELETE');
        const remaining = routes.filter((item) => item.id !== route.id);
        setRoutes(remaining); selectRoute(remaining[0] ?? null);
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

  async function movePoint(from: number, to: number) {
    const current = routeRef.current;
    if (!current || from === to || to < 0 || to >= current.points.length) return;
    const next = [...current.points]; const [point] = next.splice(from, 1); next.splice(to, 0, point);
    await perform(() => saveRoute({ points: next }), '点位顺序已保存');
  }

  async function plan() {
    const current = routeRef.current;
    if (!current) return;
    setError(''); setNotice('');
    const adjacent = current.points.findIndex((point, index) => index > 0 && point.longitude === current.points[index - 1].longitude && point.latitude === current.points[index - 1].latitude);
    if (adjacent > 0) { setError(`第 ${adjacent}、${adjacent + 1} 个点位坐标完全相同，请调整后规划。`); return; }
    const optimistic = { ...current, planning: { taskId: 'pending', inputVersion: current.inputVersion, status: 'running' as const, completed: 0, total: current.points.length - 1 } };
    setPlanningRequest({ id: current.id, inputVersion: current.inputVersion });
    try {
      const result = await request<Route>(`${routePath(current).replace('?', '/plan?')}`, 'POST');
      applyRoute(result);
      if (routeRef.current?.id === current.id && routeRef.current.inputVersion === current.inputVersion) setNotice('路线方案已完整保存');
    } catch (failure) {
      if (routeRef.current?.id !== current.id || routeRef.current.inputVersion !== current.inputVersion) return;
      setError(errorMessage(failure));
      try { applyRoute(await request<Route>(routePath(current))); }
      catch { applyRoute({ ...current, planning: { ...optimistic.planning, status: 'failed', error: errorMessage(failure) } }); }
    } finally { setPlanningRequest((pending) => pending?.id === current.id && pending.inputVersion === current.inputVersion ? null : pending); }
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

  return <div className="app-shell">
    <aside className="sidebar">
      <a href="/" className="brand" aria-label="重途首页"><span className="brand-icon">重</span><span>重途<small>ZHONGTU · 行前测算</small></span></a>
      <div className="sidebar-section-title"><span>我的项目</span><Button className="sidebar-add" aria-label="新建项目" onClick={() => setEditor({ kind: 'project', name: '' })}><Plus /></Button></div>
      <div className="project-list">{projects.map((item) => <Button className={`project-item ${item.id === projectId ? 'selected' : ''}`} key={item.id} onClick={() => { if (!busy) setProjectId(item.id); }} aria-pressed={item.id === projectId}><FolderOpen className="folder-icon" /><span>{item.name}</span></Button>)}</div>
      {!projects.length && !loading && <p className="sidebar-empty">创建项目，开始整理<br />您的线路与点位。</p>}
      <div className="sidebar-bottom"><span className="connection-dot" />本机工作台<span className="local-caption">数据保存在本机 SQLite</span></div>
    </aside>

    <main className="workspace">
      <header className="topbar"><div><span className="breadcrumb">我的项目 <span>/</span> {project?.name ?? '欢迎使用重途'}</span><h1>{project?.name ?? '让每一段行程心中有数'}</h1></div><div className="toolbar">{project && <><Button className="button subtle" onClick={() => setEditor({ kind: 'project', id: project.id, name: project.name })}>重命名项目</Button><Button className="button subtle danger-text" onClick={() => setConfirmDelete('project')}>删除项目</Button><Button className="button" disabled={busy} onClick={() => downloadExport()}><Download />导出项目</Button></>}</div></header>
      <div className="capability-notice"><AlertTriangle aria-hidden="true" /><div><strong>行前测算参考</strong><span>{PLANNING_NOTICE}</span></div><small>普通驾车规划 2.0</small></div>
      {error && <div className="message error" role="alert"><span>{error}</span><Button aria-label="关闭错误提示" onClick={() => setError('')}><X /></Button></div>}
      {notice && <div className="message success" role="status"><span>{notice}</span><Button aria-label="关闭成功提示" onClick={() => setNotice('')}><X /></Button></div>}
      {project && loading && <p className="message" role="status">正在加载项目线路与点位库…</p>}
      {!project ? <div className="welcome"><span className="welcome-mark"><RouteIcon /></span><h2>从一个项目，规划下一程</h2><p>集中管理线路和点位，预览行驶方案，<br />将区间与里程导出为清晰的 Excel 表格。</p><Button className="button primary" onClick={() => setEditor({ kind: 'project', name: '' })}>创建第一个项目</Button><small>个人使用 · 本机保存 · 手动规划</small></div> : <div className="workbench-grid">
        <section className="route-sidebar panel" aria-label="项目线路">
          <div className="panel-heading"><div><h2>线路</h2><span className="count">{routes.length}</span></div><Button className="text-button" disabled={busy || loading} onClick={() => setEditor({ kind: 'route', name: '' })}><Plus />新建线路</Button></div>
          <div className="route-list">{routes.map((item) => <Button key={item.id} className={`route-item ${item.id === route?.id ? 'active' : ''}`} aria-pressed={item.id === route?.id} onClick={() => { if (!busy) { selectRoute(item); setTab('route'); setError(''); request<Route>(routePath(item)).then(applyRoute).catch((failure) => setError(errorMessage(failure))); } }}><span className="route-item-name">{item.name}</span><span className="route-item-meta"><span>{item.points.length} 个点位</span><span className={`status status-${routeStatus(item)}`}>{routeStatus(item)}</span></span></Button>)}</div>
          {!routes.length && <div className="empty compact"><RouteIcon /><p>还没有线路</p><small>创建线路后，按顺序添加起点、途经点和终点。</small></div>}
          <div className="project-summary"><span>项目点位库</span><strong>{library.length} <small>个点位</small></strong><Button className="text-button" onClick={() => setTab('library')}>管理点位库 <ArrowRight /></Button></div>
        </section>
        <section className="editor-panel panel" aria-label="线路编辑">
          <div className="tabs"><Button className={tab === 'route' ? 'active' : ''} onClick={() => setTab('route')}>线路点位</Button><Button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>项目点位库 <span>{library.length}</span></Button></div>
          {tab === 'route' ? route ? <>
            <div className="route-heading"><div><h2>{route.name}</h2><span className={`status status-${routeStatus(route)}`}>{routeStatus(route)}</span></div><div className="inline-actions"><Button className="text-button" onClick={() => setEditor({ kind: 'route', id: route.id, name: route.name })}>重命名</Button><Button className="text-button danger-text" onClick={() => setConfirmDelete('route')}>删除</Button></div></div>
            <p className="helper">按行驶顺序添加点位，可拖动调整顺序。</p>
            <div className="point-list" aria-label="有序点位">{route.points.map((point, index) => <div className={`point-card ${dragIndex === index ? 'dragging' : ''}`} key={point.id} draggable={!busy} onDragStart={(event) => { setDragIndex(index); event.dataTransfer.setData('text/plain', String(index)); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDragIndex(null)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const from = Number(event.dataTransfer.getData('text/plain')); if (Number.isInteger(from)) void movePoint(from, index); setDragIndex(null); }}><GripVertical className="drag-handle" aria-label="拖动排序" /><span className={`point-number ${index === 0 ? 'start' : index === route.points.length - 1 ? 'end' : ''}`}>{index + 1}</span><div className="point-details"><span className="point-role">{index === 0 ? '起点' : index === route.points.length - 1 ? '终点' : '途经点'}</span><strong>{point.name}</strong><small>{point.longitude.toFixed(6)}, {point.latitude.toFixed(6)}</small></div><div className="point-actions"><Button aria-label={`编辑点位 ${point.name}`} onClick={() => setPointEditor({ target: 'route', index, existing: point })}>编辑</Button><Button aria-label={`上移点位 ${index + 1}`} disabled={busy || index === 0} onClick={() => movePoint(index, index - 1)}><ArrowUp /></Button><Button aria-label={`下移点位 ${index + 1}`} disabled={busy || index === route.points.length - 1} onClick={() => movePoint(index, index + 1)}><ArrowDown /></Button><Button aria-label={`删除点位 ${index + 1}`} disabled={busy} onClick={() => perform(() => saveRoute({ points: route.points.filter((_, position) => position !== index) }))}><X /></Button></div></div>)}</div>
            {!route.points.length && <div className="empty point-empty"><MapPin /><p>添加第一个点位</p><small>搜索地点、点击地图或手动输入坐标。</small></div>}
            <div className="add-points"><Button className="button" disabled={busy} onClick={() => setPointEditor({ target: 'route' })}><Plus />手动添加点位</Button><Button className="button subtle" onClick={() => setTab('library')}>从点位库选择</Button></div>
            <div className="planning-controls"><label htmlFor="strategy">规划偏好</label><NativeSelect id="strategy" value={route.strategy} disabled={busy} onChange={(event) => perform(() => saveRoute({ strategy: Number(event.target.value) as Strategy }))}>{Object.entries(strategyLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</NativeSelect><p className="helper">按相邻点位分别规划后汇总</p><Button className="button primary plan-button" disabled={busy || route.points.length < 2 || planningRunning} onClick={plan}>{planningRunning ? `规划中 ${route.planning?.completed ?? 0}/${route.planning?.total ?? route.points.length - 1}` : valid ? '重新规划' : '开始规划'}<RouteIcon /></Button>{planningRunning && <progress aria-label="区间规划进度" max={route.planning?.total ?? route.points.length - 1} value={route.planning?.completed ?? 0} />}{!planningRunning && route.planning?.status === 'failed' && <p className="planning-error" role="alert">{route.planning.error}</p>}{routeStatus(route) === '待重算' && <p className="stale-message">点位或偏好已变更，请重新规划。最近成功方案已保留。</p>}<span className="save-indicator"><Check />{busy ? '正在保存…' : '修改自动保存到本机'}</span></div>
          </> : <div className="empty"><RouteIcon /><p>选择一条线路开始编辑</p><Button className="button primary" disabled={busy || loading} onClick={() => setEditor({ kind: 'route', name: '' })}>新建线路</Button></div> : <div className="library-panel"><div className="library-intro"><h2>项目点位库</h2><p className="helper">选入线路后独立维护，不受点位库修改影响。</p></div><div className="library-toolbar"><Button className="button small" disabled={busy || loading} onClick={() => setPointEditor({ target: 'library' })}><Plus />添加点位</Button><Button className="button small" disabled={busy || loading} onClick={() => setImporting(true)}><Upload />导入表格</Button><a className="text-button" href="/api/import-template" download>下载模板</a></div><Input className="library-search" aria-label="搜索点位库" placeholder="按名称筛选点位" value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} /><div className="library-list">{library.filter((point) => point.name.includes(librarySearch)).map((point) => <div className="library-point" key={point.id}><div><strong>{point.name}</strong><small>{point.longitude.toFixed(6)}, {point.latitude.toFixed(6)}</small><small>原始坐标系 {point.coordinateSystem}</small></div><div className="library-point-actions"><Button className="text-button" disabled={!route || busy} onClick={() => addLibraryPoint(point)}>选入线路</Button><Button className="text-button" onClick={() => setPointEditor({ target: 'library', existing: point })}>编辑</Button><Button className="text-button danger-text" disabled={busy} onClick={() => perform(async () => { await request(`/api/projects/${projectId}/points/${point.id}`, 'DELETE'); setLibrary((items) => items.filter((item) => item.id !== point.id)); }, '已删除点库点位，线路副本保留')}>删除</Button></div></div>)}</div>{!library.length && <div className="empty compact"><MapPin /><p>常用点位，一次整理多次选用</p><small>手动添加，或从 Excel / CSV 导入。</small></div>}</div>}
        </section>
        <div className="map-results"><section className="map-card panel"><div className="map-title"><h2>地图预览</h2><label className="checkbox-label"><Input type="checkbox" checked={libraryLayer} onChange={(event) => setLibraryLayer(event.target.checked)} />显示项目点位库</label></div><MapPanel config={config} route={route} library={libraryLayer ? library : []} onCandidate={mapCandidate} onLibraryPoint={addLibraryPoint} /><div className="map-legend"><span><i className="legend-start" />起点</span><span><i className="legend-end" />终点</span><span><i className="legend-library" />项目点位</span><span className="map-hint">点击地图可添加点位 · 坐标 GCJ-02</span></div></section>
          <section className="results-card panel" aria-label="路线方案"><div className="panel-heading"><div><h2>路线方案</h2>{route && <span className={`status status-${routeStatus(route)}`}>{routeStatus(route)}</span>}</div><Button className="text-button" disabled={!route || busy} onClick={() => downloadExport(true)}><Download />导出当前线路</Button></div><div className="result-summary"><div><span>线路总里程</span><strong>{valid ? formatKilometers(route!.snapshot!.totalDistanceMeters) : '—'}<small>km</small></strong></div><div><span>行驶区间</span><strong>{valid ? route!.snapshot!.legs.length : '—'}<small>个</small></strong></div><div className="calculation-time"><span>有效结果时间 · 北京时间</span><strong>{valid ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(route!.snapshot!.calculatedAt)) : '等待规划'}</strong></div></div>{valid ? <div className="table-scroll"><Table><TableHeader><TableRow><TableHead>区间</TableHead><TableHead>区间起点 → 终点</TableHead><TableHead>区间里程 / km</TableHead><TableHead>累计里程 / km</TableHead></TableRow></TableHeader><TableBody>{route!.snapshot!.legs.map((leg, index, legs) => <TableRow key={leg.index}><TableCell>{leg.index.toString().padStart(2, '0')}</TableCell><TableCell>{leg.from.name}<ArrowRight className="table-arrow" />{leg.to.name}</TableCell><TableCell>{formatKilometers(leg.distanceMeters)}</TableCell><TableCell>{formatKilometers(legs.slice(0, index + 1).reduce((total, item) => total + item.distanceMeters, 0))}</TableCell></TableRow>)}</TableBody></Table></div> : <p className="results-empty">{route && routeStatus(route) === '待重算' ? '当前输入待重算，旧方案不作为当前结果展示或导出。' : '添加至少两个点位并开始规划，查看区间与里程。'}</p>}</section>
        </div>
      </div>}
      <footer className="workspace-footer"><span>重途 · 让线路与里程清晰可见</span><span>本机保存 / 手动测算 / Excel 导出</span></footer>
    </main>
    {editor && <Dialog title={`${editor.id ? '重命名' : '新建'}${editor.kind === 'project' ? '项目' : '线路'}`} error={error} onClose={() => !busy && setEditor(null)}><form onSubmit={saveName}><label className="field">{editor.kind === 'project' ? '项目名称' : '线路名称'}<Input autoFocus required maxLength={200} value={editor.name} placeholder={editor.kind === 'project' ? '例如：长三角运输项目' : '例如：上海仓—南京客户'} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label><p className="helper">{editor.kind === 'project' ? '将相关线路和常用点位归入同一个项目。' : '先保存线路草稿，随时添加和调整点位。'}</p><div className="dialog-actions"><Button type="button" className="button" onClick={() => setEditor(null)} disabled={busy}>取消</Button><Button type="submit" className="button primary" disabled={busy || !editor.name.trim() || (editor.kind === 'route' && loading)}>{busy ? '保存中…' : editor.id ? '保存名称' : editor.kind === 'project' ? '创建项目' : '创建线路'}</Button></div></form></Dialog>}
    {confirmDelete && <Dialog title={`删除${confirmDelete === 'project' ? '项目' : '线路'}`} error={error} onClose={() => !busy && setConfirmDelete(null)}><p className="delete-description">确定删除“{confirmDelete === 'project' ? project?.name : route?.name}”？{confirmDelete === 'project' ? '项目下的全部线路、点位库和路线方案将一并删除。' : '该线路及其路线方案将一并删除。'}此操作无法撤销。</p><div className="dialog-actions"><Button className="button" disabled={busy} onClick={() => setConfirmDelete(null)}>取消</Button><Button className="button danger" disabled={busy} onClick={deleteSelected}>确认删除</Button></div></Dialog>}
    {pointEditor && <PointDialog key={`${pointEditor.target}-${pointEditor.index}-${pointEditor.existing?.id}-${pointEditor.candidate?.longitude}`} editor={pointEditor} error={error} busy={busy} onClose={() => !busy && setPointEditor(null)} onSubmit={savePoint} />}
    {importing && project && <ImportDialog projectId={project.id} onClose={() => setImporting(false)} onImported={(points) => { setLibrary((items) => [...items, ...points]); setImporting(false); setNotice(`已导入 ${points.length} 个点位`); }} />}
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
