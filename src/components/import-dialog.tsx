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
interface PreviewRow { rowNumber: number; name: string; originalLongitude?: number | string; originalLatitude?: number | string; errors: string[] }
interface Preview { rows: PreviewRow[]; validCount: number; invalidCount: number }

export default function ImportDialog({ projectId, targetRouteName, onClose, onImported }: { projectId: string; targetRouteName?: string; onClose: () => void; onImported: (points: Point[]) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheet, setSheet] = useState('');
  const [columns, setColumns] = useState({ name: '0', longitude: '1', latitude: '2' });
  const [coordinateSystem, setCoordinateSystem] = useState<CoordinateSystem>('GCJ-02');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  const currentSheet = sheets.find((item) => item.name === sheet);

  async function upload(path: string, form: FormData) {
    const response = await fetch(`/api/projects/${projectId}/import/${path}`, { method: 'POST', body: form });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? '导入失败，请检查文件。');
    return payload;
  }
  async function inspect(nextFile: File | null) {
    const epoch = ++version.current;
    setFile(nextFile); setSheets([]); setPreview(null); setSelected([]); setError('');
    if (!nextFile) return;
    setBusy(true);
    try {
      const form = new FormData(); form.append('file', nextFile);
      const result: { sheets: Sheet[] } = await upload('inspect', form);
      if (epoch !== version.current) return;
      setSheets(result.sheets); setSheet(result.sheets[0]?.name ?? '');
      const headers = result.sheets[0]?.headers ?? [];
      const find = (pattern: RegExp, fallback: number) => String(Math.max(0, headers.findIndex((header) => pattern.test(header)) < 0 ? fallback : headers.findIndex((header) => pattern.test(header))));
      setColumns({ name: find(/名称|name/i, 0), longitude: find(/经度|longitude|lng/i, 1), latitude: find(/纬度|latitude|lat/i, 2) });
    } catch (failure) { if (epoch === version.current) setError(failure instanceof Error ? failure.message : '读取文件失败'); }
    finally { if (epoch === version.current) setBusy(false); }
  }
  function formData() {
    const form = new FormData(); form.append('file', file!); form.append('sheet', sheet); form.append('nameColumn', columns.name); form.append('longitudeColumn', columns.longitude); form.append('latitudeColumn', columns.latitude); form.append('coordinateSystem', coordinateSystem); return form;
  }
  async function showPreview() {
    setBusy(true); setError('');
    const epoch = ++version.current;
    try { const result: Preview = await upload('preview', formData()); if (epoch !== version.current) return; setPreview(result); setSelected(result.rows.filter((row) => row.errors.length === 0).map((row) => row.rowNumber)); }
    catch (failure) { if (epoch === version.current) setError(failure instanceof Error ? failure.message : '预览失败'); }
    finally { if (epoch === version.current) setBusy(false); }
  }
  async function confirm() {
    setBusy(true); setError(''); const epoch = ++version.current;
    try { const form = formData(); form.append('selectedRows', JSON.stringify(selected)); const result: { points: Point[] } = await upload('confirm', form); if (epoch === version.current) onImported(result.points); }
    catch (failure) { if (epoch === version.current) setError(failure instanceof Error ? failure.message : '导入失败'); }
    finally { if (epoch === version.current) setBusy(false); }
  }

  return <Dialog title="导入项目点位" description="选择坐标表格，核对列与坐标系，预览后仅导入选中的有效行。" wide onClose={() => !busy && onClose()}>
    <ol className="import-steps" aria-label="点位导入流程">
      <li className={preview ? 'complete' : 'active'} aria-current={!preview ? 'step' : undefined}><span className="import-step-number">{preview ? <Check /> : 1}</span><span>选择文件与列</span></li>
      <li className="import-step-arrow" aria-hidden="true"><ArrowRight /></li>
      <li className={preview ? 'active' : ''} aria-current={preview ? 'step' : undefined}><span className="import-step-number">2</span><span>预览并确认有效行</span></li>
    </ol>
    <div className="import-destination"><MapPin aria-hidden="true" /><div><strong>导入到当前项目点位库</strong><p>{targetRouteName ? `导入完成后，为“${targetRouteName}”继续选入点位。` : '导入后可供本项目的线路选用，不会自动加入任何线路。'}</p></div></div>
    <p className="helper" id="import-file-help">支持 .xlsx 与 UTF-8 CSV，表格需包含名称、经度、纬度。仅有地址的表格无法导入。<a href="/api/import-template" download>下载标准模板</a></p>{error && <p className="message error" role="alert">{error}</p>}
    {!preview ? <><label className="field file-field">选择点位表格<Input type="file" accept=".xlsx,.csv" aria-describedby="import-file-help" disabled={busy} onChange={(event) => inspect(event.target.files?.[0] ?? null)} /></label>{sheets.length > 0 && <div className="import-mapping"><h3>核对列与坐标系</h3><p className="helper">已根据表头匹配列，请确认对应关系。</p><label className="field">工作表<NativeSelect aria-label="工作表" value={sheet} disabled={busy} onChange={(event) => { setSheet(event.target.value); setPreview(null); }}>{sheets.map((item) => <option key={item.name}>{item.name}</option>)}</NativeSelect></label><div className="mapping-fields">{(['name', 'longitude', 'latitude'] as const).map((key) => <label className="field" key={key}>{key === 'name' ? '名称列' : key === 'longitude' ? '经度列' : '纬度列'}<NativeSelect aria-label={key === 'name' ? '名称列' : key === 'longitude' ? '经度列' : '纬度列'} value={columns[key]} disabled={busy} onChange={(event) => setColumns({ ...columns, [key]: event.target.value })}>{currentSheet?.headers.map((header, index) => <option value={String(index)} key={index}>{index + 1}. {header || '无表头'}</option>)}</NativeSelect></label>)}</div><label className="field">原始坐标系<NativeSelect aria-label="原始坐标系" value={coordinateSystem} disabled={busy} onChange={(event) => setCoordinateSystem(event.target.value as CoordinateSystem)}><option value="GCJ-02">GCJ-02（高德，默认）</option><option value="WGS84">WGS84（GPS）</option></NativeSelect></label><p className="helper">请选择表格实际使用的坐标系。WGS84 在确认导入时统一转换；转换失败不会写入半批数据。</p></div>}</> : <><div className="preview-summary" aria-live="polite"><strong>{preview.validCount} 行有效</strong><span>{preview.invalidCount} 行有误</span><span>已选择 {selected.length} 行</span></div><p className="helper import-preview-help">核对名称与坐标，取消勾选不需要的行。有误的行不可选入，原始行号便于回到表格修正。</p><div className="table-scroll import-preview"><Table><TableHeader><TableRow><TableHead><Input aria-label="选择全部有效行" type="checkbox" disabled={busy} checked={selected.length === preview.validCount && preview.validCount > 0} onChange={(event) => setSelected(event.target.checked ? preview.rows.filter((row) => !row.errors.length).map((row) => row.rowNumber) : [])} /></TableHead><TableHead>原始行</TableHead><TableHead>名称</TableHead><TableHead>经度</TableHead><TableHead>纬度</TableHead><TableHead>校验</TableHead></TableRow></TableHeader><TableBody>{preview.rows.map((row) => <TableRow className={row.errors.length ? 'invalid-row' : ''} key={row.rowNumber}><TableCell><Input type="checkbox" aria-label={`选择第 ${row.rowNumber} 行`} disabled={row.errors.length > 0 || busy} checked={selected.includes(row.rowNumber)} onChange={(event) => setSelected(event.target.checked ? [...selected, row.rowNumber] : selected.filter((value) => value !== row.rowNumber))} /></TableCell><TableCell>{row.rowNumber}</TableCell><TableCell>{row.name || '—'}</TableCell><TableCell>{row.originalLongitude ?? '—'}</TableCell><TableCell>{row.originalLatitude ?? '—'}</TableCell><TableCell>{row.errors.length ? row.errors.join('；') : '有效'}</TableCell></TableRow>)}</TableBody></Table></div><p className="helper">仅导入您明确选中的有效行。点位将加入当前项目点位库，不会自动加入线路。</p></>}
    <div className="dialog-actions">{preview ? <Button className="button" disabled={busy} onClick={() => setPreview(null)}>返回列映射</Button> : <Button className="button" disabled={busy} onClick={onClose}>取消</Button>}{preview ? <Button className="button primary" disabled={busy || !selected.length} onClick={confirm}>{busy ? '转换并导入中…' : `确认导入 ${selected.length} 行`}</Button> : <Button className="button primary" disabled={busy || !file || !sheets.length || new Set(Object.values(columns)).size < 3} onClick={showPreview}>{busy ? '读取文件中…' : '预览并校验'}</Button>}</div>
  </Dialog>;
}
