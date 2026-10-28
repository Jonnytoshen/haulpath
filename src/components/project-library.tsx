'use client';

import { ArrowLeft, ArrowRight, Download, MapPin, Pencil, Plus, Search, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Point, Route } from '@/lib/domain';

interface Props {
  points: Point[];
  loading: boolean;
  busy: boolean;
  route: Route | null;
  query: string;
  onQueryChange: (query: string) => void;
  onAdd: () => void;
  onImport: () => void;
  onEdit: (point: Point) => void;
  onDelete: (point: Point) => void;
  onSelect: (point: Point) => void | Promise<void>;
  onReturn: () => void;
}

export default function ProjectLibrary({ points, loading, busy, route, query, onQueryChange, onAdd, onImport, onEdit, onDelete, onSelect, onReturn }: Props) {
  const search = query.trim().toLocaleLowerCase();
  const visible = points.filter((point) => point.name.toLocaleLowerCase().includes(search));

  return <section className="library-panel project-library panel" id="project-library" aria-label="项目点位库" tabIndex={-1}>
    <header className="library-heading">
      <div className="library-intro">
        <h2>{route ? '选择线路点位' : '项目点位库'}</h2>
        <p className="helper">{route ? '按选入顺序追加到线路，选入后可以继续调整。' : '集中维护常用地点，供本项目的线路反复选用。'}</p>
      </div>
      <div className="library-toolbar">
        <Button className="button primary" disabled={busy || loading} onClick={onAdd}><Plus />添加点位</Button>
        <Button className="button" disabled={busy || loading} onClick={onImport}><Upload />导入点位</Button>
        <a className="text-button" href="/api/import-template" download><Download aria-hidden="true" />下载模板</a>
      </div>
    </header>

    {route && <div className="library-context">
      <div className="library-target"><span>当前线路</span><strong>{route.name}</strong><span>已添加 {route.points.length} 个点位</span></div>
      <Button className="button" disabled={busy} onClick={onReturn}><ArrowLeft />返回线路点位</Button>
    </div>}

    <div className="library-controls">
      <div className="library-search-wrap"><Search aria-hidden="true" /><Input className="library-search" aria-label="搜索点位库" placeholder="搜索点位名称" value={query} onChange={(event) => onQueryChange(event.target.value)} />{query && <Button className="search-clear" aria-label="清除点位搜索" onClick={() => onQueryChange('')}><X /></Button>}</div>
      <span className="library-count" aria-live="polite">{loading ? '正在读取点位…' : search ? `${visible.length} / ${points.length} 个点位` : `${points.length} 个点位`}</span>
    </div>

    {loading ? <div className="library-loading" role="status" aria-label="正在读取项目点位库">{[0, 1, 2, 3].map((row) => <div className="library-loading-row" key={row}><span /><span /><span /></div>)}</div> : points.length === 0 ? <div className="empty library-empty"><MapPin /><h3>把常用地点整理在这里</h3><p>手动添加点位，或导入已有的坐标文件。</p><small>{route ? '添加后选入当前线路，点位会排在线路末尾。' : '点位库与线路独立维护，修改点位库不会改变已选入线路的副本。'}</small></div> : visible.length === 0 ? <div className="empty library-empty"><Search /><h3>没有匹配的点位</h3><p>试试其他名称，或清除当前搜索。</p><Button className="button" onClick={() => onQueryChange('')}>清除点位筛选</Button></div> : <>
      <div className="library-columns" aria-hidden="true"><span>点位名称</span><span>地图坐标 · GCJ-02</span><span>原始坐标系</span><span>操作</span></div>
      <div className="library-list" role="list" aria-label="项目点位资料">
        {visible.map((point) => <div className="library-point" key={point.id} role="listitem">
          <div className="library-point-name"><MapPin aria-hidden="true" /><strong>{point.name}</strong></div>
          <div className="library-point-coordinate"><span className="library-mobile-label">地图坐标</span><small>{point.longitude.toFixed(6)}, {point.latitude.toFixed(6)}</small></div>
          <div className="library-point-system"><span className="library-mobile-label">原始坐标系</span><small>{point.coordinateSystem}</small></div>
          <div className="library-point-actions">
            {route && <Button className="text-button library-select" aria-label={`将 ${point.name} 选入当前线路`} disabled={busy} onClick={() => void onSelect(point)}>选入线路<ArrowRight /></Button>}
            <Button className="icon-button" aria-label={`编辑点库点位 ${point.name}`} title="编辑点位" disabled={busy} onClick={() => onEdit(point)}><Pencil /></Button>
            <Button className="icon-button danger-text" aria-label={`删除点库点位 ${point.name}`} title="删除点位" disabled={busy} onClick={() => onDelete(point)}><Trash2 /></Button>
          </div>
        </div>)}
      </div>
    </>}
    <p className="library-footnote">选入线路时复制名称与坐标；之后修改或删除库中点位，线路副本仍会保留。</p>
  </section>;
}
