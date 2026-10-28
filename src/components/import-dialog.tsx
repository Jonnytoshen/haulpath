'use client';

import { useEffect, useRef, useState } from 'react';
import type { CoordinateSystem, Point } from '@/lib/domain';
import { Dialog } from './app-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ArrowRight, Check, MapPin } from 'lucide-react';

interface Sheet { name: string; headers: string[] }
interface Document { documentId: string; path: string }
interface TableRow { rowNumber: number; name: string; originalLongitude?: number | string; originalLatitude?: number | string; errors: string[] }
interface MapEntry { entryId: string; sourceLabel: string; name: string; originalLongitude?: number | string; originalLatitude?: number | string; errors: string[] }
interface TablePreview { rows: TableRow[]; validCount: number; invalidCount: number }
interface MapPreview { format: 'kml' | 'kmz'; entries: MapEntry[]; validCount: number; invalidCount: number; ignored: { kind: string; count: number }[] }
type Inspection = { kind: 'table'; sheets: Sheet[] } | { kind: 'map'; format: 'kml' | 'kmz'; documents: Document[] };
type Preview = { kind: 'table'; data: TablePreview } | { kind: 'map'; data: MapPreview };
type Selection = number | string;
type Operation = 'inspect' | 'preview' | 'confirm';

export default function ImportDialog({ projectId, targetRouteName, onClose, onImported }: { projectId: string; targetRouteName?: string; onClose: () => void; onImported: (points: Point[]) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [sheet, setSheet] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [columns, setColumns] = useState({ name: '0', longitude: '1', latitude: '2' });
  const [coordinateSystem, setCoordinateSystem] = useState<CoordinateSystem>('GCJ-02');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Selection[]>([]);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState('');
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);

  const currentSheet = inspection?.kind === 'table' ? inspection.sheets.find((item) => item.name === sheet) : undefined;
  const isMap = inspection?.kind === 'map';
  const locked = operation === 'confirm';

  async function upload(path: string, form: FormData) {
    const response = await fetch(`/api/projects/${projectId}/import/${path}`, { method: 'POST', body: form });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? '导入失败，请检查文件。');
    return payload;
  }

  async function inspect(nextFile: File | null) {
    const epoch = ++version.current;
    setFile(nextFile);
    setInspection(null);
    setSheet('');
    setDocumentId('');
    setPreview(null);
    setSelected([]);
    setError('');
    setOperation(null);
    if (!nextFile) return;
    if (/\.(?:kml|kmz)$/i.test(nextFile.name) && nextFile.size > 10 * 1024 * 1024) {
      setFile(null);
      setError('KML 或 KMZ 文件不能超过 10 MiB。');
      return;
    }
    setOperation('inspect');
    try {
      const form = new FormData();
      form.append('file', nextFile);
      const result: { format?: 'kml' | 'kmz'; sheets?: Sheet[]; documents?: Document[] } = await upload('inspect', form);
      if (epoch !== version.current) return;
      if (result.format === 'kml' || result.format === 'kmz') {
        const documents = result.documents ?? [];
        setInspection({ kind: 'map', format: result.format, documents });
        setDocumentId(documents.length === 1 ? documents[0].documentId : '');
      } else {
        const sheets = result.sheets ?? [];
        setInspection({ kind: 'table', sheets });
        setSheet(sheets[0]?.name ?? '');
        const headers = sheets[0]?.headers ?? [];
        const find = (pattern: RegExp, fallback: number) => {
          const match = headers.findIndex((header) => pattern.test(header));
          return String(Math.max(0, match < 0 ? fallback : match));
        };
        setColumns({ name: find(/名称|name/i, 0), longitude: find(/经度|longitude|lng/i, 1), latitude: find(/纬度|latitude|lat/i, 2) });
      }
    } catch (failure) {
      if (epoch === version.current) {
        setFile(null);
        setError(failure instanceof Error ? failure.message : '读取文件失败');
      }
    } finally {
      if (epoch === version.current) setOperation(null);
    }
  }

  function changeDocument(next: string) {
    version.current++;
    setDocumentId(next);
    setPreview(null);
    setSelected([]);
    setError('');
    setOperation(null);
  }

  function formData() {
    const form = new FormData();
    form.append('file', file!);
    if (inspection?.kind === 'map') {
      form.append('documentId', documentId);
    } else {
      form.append('sheet', sheet);
      form.append('nameColumn', columns.name);
      form.append('longitudeColumn', columns.longitude);
      form.append('latitudeColumn', columns.latitude);
      form.append('coordinateSystem', coordinateSystem);
    }
    return form;
  }

  async function showPreview() {
    const epoch = ++version.current;
    setOperation('preview');
    setError('');
    try {
      if (inspection?.kind === 'map') {
        const data: MapPreview = await upload('preview', formData());
        if (epoch !== version.current) return;
        setPreview({ kind: 'map', data });
        setSelected(data.entries.filter((entry) => entry.errors.length === 0).map((entry) => entry.entryId));
      } else {
        const data: TablePreview = await upload('preview', formData());
        if (epoch !== version.current) return;
        setPreview({ kind: 'table', data });
        setSelected(data.rows.filter((row) => row.errors.length === 0).map((row) => row.rowNumber));
      }
    } catch (failure) {
      if (epoch === version.current) setError(failure instanceof Error ? failure.message : '预览失败');
    } finally {
      if (epoch === version.current) setOperation(null);
    }
  }

  async function confirm() {
    const epoch = ++version.current;
    setOperation('confirm');
    setError('');
    try {
      const form = formData();
      form.append(preview?.kind === 'map' ? 'selectedEntries' : 'selectedRows', JSON.stringify(selected));
      const result: { points: Point[] } = await upload('confirm', form);
      if (epoch === version.current) onImported(result.points);
    } catch (failure) {
      if (epoch === version.current) setError(failure instanceof Error ? failure.message : '导入失败');
    } finally {
      if (epoch === version.current) setOperation(null);
    }
  }

  const ready = inspection?.kind === 'map'
    ? Boolean(documentId)
    : inspection?.kind === 'table' && Boolean(sheet) && new Set(Object.values(columns)).size === 3;
  const validIds: Selection[] = !preview ? [] : preview.kind === 'map'
    ? preview.data.entries.filter((entry) => !entry.errors.length).map((entry) => entry.entryId)
    : preview.data.rows.filter((row) => !row.errors.length).map((row) => row.rowNumber);
  const validCount = preview?.data.validCount ?? 0;
  const invalidCount = preview?.data.invalidCount ?? 0;

  return <Dialog title="导入项目点位" description="选择点位文件，预览后仅导入选中的有效点位。" wide onClose={() => !locked && onClose()}>
    <ol className="import-steps" aria-label="点位导入流程">
      <li className={preview ? 'complete' : 'active'} aria-current={!preview ? 'step' : undefined}><span className="import-step-number">{preview ? <Check /> : 1}</span><span>{isMap ? '选择文件与文档' : '选择文件与列'}</span></li>
      <li className="import-step-arrow" aria-hidden="true"><ArrowRight /></li>
      <li className={preview ? 'active' : ''} aria-current={preview ? 'step' : undefined}><span className="import-step-number">2</span><span>{isMap ? '预览并确认有效点位' : '预览并确认有效行'}</span></li>
    </ol>
    <div className="import-destination"><MapPin aria-hidden="true" /><div><strong>导入到当前项目点位库</strong><p>{targetRouteName ? `导入完成后，为“${targetRouteName}”继续选入点位。` : '导入后可供本项目的线路选用，不会自动加入任何线路。'}</p></div></div>
    <p className="helper" id="import-file-help">支持 .xlsx、UTF-8 CSV、KML 和 KMZ。表格需包含名称、经度和纬度；地图文件不超过 10 MiB。<a href="/api/import-template" download>下载标准模板</a></p>
    {error && <p className="message error" role="alert">{error}</p>}
    {!preview ? <>
      <label className="field file-field">
        选择点位文件<span className="file-pick-action" aria-hidden="true">选择文件</span>
        <Input type="file" accept=".xlsx,.csv,.kml,.kmz" aria-label="选择点位文件" aria-describedby="import-file-help import-selected-file" disabled={locked}
          onClick={() => { if (operation === 'preview') { version.current++; setOperation(null); } }}
          onChange={(event) => { const nextFile = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ''; void inspect(nextFile); }} />
        <span id="import-selected-file" className="import-document-path">{file ? `已选择：${file.name}` : '尚未选择文件'}</span>
      </label>
      {inspection?.kind === 'table' && inspection.sheets.length > 0 && <div className="import-mapping">
        <h3>核对列与坐标系</h3>
        <p className="helper">已根据表头匹配列，请确认对应关系。</p>
        <label className="field">工作表<NativeSelect aria-label="工作表" value={sheet} disabled={Boolean(operation)} onChange={(event) => { setSheet(event.target.value); setPreview(null); }}>{inspection.sheets.map((item) => <option key={item.name}>{item.name}</option>)}</NativeSelect></label>
        <div className="mapping-fields">{(['name', 'longitude', 'latitude'] as const).map((key) => <label className="field" key={key}>{key === 'name' ? '名称列' : key === 'longitude' ? '经度列' : '纬度列'}<NativeSelect aria-label={key === 'name' ? '名称列' : key === 'longitude' ? '经度列' : '纬度列'} value={columns[key]} disabled={Boolean(operation)} onChange={(event) => setColumns({ ...columns, [key]: event.target.value })}>{currentSheet?.headers.map((header, index) => <option value={String(index)} key={index}>{index + 1}. {header || '无表头'}</option>)}</NativeSelect></label>)}</div>
        <label className="field">原始坐标系<NativeSelect aria-label="原始坐标系" value={coordinateSystem} disabled={Boolean(operation)} onChange={(event) => setCoordinateSystem(event.target.value as CoordinateSystem)}><option value="GCJ-02">GCJ-02（高德，默认）</option><option value="WGS84">WGS84（GPS）</option></NativeSelect></label>
        <p className="helper">请选择表格实际使用的坐标系。WGS84 在确认导入时统一转换；转换失败不会写入半批数据。</p>
      </div>}
      {inspection?.kind === 'map' && <div className="import-map-details">
        <h3>核对地图文件</h3>
        {inspection.documents.length > 1
          ? <><label className="field">KML 文档<NativeSelect aria-label="KML 文档" aria-describedby="import-document-choice" value={documentId} disabled={locked} onChange={(event) => changeDocument(event.target.value)}><option value="">请选择要导入的文档</option>{inspection.documents.map((item) => <option value={item.documentId} key={item.documentId}>{item.path}</option>)}</NativeSelect></label>
            <p id="import-document-choice" className="helper import-document-path">{documentId ? `当前文档：${inspection.documents.find((item) => item.documentId === documentId)?.path}` : '请选择要读取的一个 KML 文档。'}</p>
            <details className="helper import-document-list"><summary>查看全部文档路径</summary><ul>{inspection.documents.map((item) => <li key={item.documentId}>{item.path}</li>)}</ul></details></>
          : inspection.format === 'kmz' && <p className="helper import-document-path">文档：{inspection.documents[0]?.path}</p>}
        <p className="helper">原始坐标固定为 WGS84；确认时转换为高德坐标，转换失败不会写入半批数据。</p>
        <p className="helper">只导入地标点，线、面、轨迹及网络链接不会导入。文件夹路径仅用于预览，高程、描述、样式及扩展属性均不会保存。</p>
        <p className="helper">导入将追加点位，不自动去重。KMZ 中所选 KML 解压后不能超过 20 MiB。</p>
      </div>}
    </> : <>
      <div className="preview-summary" aria-live="polite">
        <strong>{validCount} {preview.kind === 'map' ? '个点位' : '行'}有效</strong>
        <span>{invalidCount} {preview.kind === 'map' ? '个点位' : '行'}有误</span>
        <span>已选择 {selected.length} {preview.kind === 'map' ? '个点位' : '行'}</span>
      </div>
      {preview.kind === 'map' && preview.data.ignored.length > 0 && <p className="helper import-ignored">未导入：{preview.data.ignored.map((item) => `${item.kind} ${item.count} 项`).join('；')}。</p>}
      {preview.kind === 'map' && validCount === 0 && <p className="helper">没有可导入的有效点位，请检查下方错误或重新准备文件。</p>}
      <p className="helper import-preview-help">{preview.kind === 'map' ? '核对名称、坐标和来源，取消勾选不需要的点位；有误的点位不可选入。导入将追加点位，不自动去重。' : '核对名称与坐标，取消勾选不需要的行。有误的行不可选入，原始行号便于回到表格修正。'}</p>
      <div className="table-scroll import-preview"><Table><TableHeader><TableRow>
        <TableHead><Input aria-label={preview.kind === 'map' ? '选择全部有效点位' : '选择全部有效行'} type="checkbox" disabled={Boolean(operation) || validCount === 0} checked={selected.length === validCount && validCount > 0} onChange={(event) => setSelected(event.target.checked ? validIds : [])} /></TableHead>
        <TableHead>{preview.kind === 'map' ? '来源' : '原始行'}</TableHead><TableHead>名称</TableHead><TableHead>经度</TableHead><TableHead>纬度</TableHead><TableHead>校验</TableHead>
      </TableRow></TableHeader><TableBody>
        {(preview.kind === 'map' ? preview.data.entries : preview.data.rows).map((row, index) => {
          const id = 'entryId' in row ? row.entryId : row.rowNumber;
          const source = 'sourceLabel' in row ? row.sourceLabel : row.rowNumber;
          const label = 'entryId' in row ? `选择第 ${index + 1} 个点位` : `选择第 ${row.rowNumber} 行`;
          return <TableRow className={row.errors.length ? 'invalid-row' : ''} key={id}>
            <TableCell><Input type="checkbox" aria-label={label} disabled={row.errors.length > 0 || Boolean(operation)} checked={selected.includes(id)} onChange={(event) => setSelected(event.target.checked ? [...selected, id] : selected.filter((value) => value !== id))} /></TableCell>
            <TableCell className={preview.kind === 'map' ? 'import-source' : undefined}>{source}</TableCell><TableCell>{row.name || '—'}</TableCell><TableCell>{row.originalLongitude ?? '—'}</TableCell><TableCell>{row.originalLatitude ?? '—'}</TableCell><TableCell>{row.errors.length ? row.errors.join('；') : '有效'}</TableCell>
          </TableRow>;
        })}
      </TableBody></Table></div>
      <p className="helper">仅导入您明确选中的有效{preview.kind === 'map' ? '点位' : '行'}。点位将加入当前项目点位库，不会自动加入线路。</p>
    </>}
    <div className="dialog-actions">
      {preview ? <Button className="button" disabled={Boolean(operation)} onClick={() => { setPreview(null); setSelected([]); setError(''); }}>{preview.kind === 'map' ? '返回文件选择' : '返回列映射'}</Button> : <Button className="button" disabled={locked} onClick={onClose}>取消</Button>}
      {preview ? <Button className="button primary" disabled={Boolean(operation) || !selected.length} onClick={confirm}>{operation === 'confirm' ? '转换并导入中…' : `确认导入 ${selected.length} ${preview.kind === 'map' ? '个点位' : '行'}`}</Button> : <Button className="button primary" disabled={Boolean(operation) || !file || !ready} onClick={showPreview}>{operation ? '读取文件中…' : '预览并校验'}</Button>}
    </div>
  </Dialog>;
}
