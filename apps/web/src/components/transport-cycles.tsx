'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowRight,
  Check,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import {
  cycleIsClosed,
  cycleReadiness,
  effectiveCycleRoads,
  formatKilometers,
  PLANNING_NOTICE,
  routeStatus,
  strategyLabels,
  strategyGroups,
  type Strategy,
  type CoordinateSystem,
  type PlanningScenario,
  type Point,
  type Route,
  type TransportCycle,
} from '@haulpath/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Dialog } from '@/components/app-dialog';
import { request } from '@/lib/client-request';
import styles from './transport-cycles.module.css';

type DraftPosition = { key: string; id?: string; point: Point };
type CycleEditor = {
  cycle: TransportCycle;
  name: string;
  strategy: Strategy;
  positions: DraftPosition[];
  confirmed: boolean;
};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。';
const displayTime = (time: string) =>
  new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export default function TransportCycles({
  scenario,
  disabled,
  onChange,
  onWritingChange,
}: {
  scenario: PlanningScenario;
  disabled: boolean;
  onChange: (scenario: PlanningScenario) => void;
  onWritingChange: (writing: boolean) => void;
}) {
  const path = `/api/projects/${encodeURIComponent(scenario.projectId)}/scenarios/${encodeURIComponent(scenario.id)}/cycles`;
  const cycles = scenario.context.transportCycles ?? [];
  const [importing, setImporting] = useState(false);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<CycleEditor | null>(null);
  const [newPoint, setNewPoint] = useState({
    name: '',
    longitude: '',
    latitude: '',
    coordinateSystem: 'GCJ-02' as CoordinateSystem,
  });
  const [deleting, setDeleting] = useState<TransportCycle | null>(null);
  const alive = useRef(true);
  const writing = useRef(false);
  const reads = useRef(0);

  useEffect(() => {
    const lifecycleReads = reads;
    alive.current = true;
    return () => {
      alive.current = false;
      lifecycleReads.current++;
    };
  }, []);

  async function loadRoutes() {
    const read = ++reads.current;
    setLoading(true);
    setError('');
    try {
      const items = await request<Route[]>(
        `/api/projects/${encodeURIComponent(scenario.projectId)}/routes`,
      );
      if (!alive.current || read !== reads.current) return;
      setRoutes(items);
      setSourceId(items[0]?.id ?? '');
    } catch (failure) {
      if (alive.current && read === reads.current) setError(errorMessage(failure));
    } finally {
      if (alive.current && read === reads.current) setLoading(false);
    }
  }

  async function mutate(url: string, method: string, body?: unknown) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    onWritingChange(true);
    setError('');
    setNotice('');
    try {
      const saved = await request<PlanningScenario>(url, method, body);
      if (!alive.current) return;
      onChange(saved);
      setImporting(false);
      setEditor(null);
      setDeleting(null);
      setNotice(method === 'DELETE' ? '运输循环已删除' : '运输循环已保存');
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure));
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (alive.current) setBusy(false);
    }
  }

  function closeDialog() {
    if (writing.current) return;
    reads.current++;
    setImporting(false);
    setEditor(null);
    setDeleting(null);
    setError('');
  }

  function saveCycle(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    void mutate(`${path}/${encodeURIComponent(editor.cycle.id)}`, 'PATCH', {
      expectedRevision: scenario.revision,
      name: editor.name,
      strategy: editor.strategy,
      positions: editor.positions.map(({ id, point }) => ({ ...(id ? { id } : {}), point })),
      confirmed: editor.confirmed,
    });
  }

  function reorderPosition(index: number, offset: number) {
    if (!editor) return;
    const positions = [...editor.positions];
    [positions[index], positions[index + offset]] = [positions[index + offset], positions[index]];
    setEditor({ ...editor, positions, confirmed: false });
  }

  async function appendPoint() {
    if (!editor || writing.current) return;
    writing.current = true;
    setBusy(true);
    onWritingChange(true);
    setError('');
    try {
      const [point] = await request<Point[]>('/api/coordinates', 'POST', {
        points: [
          {
            name: newPoint.name,
            longitude: Number(newPoint.longitude),
            latitude: Number(newPoint.latitude),
            coordinateSystem: newPoint.coordinateSystem,
            source: 'manual',
          },
        ],
      });
      if (!alive.current) return;
      setEditor({
        ...editor,
        positions: [...editor.positions, { key: crypto.randomUUID(), point }],
        confirmed: false,
      });
      setNewPoint({ name: '', longitude: '', latitude: '', coordinateSystem: 'GCJ-02' });
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure));
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (alive.current) setBusy(false);
    }
  }

  const selectedSource = routes.find((route) => route.id === sourceId);
  return (
    <section className={styles.section} aria-label="方案运输循环">
      <header className={styles.heading}>
        <div>
          <h3>运输循环</h3>
          <p>从项目线路保留独立快照，核对业务顺序与回程。</p>
        </div>
        <Button
          className="button"
          disabled={disabled || busy}
          onClick={() => {
            setImporting(true);
            setNotice('');
            void loadRoutes();
          }}
        >
          <Plus aria-hidden="true" />
          从线路建立循环
        </Button>
      </header>
      {notice && (
        <p className={styles.notice} role="status">
          <Check aria-hidden="true" />
          {notice}
        </p>
      )}
      {error && !importing && !editor && !deleting && <p role="alert">{error}</p>}
      {cycles.length === 0 ? (
        <p className={styles.empty}>
          还没有运输循环。选择一条本项目线路，保留点位、规划偏好与已有道路资料。
        </p>
      ) : (
        <div className={styles.cycles}>
          {cycles.map((cycle) => {
            const roads = effectiveCycleRoads(cycle);
            const gaps = cycleReadiness(cycle);
            return (
              <section
                className={styles.cycle}
                aria-label={`运输循环 ${cycle.name}`}
                key={cycle.id}
              >
                <div className={styles.cycleHeading}>
                  <h4>{cycle.name}</h4>
                  <span className={cycle.confirmed ? styles.confirmed : styles.pending}>
                    {cycle.confirmed ? '已确认' : cycleIsClosed(cycle) ? '待确认' : '未闭合'}
                  </span>
                </div>
                <ol className={styles.positions} aria-label="业务点位顺序">
                  {cycle.positions.map((position, index) => (
                    <li key={position.id}>
                      <span className={styles.order}>{index + 1}</span>
                      <div>
                        <strong>{position.point.name}</strong>
                        <span>
                          {index === 0
                            ? '出发点'
                            : index === cycle.positions.length - 1
                              ? '收车点'
                              : '业务点'}{' '}
                          · {position.point.longitude.toFixed(6)},{' '}
                          {position.point.latitude.toFixed(6)}
                        </span>
                      </div>
                      {index < cycle.positions.length - 1 && <ArrowRight aria-hidden="true" />}
                    </li>
                  ))}
                </ol>
                <dl className={styles.facts}>
                  <div>
                    <dt>规划偏好</dt>
                    <dd>{strategyLabels[cycle.strategy]}</dd>
                  </div>
                  <div>
                    <dt>已有道路</dt>
                    <dd>
                      {roads.length} / {Math.max(0, cycle.positions.length - 1)} 个区间
                      {roads.length > 0 &&
                        ` · ${formatKilometers(roads.reduce((total, road) => total + road.leg.distanceMeters, 0))} 公里`}
                    </dd>
                  </div>
                  <div>
                    <dt>线路来源</dt>
                    <dd>
                      {cycle.source.name} · 输入版本 {cycle.source.inputVersion}
                    </dd>
                  </div>
                  <div>
                    <dt>引入时间</dt>
                    <dd>
                      <time dateTime={cycle.source.importedAt}>
                        {displayTime(cycle.source.importedAt)}
                      </time>
                    </dd>
                  </div>
                </dl>
                {gaps.length > 0 && (
                  <div className={styles.gaps}>
                    <p>就绪缺口</p>
                    <ul>
                      {gaps.map((gap) => (
                        <li key={gap}>{gap}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className={styles.cycleActions}>
                  <Button
                    className="button"
                    disabled={disabled || busy}
                    onClick={() => {
                      setError('');
                      setNewPoint({
                        name: '',
                        longitude: '',
                        latitude: '',
                        coordinateSystem: 'GCJ-02',
                      });
                      setEditor({
                        cycle,
                        name: cycle.name,
                        strategy: cycle.strategy,
                        positions: cycle.positions.map((position) => ({
                          key: position.id,
                          id: position.id,
                          point: { ...position.point },
                        })),
                        confirmed: cycle.confirmed,
                      });
                    }}
                  >
                    <Pencil aria-hidden="true" />
                    编辑循环
                  </Button>
                  <Button
                    className="text-button danger-text"
                    disabled={disabled || busy}
                    onClick={() => {
                      setError('');
                      setDeleting(cycle);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    删除循环
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
      )}
      <p className={styles.boundary}>{PLANNING_NOTICE}。确认循环仅表示已核对业务顺序与回程。</p>
      {importing && (
        <Dialog title="从线路建立运输循环" error={error} onClose={closeDialog}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(path, 'POST', {
                sourceRouteId: sourceId,
                expectedRevision: scenario.revision,
              });
            }}
          >
            <label className="field">
              来源线路
              <NativeSelect
                aria-label="来源线路"
                value={sourceId}
                disabled={loading || busy}
                onChange={(event) => setSourceId(event.target.value)}
              >
                <option value="">请选择线路</option>
                {routes.map((route) => (
                  <option value={route.id} key={route.id}>
                    {route.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            {loading ? (
              <p className="helper" role="status">
                正在读取本项目线路…
              </p>
            ) : selectedSource ? (
              <p className="helper">
                {selectedSource.points.length} 个点位 · {strategyLabels[selectedSource.strategy]} ·{' '}
                {routeStatus(selectedSource)}
              </p>
            ) : (
              <p className="helper">本项目暂无可引入线路，请先在线路资料中建立。</p>
            )}
            {error && (
              <Button
                className="text-button"
                disabled={busy || loading}
                onClick={() => void loadRoutes()}
              >
                重新读取线路
              </Button>
            )}
            <p className="helper">保存引入时的资料，后续原线路变更不会自动修改此循环。</p>
            <div className="dialog-actions">
              <Button className="button" disabled={busy} onClick={closeDialog}>
                取消
              </Button>
              <Button
                type="submit"
                className="button primary"
                disabled={busy || loading || !sourceId}
              >
                {busy ? '引入中…' : '引入线路快照'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {editor && (
        <Dialog title="编辑运输循环" error={error} wide onClose={closeDialog}>
          <form onSubmit={saveCycle}>
            <label className="field">
              循环名称
              <Input
                autoFocus
                required
                maxLength={200}
                value={editor.name}
                disabled={busy}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              />
            </label>
            <p className="helper">
              来源：{editor.cycle.source.name} · 输入版本 {editor.cycle.source.inputVersion}
              。修改保存在当前规划方案内。
            </p>
            <label className="field">
              循环规划偏好
              <NativeSelect
                aria-label="循环规划偏好"
                value={editor.strategy}
                disabled={busy}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    strategy: Number(event.target.value) as Strategy,
                    confirmed: false,
                  })
                }
              >
                {strategyGroups.map((group) => (
                  <optgroup label={group.label} key={group.label}>
                    {group.options.map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
            </label>
            <h3 className={styles.editorTitle}>业务点位顺序</h3>
            <ol className={styles.editorPositions}>
              {editor.positions.map((position, index) => (
                <li key={position.key}>
                  <span className={styles.order}>{index + 1}</span>
                  <div>
                    <strong>{position.point.name}</strong>
                    <span>
                      {position.point.longitude.toFixed(6)}, {position.point.latitude.toFixed(6)}
                    </span>
                  </div>
                  <div className={styles.positionActions}>
                    <Button
                      className="icon-button"
                      aria-label={`上移点位 ${index + 1}`}
                      disabled={busy || index === 0}
                      onClick={() => reorderPosition(index, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      className="icon-button"
                      aria-label={`下移点位 ${index + 1}`}
                      disabled={busy || index === editor.positions.length - 1}
                      onClick={() => reorderPosition(index, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      className="icon-button"
                      aria-label={`移除点位 ${index + 1}`}
                      disabled={busy}
                      onClick={() =>
                        setEditor({
                          ...editor,
                          positions: editor.positions.filter((_, current) => current !== index),
                          confirmed: false,
                        })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
            <Button
              className="button"
              disabled={busy || editor.positions.length === 0}
              onClick={() => {
                const first = editor.positions[0];
                if (first)
                  setEditor({
                    ...editor,
                    positions: [
                      ...editor.positions,
                      { key: crypto.randomUUID(), point: { ...first.point } },
                    ],
                    confirmed: false,
                  });
              }}
            >
              <RotateCcw aria-hidden="true" />
              追加起点作为回程终点
            </Button>
            <fieldset className={styles.newPoint} disabled={busy}>
              <legend>补充回程点位</legend>
              <label className="field">
                点位名称
                <Input
                  aria-label="新增点位名称"
                  value={newPoint.name}
                  onChange={(event) => setNewPoint({ ...newPoint, name: event.target.value })}
                />
              </label>
              <div className={styles.coordinates}>
                <label className="field">
                  经度
                  <Input
                    aria-label="新增点位经度"
                    type="number"
                    step="any"
                    min="-180"
                    max="180"
                    value={newPoint.longitude}
                    onChange={(event) =>
                      setNewPoint({ ...newPoint, longitude: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  纬度
                  <Input
                    aria-label="新增点位纬度"
                    type="number"
                    step="any"
                    min="-90"
                    max="90"
                    value={newPoint.latitude}
                    onChange={(event) => setNewPoint({ ...newPoint, latitude: event.target.value })}
                  />
                </label>
              </div>
              <label className="field">
                坐标系
                <NativeSelect
                  aria-label="新增点位坐标系"
                  value={newPoint.coordinateSystem}
                  onChange={(event) =>
                    setNewPoint({
                      ...newPoint,
                      coordinateSystem: event.target.value as CoordinateSystem,
                    })
                  }
                >
                  <option value="GCJ-02">GCJ-02（高德）</option>
                  <option value="WGS84">WGS84（GPS）</option>
                </NativeSelect>
              </label>
              <Button
                className="button"
                disabled={
                  busy ||
                  !newPoint.name.trim() ||
                  !newPoint.longitude.trim() ||
                  !newPoint.latitude.trim()
                }
                onClick={() => void appendPoint()}
              >
                追加业务点位
              </Button>
            </fieldset>
            <label className={styles.confirmation}>
              <input
                type="checkbox"
                checked={editor.confirmed}
                disabled={busy}
                onChange={(event) => setEditor({ ...editor, confirmed: event.target.checked })}
              />
              已核对业务点位顺序与闭合回程
            </label>
            <p className="helper">新增回程区间的道路资料仍需准备，不会反转已有道路代替回程测算。</p>
            <div className="dialog-actions">
              <Button className="button" disabled={busy} onClick={closeDialog}>
                取消
              </Button>
              <Button
                type="submit"
                className="button primary"
                disabled={busy || !editor.name.trim()}
              >
                {busy ? '保存中…' : '保存循环'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {deleting && (
        <Dialog title="删除运输循环" error={error} onClose={closeDialog}>
          <p className="delete-description">
            确认删除“{deleting.name}”？此循环的方案内资料将被移除，来源线路继续保留。
          </p>
          <div className="dialog-actions">
            <Button className="button" disabled={busy} onClick={closeDialog}>
              取消
            </Button>
            <Button
              className="button danger"
              disabled={busy}
              onClick={() =>
                void mutate(
                  `${path}/${encodeURIComponent(deleting.id)}?expectedRevision=${scenario.revision}`,
                  'DELETE',
                )
              }
            >
              {busy ? '删除中…' : '确认删除循环'}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
