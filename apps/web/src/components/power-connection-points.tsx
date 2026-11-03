'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { MapPin, Pencil, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react';
import {
  powerConnectionPointReadiness,
  type CoordinateSystem,
  type Point,
  type PointSource,
  type PowerConnectionPoint,
  type PowerConnectionPointInput,
  type PowerConnectionPointSet,
} from '@haulpath/domain';
import { Dialog } from './app-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import MapPanel, { type MapCandidate, type MapConfig } from './map-panel';
import { request } from '@/lib/client-request';
import styles from './power-connection-points.module.css';

type Draft = {
  key: string;
  id?: string;
  name: string;
  longitude: string;
  latitude: string;
  coordinateSystem: CoordinateSystem;
  source: PointSource;
  availableCapacityKw: string;
  capacitySource: string;
  connectionNotes: string;
  saved?: PowerConnectionPoint;
};
type Preview = { line: number; value?: Draft; error?: string };
const messageOf = (failure: unknown) =>
  failure instanceof Error ? failure.message : '操作失败，请重试。';
const blank = (): Draft => ({
  key: crypto.randomUUID(),
  name: '',
  longitude: '',
  latitude: '',
  coordinateSystem: 'GCJ-02',
  source: 'manual',
  availableCapacityKw: '',
  capacitySource: '',
  connectionNotes: '',
});
function draftOf(point: PowerConnectionPoint): Draft {
  return {
    ...point,
    key: point.id,
    longitude: String(point.originalLongitude),
    latitude: String(point.originalLatitude),
    availableCapacityKw:
      point.availableCapacityKw === null ? '' : String(point.availableCapacityKw),
    saved: point,
  };
}
function inputOf(point: Draft): PowerConnectionPointInput {
  const longitude = Number(point.longitude);
  const latitude = Number(point.latitude);
  if (!point.name.trim()) throw new Error('请填写电源点名称');
  if (!point.longitude.trim() || !Number.isFinite(longitude) || Math.abs(longitude) > 180)
    throw new Error('原始经度须为 -180 至 180 的有限数值');
  if (!point.latitude.trim() || !Number.isFinite(latitude) || Math.abs(latitude) > 90)
    throw new Error('原始纬度须为 -90 至 90 的有限数值');
  if (!['GCJ-02', 'WGS84'].includes(point.coordinateSystem))
    throw new Error('坐标系须为 GCJ-02 或 WGS84');
  const capacity = point.availableCapacityKw.trim() ? Number(point.availableCapacityKw) : null;
  if (capacity !== null && (!Number.isFinite(capacity) || capacity < 0))
    throw new Error('可用容量须为不小于 0 的有限数值，缺失时请留空');
  if (point.capacitySource.length > 5000 || point.connectionNotes.length > 5000)
    throw new Error('容量来源及接入资料说明各最多 5000 字');
  return {
    ...(point.id ? { id: point.id } : {}),
    name: point.name.trim(),
    longitude,
    latitude,
    coordinateSystem: point.coordinateSystem,
    source: point.source,
    availableCapacityKw: capacity,
    capacitySource: point.capacitySource.trim(),
    connectionNotes: point.connectionNotes.trim(),
  };
}
function mapPoint(point: Draft): Point | null {
  const saved = point.saved;
  if (
    saved &&
    saved.coordinateSystem === point.coordinateSystem &&
    saved.originalLongitude === Number(point.longitude) &&
    saved.originalLatitude === Number(point.latitude)
  )
    return { ...saved, id: point.key, name: point.name };
  if (point.coordinateSystem !== 'GCJ-02') return null;
  return {
    id: point.key,
    name: point.name,
    longitude: Number(point.longitude),
    latitude: Number(point.latitude),
    originalLongitude: Number(point.longitude),
    originalLatitude: Number(point.latitude),
    coordinateSystem: 'GCJ-02',
    source: point.source,
  };
}
function gapsOf(point: Draft): string[] {
  return powerConnectionPointReadiness({
    availableCapacityKw: point.availableCapacityKw.trim()
      ? Number(point.availableCapacityKw)
      : null,
    capacitySource: point.capacitySource,
  });
}

export default function PowerConnectionPoints({
  projectId,
  config,
}: {
  projectId: string;
  config: MapConfig | null;
}) {
  const [data, setData] = useState<PowerConnectionPointSet | null>(null);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [editor, setEditor] = useState<Draft | null>(null);
  const [editorError, setEditorError] = useState('');
  const [deleting, setDeleting] = useState<Draft | null>(null);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<Preview[] | null>(null);
  const [mapOpen, setMapOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    request<PowerConnectionPointSet>(
      `/api/projects/${projectId}/power-connection-points`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((next) => {
        setData(next);
        setDraft(next.points.map(draftOf));
        setDirty(false);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(messageOf(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, reload]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function openEditor(value = blank()) {
    setEditorError('');
    setEditor(value);
  }
  function updateDraft(next: Draft[]) {
    setDraft(next);
    setDirty(true);
    setNotice('');
    setError('');
  }
  function addCandidate(candidate: MapCandidate) {
    if (saving || loading) return;
    openEditor({
      ...blank(),
      ...candidate,
      longitude: String(candidate.longitude),
      latitude: String(candidate.latitude),
    });
  }
  function applyEditor(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    try {
      inputOf(editor);
      updateDraft(
        draft.some((point) => point.key === editor.key)
          ? draft.map((point) => (point.key === editor.key ? editor : point))
          : [...draft, editor],
      );
      setEditor(null);
    } catch (failure) {
      setEditorError(messageOf(failure));
    }
  }
  async function save() {
    if (!data || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const points = draft.map(inputOf);
      const next = await request<PowerConnectionPointSet>(
        `/api/projects/${projectId}/power-connection-points`,
        'PUT',
        { expectedRevision: data.revision, points },
      );
      setData(next);
      setDraft(next.points.map(draftOf));
      setDirty(false);
      setNotice(`已保存 ${next.points.length} 个电源接入点`);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setSaving(false);
    }
  }
  function inspectPaste() {
    if (!paste.trim()) {
      setPreview([{ line: 1, error: '请先粘贴电源点资料' }]);
      return;
    }
    const lines = paste.replace(/\r/g, '').split('\n');
    if (!lines.at(-1)?.trim()) lines.pop();
    setPreview(
      lines.map((line, index) => {
        try {
          const cells = line.split('\t');
          if (cells.length < 4 || cells.length > 7)
            throw new Error('须为 4 至 7 列，请按说明用制表符分隔');
          const [
            name,
            longitude,
            latitude,
            coordinateSystem,
            capacity = '',
            source = '',
            notes = '',
          ] = cells;
          const value: Draft = {
            ...blank(),
            name,
            longitude,
            latitude,
            coordinateSystem: (coordinateSystem.trim() || 'GCJ-02') as CoordinateSystem,
            source: 'import',
            availableCapacityKw: capacity,
            capacitySource: source,
            connectionNotes: notes,
          };
          inputOf(value);
          return { line: index + 1, value };
        } catch (failure) {
          return { line: index + 1, error: messageOf(failure) };
        }
      }),
    );
  }

  const ready = draft.filter((point) => gapsOf(point).length === 0).length;
  const mapPoints = draft.flatMap((point) => {
    const mapped = mapPoint(point);
    return mapped ? [mapped] : [];
  });
  return (
    <section
      className={styles.workspace}
      aria-label="项目电源接入点"
      id="power-connection-points"
      tabIndex={-1}
    >
      <div className={`${styles.panel} panel`}>
        <header className={styles.heading}>
          <div>
            <h2>电源资料</h2>
            <p className="helper">
              {draft.length} 个电源点 · {ready} 个基础资料齐备{dirty ? ' · 未保存' : ''}
            </p>
          </div>
          <div className={styles.actions}>
            <Button
              className="button"
              disabled={loading || saving || !data}
              onClick={() => openEditor()}
            >
              <Plus />
              添加电源点
            </Button>
            <Button
              className="button"
              disabled={loading || saving || !data}
              onClick={() => {
                setPasting(true);
                setPaste('');
                setPreview(null);
              }}
            >
              <Upload />
              批量粘贴电源点
            </Button>
            <Button
              className="button primary"
              disabled={!dirty || saving || loading}
              onClick={() => void save()}
            >
              <Save />
              {saving ? '正在保存…' : '保存电源资料'}
            </Button>
          </div>
        </header>
        <div className={styles.context}>
          <p>电源接入点是项目共用资料；位置和名称不代表工程可接电，站址及接电关系须另行确认。</p>
          {!config?.mapKey && config && <p>地图尚未配置，仍可通过表单和列表维护电源资料。</p>}
        </div>
        {error && (
          <div className={styles.feedback} role="alert">
            {error}
            <p>草稿保留；可修正后重试。资料冲突时请重新读取最新版本再编辑。</p>
          </div>
        )}
        {notice && (
          <p className={styles.feedback} role="status">
            {notice}
          </p>
        )}
        <div className={styles.subtoolbar}>
          <Button
            className="text-button"
            disabled={saving || loading}
            aria-expanded={mapOpen}
            onClick={() => setMapOpen(!mapOpen)}
          >
            <MapPin />
            {mapOpen ? '收起选点地图' : '展开选点地图'}
          </Button>
          <Button
            className="text-button"
            disabled={saving || loading}
            onClick={() => {
              if (dirty && !window.confirm('重新读取将放弃未保存的电源资料，是否继续？')) return;
              setLoading(true);
              setError('');
              setNotice('');
              setReload((value) => value + 1);
            }}
          >
            <RefreshCw />
            重新读取
          </Button>
        </div>
        {mapOpen && (
          <div className={styles.map}>
            <MapPanel
              config={config}
              route={null}
              library={mapPoints}
              purpose="power"
              onCandidate={addCandidate}
              onLibraryPoint={(point) => {
                const current = draft.find((item) => item.key === point.id);
                if (current && !saving) openEditor(current);
              }}
            />
          </div>
        )}
        {mapOpen && draft.some((point) => !mapPoint(point)) && (
          <p className={styles.context}>
            新录入或修改的 WGS84 坐标将在成功保存并转换后显示在地图。
          </p>
        )}
        {loading ? (
          <p className={styles.empty} role="status">
            正在读取电源资料…
          </p>
        ) : !data ? (
          <p className={styles.empty}>电源资料读取失败，请点击“重新读取”。</p>
        ) : draft.length === 0 ? (
          <div className={styles.empty}>
            <h3>还没有电源接入点</h3>
            <p>添加位置、可用容量和资料来源；暂缺的工程资料可以留空待补。</p>
          </div>
        ) : (
          <div className={styles.list} role="list" aria-label="电源接入点资料">
            <div className={styles.columns} aria-hidden="true">
              <span>电源点与坐标</span>
              <span>可用容量</span>
              <span>资料来源与就绪状态</span>
              <span>操作</span>
            </div>
            {draft.map((point) => {
              const gaps = gapsOf(point);
              const mapped = mapPoint(point);
              return (
                <article className={styles.row} key={point.key} role="listitem">
                  <div className={styles.identity}>
                    <strong>{point.name}</strong>
                    <small>
                      原始 · {point.coordinateSystem} · {Number(point.longitude).toFixed(6)},{' '}
                      {Number(point.latitude).toFixed(6)}
                    </small>
                    {point.saved && mapped && (
                      <small>
                        地图 · GCJ-02 · {mapped.longitude.toFixed(6)}, {mapped.latitude.toFixed(6)}
                      </small>
                    )}
                  </div>
                  <div className={styles.capacity}>
                    {point.availableCapacityKw.trim()
                      ? `${Number(point.availableCapacityKw).toLocaleString('zh-CN', { maximumSignificantDigits: 15 })} kW`
                      : '—'}
                    <small>可用容量</small>
                  </div>
                  <div className={styles.evidence}>
                    <span>{point.capacitySource || '容量来源待补'}</span>
                    <small className={gaps.length ? styles.gap : ''}>
                      {gaps.length ? `待补资料：${gaps.join('；')}` : '基础资料齐备'}
                    </small>
                    {point.connectionNotes && <small>接入说明：{point.connectionNotes}</small>}
                  </div>
                  <div className={styles.rowActions}>
                    <Button
                      className="icon-button"
                      disabled={saving}
                      aria-label={`编辑电源点 ${point.name}`}
                      title="编辑电源点"
                      onClick={() => openEditor(point)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      className="icon-button danger-text"
                      disabled={saving}
                      aria-label={`删除电源点 ${point.name}`}
                      title="删除电源点"
                      onClick={() => setDeleting(point)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
      {editor && (
        <Dialog
          title={
            editor.id || draft.some((point) => point.key === editor.key)
              ? '编辑电源点'
              : '添加电源点'
          }
          error={editorError}
          onClose={() => setEditor(null)}
        >
          <form onSubmit={applyEditor} className={styles.form}>
            <p className="helper">坐标按声明保存；容量及来源可留空待补，不自动推断接入条件。</p>
            <label className="field">
              电源点名称
              <Input
                value={editor.name}
                required
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              />
            </label>
            <div className={styles.coordinates}>
              <label className="field">
                原始经度
                <Input
                  inputMode="decimal"
                  value={editor.longitude}
                  required
                  onChange={(event) => setEditor({ ...editor, longitude: event.target.value })}
                />
              </label>
              <label className="field">
                原始纬度
                <Input
                  inputMode="decimal"
                  value={editor.latitude}
                  required
                  onChange={(event) => setEditor({ ...editor, latitude: event.target.value })}
                />
              </label>
            </div>
            <label className="field">
              坐标系
              <NativeSelect
                aria-label="坐标系"
                value={editor.coordinateSystem}
                onChange={(event) =>
                  setEditor({ ...editor, coordinateSystem: event.target.value as CoordinateSystem })
                }
              >
                <option value="GCJ-02">GCJ-02</option>
                <option value="WGS84">WGS84</option>
              </NativeSelect>
            </label>
            <label className="field">
              可用容量（kW）
              <Input
                inputMode="decimal"
                value={editor.availableCapacityKw}
                placeholder="缺失时留空"
                onChange={(event) =>
                  setEditor({ ...editor, availableCapacityKw: event.target.value })
                }
              />
            </label>
            <label className="field">
              容量来源
              <Input
                value={editor.capacitySource}
                placeholder="例如供电单位复函、现场核实记录"
                onChange={(event) => setEditor({ ...editor, capacitySource: event.target.value })}
              />
            </label>
            <label className="field">
              接入资料说明
              <textarea
                aria-label="接入资料说明"
                rows={2}
                value={editor.connectionNotes}
                onChange={(event) => setEditor({ ...editor, connectionNotes: event.target.value })}
              />
            </label>
            <div className="dialog-actions">
              <Button className="button" onClick={() => setEditor(null)}>
                取消
              </Button>
              <Button type="submit" className="button primary">
                {draft.some((point) => point.key === editor.key) ? '更新草稿' : '添加到草稿'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {deleting && (
        <Dialog title="删除电源点" onClose={() => setDeleting(null)}>
          <p>将“{deleting.name}”从草稿移除，保存电源资料后生效。</p>
          <div className="dialog-actions">
            <Button className="button" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              className="button danger"
              onClick={() => {
                updateDraft(draft.filter((point) => point.key !== deleting.key));
                setDeleting(null);
              }}
            >
              从草稿移除
            </Button>
          </div>
        </Dialog>
      )}
      {pasting && (
        <Dialog title="批量粘贴电源点" wide onClose={() => setPasting(false)}>
          <div className={styles.form}>
            <p className="helper">
              从表格复制，不含表头。按顺序粘贴：名称、经度、纬度、坐标系、可用容量（kW）、容量来源、接入资料说明。列间用制表符分隔，后
              3 列可留空；全部校验通过后加入草稿。
            </p>
            <label className="field">
              粘贴电源点表格
              <textarea
                aria-label="粘贴电源点表格"
                rows={5}
                value={paste}
                onChange={(event) => {
                  setPaste(event.target.value);
                  setPreview(null);
                }}
              />
            </label>
            <Button className="button" onClick={inspectPaste}>
              校验粘贴内容
            </Button>
            {preview && (
              <div className={styles.preview} role="region" aria-label="电源点粘贴预览">
                <h3>
                  {preview.filter((row) => !row.error).length} 行有效 / 共 {preview.length} 行
                </h3>
                {preview.map((row) => (
                  <p key={row.line} className={row.error ? styles.gap : ''}>
                    第 {row.line} 行 ·{' '}
                    {row.error ??
                      `${row.value?.name} · ${row.value?.coordinateSystem} · ${row.value?.availableCapacityKw || '容量待补'}${row.value?.availableCapacityKw ? ' kW' : ''}`}
                  </p>
                ))}
              </div>
            )}
            <div className="dialog-actions">
              <Button className="button" onClick={() => setPasting(false)}>
                取消
              </Button>
              <Button
                className="button primary"
                disabled={!preview?.length || preview.some((row) => row.error)}
                onClick={() => {
                  if (preview?.length && preview.every((row) => row.value)) {
                    updateDraft([...draft, ...preview.map((row) => row.value!)]);
                    setPasting(false);
                  }
                }}
              >
                加入草稿
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}
