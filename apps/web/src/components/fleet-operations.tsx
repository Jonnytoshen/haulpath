'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  emptyFleetOperations,
  fleetOperationsReadiness,
  measuredSegmentIssue,
  vehicleGroupIssue,
  type FleetOperationsInput,
  type MeasuredSegmentInput,
  type PlanningScenario,
  type TransportCycle,
  type VehicleGroupInput,
} from '@haulpath/domain';
import { Dialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { request } from '@/lib/client-request';
import styles from './fleet-operations.module.css';

type NumericGroupField =
  | 'payloadTonnes'
  | 'speedKph'
  | 'emptyKwhPerKm'
  | 'fullKwhPerKm'
  | 'safetySocPercent'
  | 'loadingMinutes'
  | 'unloadingMinutes';
type DraftGroup = Omit<VehicleGroupInput, NumericGroupField | 'count' | 'shifts'> &
  Record<NumericGroupField | 'count' | 'shifts', string> & { key: string };
type DraftMeasured = Omit<MeasuredSegmentInput, 'durationMinutes' | 'emptyKwh' | 'fullKwh'> & {
  key: string;
  durationMinutes: string;
  emptyKwh: string;
  fullKwh: string;
};
type DraftBattery = {
  capacityKwh: string;
  chargePowerKw: string;
  chargeEfficiency: string;
  source: string;
};
type Editor = {
  revision: number;
  battery: DraftBattery;
  groups: DraftGroup[];
  measured: DraftMeasured[];
  baseline: string;
};
type PreviewRow<T> = { line: number; text: string; row: T | null; error: string | null };
const groupFields: { field: NumericGroupField; label: string; unit: string }[] = [
  { field: 'payloadTonnes', label: '载重', unit: '吨' },
  { field: 'speedKph', label: '业务速度', unit: 'km/h' },
  { field: 'emptyKwhPerKm', label: '空载能耗', unit: 'kWh/km' },
  { field: 'fullKwhPerKm', label: '满载能耗', unit: 'kWh/km' },
  { field: 'safetySocPercent', label: '安全电量', unit: '%' },
  { field: 'loadingMinutes', label: '装货耗时', unit: '分钟/次' },
  { field: 'unloadingMinutes', label: '卸货耗时', unit: '分钟/次' },
];
const textOf = (value: number | null | undefined) => (value == null ? '' : String(value));
const display = (value: number | null | undefined) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 15 }).format(value);
const messageOf = (failure: unknown) =>
  failure instanceof Error ? failure.message : '保存失败，请重试。';
const clock = (minute: number) =>
  `${minute >= 1440 ? '次日' : ''}${String(Math.floor((minute % 1440) / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const positionLabel = (cycle: TransportCycle | undefined, id: string) => {
  const index = cycle?.positions.findIndex((position) => position.id === id) ?? -1;
  return index >= 0 && cycle ? `${index + 1} · ${cycle.positions[index].point.name}` : '位置已失效';
};
function numeric(
  value: string,
  label: string,
  { zero = false, max = Infinity }: { zero?: boolean; max?: number } = {},
): number | null {
  if (!value.trim()) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || (zero ? result < 0 : result <= 0) || result > max)
    throw new Error(
      `${label}须为${zero ? '不小于 0' : '大于 0'}${max < Infinity ? `、不超过 ${max}` : ''}的有限数值`,
    );
  return result;
}
function shiftsOf(value: string) {
  if (!value.trim()) return [];
  return value.split(/[;；]/).map((part) => {
    const match = part.trim().match(/^(\d{1,2}):(\d{2})\s*[-–—]\s*(次日)?(\d{1,2}):(\d{2})$/);
    if (!match) throw new Error('班次格式为 06:00-18:00；跨午夜请写 22:00-次日02:00');
    const [, sh, sm, next, eh, em] = match;
    if (Number(sh) > 23 || Number(eh) > 23 || Number(sm) > 59 || Number(em) > 59)
      throw new Error('班次时刻须在 00:00–23:59 内');
    const startMinute = Number(sh) * 60 + Number(sm);
    const endMinute = Number(eh) * 60 + Number(em) + (next ? 1440 : 0);
    if (endMinute <= startMinute || endMinute - startMinute > 1440)
      throw new Error('班次结束须晚于开始，且单班不超过 24 小时');
    return { startMinute, endMinute };
  });
}
function groupInput(row: DraftGroup): VehicleGroupInput {
  if (!row.name.trim()) throw new Error('请填写车型名称');
  const count = Number(row.count);
  if (!row.count.trim() || !Number.isSafeInteger(count) || count < 0 || count > 10000)
    throw new Error('当日数量上限须为 0–10000 的整数');
  const shifts = shiftsOf(row.shifts);
  const emptyKwhPerKm = numeric(row.emptyKwhPerKm, '空载能耗', { zero: true });
  const fullKwhPerKm = numeric(row.fullKwhPerKm, '满载能耗', { zero: true });
  if (emptyKwhPerKm !== null && fullKwhPerKm !== null && fullKwhPerKm < emptyKwhPerKm)
    throw new Error('满载能耗不能低于空载能耗');
  for (let i = 0; i < shifts.length; i++) {
    for (let j = 0; j < i; j++) {
      if (
        [-1440, 0, 1440].some(
          (offset) =>
            shifts[i].startMinute < shifts[j].endMinute + offset &&
            shifts[i].endMinute > shifts[j].startMinute + offset,
        )
      )
        throw new Error('班次作业窗口不能重叠，包括跨日重复部分');
    }
  }
  return {
    ...(row.id ? { id: row.id } : {}),
    ...(row.refreshBase ? { refreshBase: true } : {}),
    name: row.name.trim(),
    count,
    baseCycleId: row.baseCycleId,
    baseStartPositionId: row.baseStartPositionId,
    payloadTonnes: numeric(row.payloadTonnes, '载重'),
    speedKph: numeric(row.speedKph, '业务速度'),
    emptyKwhPerKm,
    fullKwhPerKm,
    safetySocPercent: numeric(row.safetySocPercent, '安全电量', { zero: true, max: 100 }),
    loadingMinutes: numeric(row.loadingMinutes, '装货耗时', { zero: true }),
    unloadingMinutes: numeric(row.unloadingMinutes, '卸货耗时', { zero: true }),
    shifts,
    source: row.source.trim(),
  };
}
function measuredInput(row: DraftMeasured): MeasuredSegmentInput {
  if (!row.vehicleGroupId || !row.cycleId || !row.fromPositionId || !row.toPositionId)
    throw new Error('请选择车辆组、循环与有向区间');
  const durationMinutes = numeric(row.durationMinutes, '实测行驶时间');
  const emptyKwh = numeric(row.emptyKwh, '实测空载耗电', { zero: true });
  const fullKwh = numeric(row.fullKwh, '实测满载耗电', { zero: true });
  if ((emptyKwh === null) !== (fullKwh === null)) throw new Error('实测空载与满载耗电须成对填写');
  if (emptyKwh !== null && fullKwh !== null && fullKwh < emptyKwh)
    throw new Error('实测满载耗电不能低于空载耗电');
  if (durationMinutes === null && emptyKwh === null)
    throw new Error('实测至少填写行驶时间或空满载耗电');
  if (!row.source.trim()) throw new Error('请填写实测来源说明');
  return {
    ...(row.id ? { id: row.id } : {}),
    ...(row.refreshBasis ? { refreshBasis: true } : {}),
    vehicleGroupId: row.vehicleGroupId,
    cycleId: row.cycleId,
    fromPositionId: row.fromPositionId,
    toPositionId: row.toPositionId,
    durationMinutes,
    emptyKwh,
    fullKwh,
    source: row.source.trim(),
  };
}
function validateMeasuredDuplicates(rows: DraftMeasured[]) {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.vehicleGroupId,
      row.cycleId,
      row.fromPositionId,
      row.toPositionId,
    ]);
    if (seen.has(key)) throw new Error('同一车辆组的同一有向区间实测不能重复');
    seen.add(key);
  }
}
function newGroup(): DraftGroup {
  return {
    key: crypto.randomUUID(),
    name: '',
    count: '',
    baseCycleId: null,
    baseStartPositionId: null,
    payloadTonnes: '',
    speedKph: '',
    emptyKwhPerKm: '',
    fullKwhPerKm: '',
    safetySocPercent: '',
    shifts: '',
    loadingMinutes: '',
    unloadingMinutes: '',
    source: '',
  };
}
function parseLines<T>(text: string, parse: (columns: string[]) => T): PreviewRow<T>[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  if (!lines.length) throw new Error('请先粘贴资料');
  return lines.map((line, index) => {
    try {
      return {
        line: index + 1,
        text: line,
        row: parse(line.split('\t').map((part) => part.trim())),
        error: null,
      };
    } catch (failure) {
      return { line: index + 1, text: line, row: null, error: messageOf(failure) };
    }
  });
}
function PastePreview<T>({ rows, caption }: { rows: PreviewRow<T>[]; caption: string }) {
  return (
    <>
      {rows.some((row) => row.error) && (
        <div className={styles.warning} role="alert">
          {rows
            .filter((row) => row.error)
            .map((row) => (
              <p key={row.line}>
                第 {row.line} 行：{row.error}
              </p>
            ))}
          <p>本批尚未加入资料，请修正后重新校验。</p>
        </div>
      )}
      <div className={styles.tableWrap}>
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th className={styles.number}>行号</th>
              <th>粘贴内容</th>
              <th>校验结果</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.line}>
                <td className={styles.number}>{row.line}</td>
                <td className={styles.source}>{row.text}</td>
                <td>{row.error ?? '有效'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function FleetOperations({
  scenario,
  disabled,
  onChange,
  onWritingChange,
  onEditingChange,
}: {
  scenario: PlanningScenario;
  disabled: boolean;
  onChange: (scenario: PlanningScenario) => void;
  onWritingChange: (writing: boolean) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const operations = scenario.context.operations ?? emptyFleetOperations();
  const cycles = scenario.context.transportCycles ?? [];
  const gaps = fleetOperationsReadiness(scenario.context);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [groupPaste, setGroupPaste] = useState('');
  const [measuredPaste, setMeasuredPaste] = useState('');
  const [groupPreview, setGroupPreview] = useState<PreviewRow<DraftGroup>[] | null>(null);
  const [measuredPreview, setMeasuredPreview] = useState<PreviewRow<DraftMeasured>[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const alive = useRef(true);
  const writing = useRef(false);
  const editorOpen = editor !== null;
  useEffect(() => {
    onEditingChange?.(editorOpen);
    return () => onEditingChange?.(false);
  }, [editorOpen, onEditingChange]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const draft = editor
    ? JSON.stringify({ battery: editor.battery, groups: editor.groups, measured: editor.measured })
    : '';
  const dirty = editor && (draft !== editor.baseline || groupPaste.trim() || measuredPaste.trim());
  function openEditor() {
    const battery = {
      capacityKwh: textOf(operations.battery?.capacityKwh),
      chargePowerKw: textOf(operations.battery?.chargePowerKw),
      chargeEfficiency: textOf(operations.battery?.chargeEfficiency),
      source: operations.battery?.source ?? '',
    };
    const groups = operations.vehicleGroups.map((group): DraftGroup => ({
      id: group.id,
      key: group.id,
      name: group.name,
      count: String(group.count),
      baseCycleId: group.baseCycleId,
      baseStartPositionId: group.baseStartPositionId,
      payloadTonnes: textOf(group.payloadTonnes),
      speedKph: textOf(group.speedKph),
      emptyKwhPerKm: textOf(group.emptyKwhPerKm),
      fullKwhPerKm: textOf(group.fullKwhPerKm),
      safetySocPercent: textOf(group.safetySocPercent),
      loadingMinutes: textOf(group.loadingMinutes),
      unloadingMinutes: textOf(group.unloadingMinutes),
      source: group.source,
      shifts: group.shifts
        .map((shift) => `${clock(shift.startMinute)}-${clock(shift.endMinute)}`)
        .join(';'),
    }));
    const measured = operations.measuredSegments.map((item): DraftMeasured => ({
      id: item.id,
      key: item.id,
      vehicleGroupId: item.vehicleGroupId,
      cycleId: item.cycleId,
      fromPositionId: item.fromPositionId,
      toPositionId: item.toPositionId,
      durationMinutes: textOf(item.durationMinutes),
      emptyKwh: textOf(item.emptyKwh),
      fullKwh: textOf(item.fullKwh),
      source: item.source,
    }));
    setEditor({
      revision: scenario.revision,
      battery,
      groups,
      measured,
      baseline: JSON.stringify({ battery, groups, measured }),
    });
    setGroupPaste('');
    setMeasuredPaste('');
    setGroupPreview(null);
    setMeasuredPreview(null);
    setDiscarding(false);
    setError('');
    setNotice('');
  }
  function closeEditor() {
    if (writing.current) return;
    if (dirty) {
      setDiscarding(true);
      return;
    }
    setEditor(null);
    setError('');
  }
  function updateGroup(key: string, changes: Partial<DraftGroup>) {
    if (!editor) return;
    setEditor({
      ...editor,
      groups: editor.groups.map((row) => (row.key === key ? { ...row, ...changes } : row)),
    });
    setError('');
    setMeasuredPreview(null);
  }
  function updateMeasured(key: string, changes: Partial<DraftMeasured>) {
    if (!editor) return;
    setEditor({
      ...editor,
      measured: editor.measured.map((row) => (row.key === key ? { ...row, ...changes } : row)),
    });
    setError('');
    setMeasuredPreview(null);
  }
  function previewGroups() {
    try {
      const rows = parseLines(groupPaste, (columns) => {
        if (columns.length !== 12) throw new Error('需要 12 列，以制表符分隔');
        const [
          name,
          count,
          cycleNumber,
          payloadTonnes,
          speedKph,
          emptyKwhPerKm,
          fullKwhPerKm,
          safetySocPercent,
          shifts,
          loadingMinutes,
          unloadingMinutes,
          source,
        ] = columns;
        const cycle = cycleNumber ? cycles[Number(cycleNumber) - 1] : undefined;
        if (cycleNumber && (!/^\d+$/.test(cycleNumber) || !cycle?.positions[0]))
          throw new Error('基准循环序号无效');
        const row = {
          ...newGroup(),
          name,
          count,
          baseCycleId: cycle?.id ?? null,
          baseStartPositionId: cycle?.positions[0]?.id ?? null,
          payloadTonnes,
          speedKph,
          emptyKwhPerKm,
          fullKwhPerKm,
          safetySocPercent,
          shifts,
          loadingMinutes,
          unloadingMinutes,
          source,
        };
        groupInput(row);
        return row;
      });
      setGroupPreview(rows);
      setError('');
    } catch (failure) {
      setError(messageOf(failure));
    }
  }
  function previewMeasured() {
    if (!editor) return;
    try {
      const rows = parseLines(measuredPaste, (columns) => {
        if (columns.length !== 8) throw new Error('需要 8 列，以制表符分隔');
        const [
          groupNumber,
          cycleNumber,
          fromNumber,
          toNumber,
          durationMinutes,
          emptyKwh,
          fullKwh,
          source,
        ] = columns;
        const group = editor.groups[Number(groupNumber) - 1];
        const cycle = cycles[Number(cycleNumber) - 1];
        const from = cycle?.positions[Number(fromNumber) - 1];
        const to = cycle?.positions[Number(toNumber) - 1];
        if (
          ![groupNumber, cycleNumber, fromNumber, toNumber].every((value) => /^\d+$/.test(value)) ||
          !group?.id ||
          !cycle ||
          !from ||
          !to ||
          Number(toNumber) !== Number(fromNumber) + 1
        )
          throw new Error('请使用已保存车辆组、当前循环及有向相邻位置的序号');
        const row: DraftMeasured = {
          key: crypto.randomUUID(),
          vehicleGroupId: group.id,
          cycleId: cycle.id,
          fromPositionId: from.id,
          toPositionId: to.id,
          durationMinutes,
          emptyKwh,
          fullKwh,
          source,
        };
        measuredInput(row);
        return row;
      });
      const valid = rows.flatMap((row) => (row.row ? [row.row] : []));
      validateMeasuredDuplicates([...editor.measured, ...valid]);
      setMeasuredPreview(rows);
      setError('');
    } catch (failure) {
      setMeasuredPreview(null);
      setError(messageOf(failure));
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || writing.current) return;
    let input: FleetOperationsInput;
    try {
      if (groupPaste.trim() || measuredPaste.trim())
        throw new Error('粘贴内容尚未加入草稿，请先校验并加入，或清空粘贴框');
      const battery = editor.battery;
      input = {
        battery: Object.values(battery).some((value) => value.trim())
          ? {
              capacityKwh: numeric(battery.capacityKwh, '电池容量'),
              chargePowerKw: numeric(battery.chargePowerKw, '等效充电功率'),
              chargeEfficiency: numeric(battery.chargeEfficiency, '充电效率', { max: 1 }),
              source: battery.source.trim(),
            }
          : null,
        vehicleGroups: editor.groups.map((row, index) => {
          try {
            return groupInput(row);
          } catch (failure) {
            throw new Error(`车辆组 ${index + 1}：${messageOf(failure)}`);
          }
        }),
        measuredSegments: editor.measured.map((row, index) => {
          try {
            return measuredInput(row);
          } catch (failure) {
            throw new Error(`实测 ${index + 1}：${messageOf(failure)}`);
          }
        }),
      };
      validateMeasuredDuplicates(editor.measured);
    } catch (failure) {
      setError(messageOf(failure));
      return;
    }
    writing.current = true;
    setBusy(true);
    onWritingChange(true);
    setError('');
    try {
      const saved = await request<PlanningScenario>(
        `/api/projects/${encodeURIComponent(scenario.projectId)}/scenarios/${encodeURIComponent(scenario.id)}/operations`,
        'PUT',
        { expectedRevision: editor.revision, operations: input },
      );
      if (!alive.current) return;
      onChange(saved);
      setEditor(null);
      setNotice('车辆与运营资料已保存');
    } catch (failure) {
      if (alive.current)
        setError(
          `${messageOf(failure)} 本次填写已保留；修订冲突时请复制需保留的内容，关闭后刷新方案再核对保存。`,
        );
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className={styles.section} aria-label="方案车辆与运营模板">
      <header className={styles.heading}>
        <div>
          <h3>车辆与运营模板</h3>
          <p>给定车队数量、统一电池与班次，保留模板和区间实测依据。</p>
        </div>
        <Button className="button" disabled={disabled || busy} onClick={openEditor}>
          <Pencil aria-hidden="true" />
          维护车辆与运营模板
        </Button>
      </header>
      {notice && !editor && (
        <p className={styles.notice} role="status">
          <Check aria-hidden="true" />
          {notice}
        </p>
      )}
      <p className={styles.summary}>
        {operations.vehicleGroups.length} 个车辆组 · 当日数量上限合计{' '}
        {display(operations.vehicleGroups.reduce((sum, group) => sum + group.count, 0))} 辆
      </p>
      <dl className={styles.batterySummary} aria-label="统一电池规格">
        <div>
          <dt>电池容量</dt>
          <dd>
            {display(operations.battery?.capacityKwh)} <small>kWh</small>
          </dd>
        </div>
        <div>
          <dt>等效充电功率</dt>
          <dd>
            {display(operations.battery?.chargePowerKw)} <small>kW</small>
          </dd>
        </div>
        <div>
          <dt>充电效率</dt>
          <dd>{display(operations.battery?.chargeEfficiency)}</dd>
        </div>
      </dl>
      {operations.battery?.source && (
        <p className={styles.helper}>电池参数来源：{operations.battery.source}</p>
      )}
      {!operations.vehicleGroups.length ? (
        <p className={styles.empty}>
          尚未配置车辆组。填写实际可用数量与参数，空白参数保留为待补资料。
        </p>
      ) : (
        <ul className={styles.groups} aria-label="已保存车辆组">
          {operations.vehicleGroups.map((group) => {
            const cycle = cycles.find((item) => item.id === group.baseCycleId);
            const issue = vehicleGroupIssue(group, cycles);
            return (
              <li key={group.id}>
                <div className={styles.rowHeading}>
                  <strong>{group.name}</strong>
                  <span className={styles.number}>{display(group.count)} 辆</span>
                </div>
                <p>
                  基准起点：
                  {cycle
                    ? `${cycle.name} · ${positionLabel(cycle, group.baseStartPositionId ?? '')}`
                    : group.baseCycleId
                      ? '循环已删除'
                      : '待配置'}
                </p>
                <p>
                  载重 {display(group.payloadTonnes)} 吨 · 速度 {display(group.speedKph)} km/h ·
                  安全电量 {display(group.safetySocPercent)}%
                </p>
                <p>
                  班次：
                  {group.shifts.length
                    ? group.shifts
                        .map((shift) => `${clock(shift.startMinute)}–${clock(shift.endMinute)}`)
                        .join('；')
                    : '待配置'}
                </p>
                {issue && <p className={styles.gap}>需修复：{issue}</p>}
                <details>
                  <summary>模板参数与计划车辆编号</summary>
                  <p>
                    空载 / 满载能耗：{display(group.emptyKwhPerKm)} / {display(group.fullKwhPerKm)}{' '}
                    kWh/km
                  </p>
                  <p>
                    装货 / 卸货耗时：{display(group.loadingMinutes)} /{' '}
                    {display(group.unloadingMinutes)} 分钟/次
                  </p>
                  <p>参数来源：{group.source || '待填写'}</p>
                  <ul className={styles.ids} aria-label={`${group.name} 计划车辆编号`}>
                    {group.vehicleIds.slice(0, group.count).map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                  {group.count === 0 && <p>当日没有可用计划车辆。</p>}
                </details>
              </li>
            );
          })}
        </ul>
      )}
      <div className={styles.measuredSummary}>
        <h4>区间实测覆盖</h4>
        <p className={styles.helper}>
          {operations.measuredSegments.length}{' '}
          条实测。实测按车辆组、有向区间和资料依据关联；有效实测覆盖对应模板。
        </p>
        {operations.measuredSegments.length > 0 && (
          <ul className={styles.groups} aria-label="已保存区间实测">
            {operations.measuredSegments.map((item) => {
              const cycle = cycles.find((candidate) => candidate.id === item.cycleId);
              const group = operations.vehicleGroups.find(
                (candidate) => candidate.id === item.vehicleGroupId,
              );
              const issue = measuredSegmentIssue(item, operations, cycles);
              return (
                <li key={item.id}>
                  <strong>
                    {group?.name ?? '车辆组已删除'} · {cycle?.name ?? '循环已删除'}
                  </strong>
                  <p>
                    {positionLabel(cycle, item.fromPositionId)} →{' '}
                    {positionLabel(cycle, item.toPositionId)}
                  </p>
                  <p>
                    行驶时间 {display(item.durationMinutes)} 分钟 · 空载 / 满载耗电{' '}
                    {display(item.emptyKwh)} / {display(item.fullKwh)} kWh
                  </p>
                  <p>来源：{item.source}</p>
                  {issue && <p className={styles.gap}>已失效：{issue}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {gaps.length > 0 && (
        <details className={styles.readiness}>
          <summary>待补或待修复资料（{gaps.length} 项）</summary>
          <ul>
            {gaps.map((gap, index) => (
              <li key={`${index}-${gap}`}>{gap}</li>
            ))}
          </ul>
        </details>
      )}
      <p className={styles.boundary}>
        车辆从基准循环起点出发并收车，数量不自动增加。这里保存后续计算输入；逐车计划、跨线接续与周期可行性由后续工单校核。
      </p>
      {editor && (
        <Dialog title="维护车辆与运营模板" wide error={error} onClose={closeEditor}>
          <form onSubmit={save} noValidate>
            <p className={styles.helper}>
              空白数值保存为待补资料，不自动套用工程参数。所有修改在保存时整批校验。
            </p>
            {discarding && (
              <div className={styles.warning} role="alert">
                <p>尚有未保存的运营资料，关闭将丢弃本次修改。</p>
                <div className={styles.actions}>
                  <Button className="button" onClick={() => setDiscarding(false)}>
                    继续编辑
                  </Button>
                  <Button
                    className="text-button danger-text"
                    onClick={() => {
                      setEditor(null);
                      setError('');
                    }}
                  >
                    放弃修改
                  </Button>
                </div>
              </div>
            )}
            <fieldset className={styles.editorFields} disabled={busy || discarding}>
              <section className={styles.editorSection} aria-label="编辑统一电池">
                <h4>统一电池规格</h4>
                <div className={styles.fieldGrid}>
                  {(
                    [
                      ['capacityKwh', '电池容量（kWh）'],
                      ['chargePowerKw', '等效充电功率（kW）'],
                      ['chargeEfficiency', '充电效率（0–1）'],
                    ] as const
                  ).map(([field, label]) => (
                    <label className="field" key={field}>
                      {label}
                      <Input
                        aria-label={label}
                        inputMode="decimal"
                        value={editor.battery[field]}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            battery: { ...editor.battery, [field]: event.target.value },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <label className="field">
                  电池参数来源
                  <Input
                    aria-label="电池参数来源"
                    value={editor.battery.source}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        battery: { ...editor.battery, source: event.target.value },
                      })
                    }
                  />
                </label>
              </section>
              <section className={styles.editorSection} aria-label="编辑车辆组">
                <div className={styles.rowHeading}>
                  <h4>车辆组与运营模板</h4>
                  <Button
                    className="button"
                    onClick={() => setEditor({ ...editor, groups: [...editor.groups, newGroup()] })}
                  >
                    <Plus aria-hidden="true" />
                    新增车辆组
                  </Button>
                </div>
                <ol className={styles.editorRows} aria-label="车辆组草稿">
                  {editor.groups.map((row, index) => {
                    const cycle = cycles.find((item) => item.id === row.baseCycleId);
                    const saved = operations.vehicleGroups.find((item) => item.id === row.id);
                    const issue = saved && vehicleGroupIssue(saved, cycles);
                    return (
                      <li key={row.key}>
                        <div className={styles.rowHeading}>
                          <h5>
                            车辆组 {index + 1}
                            {row.name ? ` · ${row.name}` : ''}
                          </h5>
                          <Button
                            className="text-button danger-text"
                            aria-label={`删除车辆组 ${index + 1}`}
                            onClick={() => {
                              setEditor({
                                ...editor,
                                groups: editor.groups.filter((item) => item.key !== row.key),
                              });
                              setMeasuredPreview(null);
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                            删除
                          </Button>
                        </div>
                        <div className={styles.fieldGrid}>
                          <label className="field">
                            车型名称
                            <Input
                              aria-label={`车辆组 ${index + 1} 车型名称`}
                              value={row.name}
                              onChange={(event) =>
                                updateGroup(row.key, { name: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            当日数量上限（辆）
                            <Input
                              aria-label={`车辆组 ${index + 1} 当日数量上限`}
                              inputMode="numeric"
                              value={row.count}
                              onChange={(event) =>
                                updateGroup(row.key, { count: event.target.value })
                              }
                            />
                          </label>
                          <label className="field">
                            基准循环
                            <NativeSelect
                              aria-label={`车辆组 ${index + 1} 基准循环`}
                              value={row.baseCycleId ?? ''}
                              onChange={(event) => {
                                const target = cycles.find(
                                  (item) => item.id === event.target.value,
                                );
                                updateGroup(row.key, {
                                  baseCycleId: target?.id ?? null,
                                  baseStartPositionId: target?.positions[0]?.id ?? null,
                                  refreshBase: true,
                                });
                              }}
                            >
                              <option value="">待配置</option>
                              {row.baseCycleId && !cycle && (
                                <option value={row.baseCycleId}>循环已删除，请修复</option>
                              )}
                              {cycles.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name} · {item.positions[0]?.point.name ?? '无起点'}
                                </option>
                              ))}
                            </NativeSelect>
                          </label>
                          {groupFields.map(({ field, label, unit }) => (
                            <label className="field" key={field}>
                              {label}（{unit}）
                              <Input
                                aria-label={`车辆组 ${index + 1} ${label}`}
                                inputMode="decimal"
                                value={row[field]}
                                onChange={(event) =>
                                  updateGroup(row.key, { [field]: event.target.value })
                                }
                              />
                            </label>
                          ))}
                        </div>
                        <label className="field">
                          班次作业窗口
                          <Input
                            aria-label={`车辆组 ${index + 1} 班次`}
                            aria-describedby={`shift-help-${row.key}`}
                            value={row.shifts}
                            onChange={(event) =>
                              updateGroup(row.key, { shifts: event.target.value })
                            }
                          />
                        </label>
                        <p className={styles.helper} id={`shift-help-${row.key}`}>
                          格式：06:00-18:00；多个班次用分号分隔，跨午夜写 22:00-次日02:00。
                        </p>
                        <label className="field">
                          参数来源
                          <Input
                            aria-label={`车辆组 ${index + 1} 参数来源`}
                            value={row.source}
                            onChange={(event) =>
                              updateGroup(row.key, { source: event.target.value })
                            }
                          />
                        </label>
                        {issue && (
                          <div className={styles.warning}>
                            <p>{issue}</p>
                            {cycle?.positions[0] && (
                              <label className={styles.confirm}>
                                <input
                                  type="checkbox"
                                  aria-label={`车辆组 ${index + 1} 重新确认基准起点`}
                                  checked={!!row.refreshBase}
                                  onChange={(event) =>
                                    updateGroup(row.key, {
                                      baseStartPositionId: event.target.checked
                                        ? cycle.positions[0].id
                                        : (saved?.baseStartPositionId ?? null),
                                      refreshBase: event.target.checked,
                                    })
                                  }
                                />
                                重新确认基准起点
                              </label>
                            )}
                          </div>
                        )}
                        {row.refreshBase && (
                          <p className={styles.helper}>保存后以当前循环起点作为出发、收车位置。</p>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <details className={styles.paste}>
                  <summary>批量粘贴车辆组</summary>
                  <p className={styles.helper}>
                    从表格复制 12
                    列，不含表头：车型名称、当日数量上限、基准循环序号、载重、业务速度、空载能耗、满载能耗、安全电量%、班次、装货分钟、卸货分钟、参数来源。制表符分列，空白参数留空；班次格式同上。
                  </p>
                  <p className={styles.helper}>
                    循环序号：
                    {cycles.length
                      ? cycles.map((cycle, index) => `${index + 1} · ${cycle.name}`).join('；')
                      : '暂无循环，可留空'}
                  </p>
                  <label className="field">
                    批量车辆组
                    <textarea
                      aria-label="批量车辆组"
                      rows={4}
                      value={groupPaste}
                      onChange={(event) => {
                        setGroupPaste(event.target.value);
                        setGroupPreview(null);
                      }}
                    />
                  </label>
                  <Button className="button" onClick={previewGroups}>
                    校验车辆组粘贴
                  </Button>
                  {groupPreview && (
                    <>
                      <PastePreview rows={groupPreview} caption="粘贴车辆组预览" />
                      {!groupPreview.some((row) => row.error) && (
                        <Button
                          className="button"
                          onClick={() => {
                            setEditor({
                              ...editor,
                              groups: [
                                ...editor.groups,
                                ...groupPreview.flatMap((row) => (row.row ? [row.row] : [])),
                              ],
                            });
                            setGroupPaste('');
                            setGroupPreview(null);
                          }}
                        >
                          加入车辆组草稿
                        </Button>
                      )}
                    </>
                  )}
                </details>
              </section>
              <section className={styles.editorSection} aria-label="编辑区间实测">
                <div className={styles.rowHeading}>
                  <h4>区间实测覆盖</h4>
                  <Button
                    className="button"
                    disabled={
                      !editor.groups.some((row) => row.id) ||
                      !cycles.some((cycle) => cycle.positions.length > 1)
                    }
                    onClick={() => {
                      const group = editor.groups.find((row) => row.id);
                      const cycle = cycles.find((item) => item.positions.length > 1);
                      if (!group?.id || !cycle) return;
                      setEditor({
                        ...editor,
                        measured: [
                          ...editor.measured,
                          {
                            key: crypto.randomUUID(),
                            vehicleGroupId: group.id,
                            cycleId: cycle.id,
                            fromPositionId: cycle.positions[0].id,
                            toPositionId: cycle.positions[1].id,
                            durationMinutes: '',
                            emptyKwh: '',
                            fullKwh: '',
                            source: '',
                          },
                        ],
                      });
                    }}
                  >
                    <Plus aria-hidden="true" />
                    新增区间实测
                  </Button>
                </div>
                <p className={styles.helper}>
                  先保存车辆组，再为其填写实测。时间可单独覆盖；耗电按空载、满载成对填写。未覆盖项沿用车型模板，资料变动后须核对依据。
                </p>
                <ol className={styles.editorRows} aria-label="区间实测草稿">
                  {editor.measured.map((row, index) => {
                    const cycle = cycles.find((item) => item.id === row.cycleId);
                    const group = editor.groups.find((item) => item.id === row.vehicleGroupId);
                    const saved = operations.measuredSegments.find((item) => item.id === row.id);
                    const issue = saved && measuredSegmentIssue(saved, operations, cycles);
                    const segment =
                      cycle?.positions.findIndex(
                        (position) => position.id === row.fromPositionId,
                      ) ?? -1;
                    const adjacent =
                      segment >= 0 && cycle?.positions[segment + 1]?.id === row.toPositionId;
                    return (
                      <li key={row.key}>
                        <div className={styles.rowHeading}>
                          <h5>实测 {index + 1}</h5>
                          <Button
                            className="text-button danger-text"
                            aria-label={`删除实测 ${index + 1}`}
                            onClick={() => {
                              setEditor({
                                ...editor,
                                measured: editor.measured.filter((item) => item.key !== row.key),
                              });
                              setMeasuredPreview(null);
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                            删除
                          </Button>
                        </div>
                        <div className={styles.fieldGrid}>
                          <label className="field">
                            车辆组
                            <NativeSelect
                              aria-label={`实测 ${index + 1} 车辆组`}
                              value={row.vehicleGroupId}
                              onChange={(event) =>
                                updateMeasured(row.key, {
                                  vehicleGroupId: event.target.value,
                                  refreshBasis: true,
                                })
                              }
                            >
                              {!group && (
                                <option value={row.vehicleGroupId}>车辆组已删除，请修复</option>
                              )}
                              {editor.groups
                                .filter((item) => item.id)
                                .map((item, groupIndex) => (
                                  <option key={item.key} value={item.id}>
                                    {groupIndex + 1} · {item.name}
                                  </option>
                                ))}
                            </NativeSelect>
                          </label>
                          <label className="field">
                            所属循环
                            <NativeSelect
                              aria-label={`实测 ${index + 1} 所属循环`}
                              value={row.cycleId}
                              onChange={(event) => {
                                const target = cycles.find(
                                  (item) => item.id === event.target.value,
                                );
                                updateMeasured(row.key, {
                                  cycleId: target?.id ?? '',
                                  fromPositionId: target?.positions[0]?.id ?? '',
                                  toPositionId: target?.positions[1]?.id ?? '',
                                  refreshBasis: true,
                                });
                              }}
                            >
                              {!cycle && <option value={row.cycleId}>循环已删除，请修复</option>}
                              {cycles.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name}
                                </option>
                              ))}
                            </NativeSelect>
                          </label>
                          <label className="field">
                            有向区间
                            <NativeSelect
                              aria-label={`实测 ${index + 1} 有向区间`}
                              value={adjacent ? String(segment) : 'invalid'}
                              onChange={(event) => {
                                const from = Number(event.target.value);
                                updateMeasured(row.key, {
                                  fromPositionId: cycle?.positions[from]?.id ?? '',
                                  toPositionId: cycle?.positions[from + 1]?.id ?? '',
                                  refreshBasis: true,
                                });
                              }}
                            >
                              {!adjacent && <option value="invalid">区间已失效，请修复</option>}
                              {cycle?.positions.slice(1).map((to, from) => (
                                <option key={to.id} value={String(from)}>
                                  {from + 1} · {cycle.positions[from].point.name} → {from + 2} ·{' '}
                                  {to.point.name}
                                </option>
                              ))}
                            </NativeSelect>
                          </label>
                          {(
                            [
                              ['durationMinutes', '行驶时间', '分钟'],
                              ['emptyKwh', '空载耗电', 'kWh'],
                              ['fullKwh', '满载耗电', 'kWh'],
                            ] as const
                          ).map(([field, label, unit]) => (
                            <label className="field" key={field}>
                              {label}（{unit}）
                              <Input
                                aria-label={`实测 ${index + 1} ${label}`}
                                inputMode="decimal"
                                value={row[field]}
                                onChange={(event) =>
                                  updateMeasured(row.key, { [field]: event.target.value })
                                }
                              />
                            </label>
                          ))}
                        </div>
                        <label className="field">
                          来源说明
                          <Input
                            aria-label={`实测 ${index + 1} 来源说明`}
                            value={row.source}
                            onChange={(event) =>
                              updateMeasured(row.key, { source: event.target.value })
                            }
                          />
                        </label>
                        {issue && (
                          <div className={styles.warning}>
                            <p>{issue}</p>
                            {cycle && adjacent && group && (
                              <label className={styles.confirm}>
                                <input
                                  type="checkbox"
                                  aria-label={`实测 ${index + 1} 重新确认实测依据`}
                                  checked={!!row.refreshBasis}
                                  onChange={(event) =>
                                    updateMeasured(row.key, { refreshBasis: event.target.checked })
                                  }
                                />
                                重新确认实测依据
                              </label>
                            )}
                          </div>
                        )}
                        {row.refreshBasis && (
                          <p className={styles.helper}>
                            保存后按当前区间坐标、规划偏好及车辆载重确认实测依据。
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <details className={styles.paste}>
                  <summary>批量粘贴区间实测</summary>
                  <p className={styles.helper}>
                    复制 8 列：车辆组序号、循环序号、起位置序号、止位置序号、行驶分钟、空载耗电
                    kWh、满载耗电
                    kWh、来源说明。使用当前显示顺序，起止须为相邻有向位置。仅可关联已保存车辆组。
                  </p>
                  <p className={styles.helper}>
                    车辆组：
                    {editor.groups
                      .map(
                        (group, index) =>
                          `${index + 1} · ${group.name || '未命名'}${group.id ? '' : '（待保存）'}`,
                      )
                      .join('；') || '暂无'}
                    <br />
                    循环：
                    {cycles.map((cycle, index) => `${index + 1} · ${cycle.name}`).join('；') ||
                      '暂无'}
                  </p>
                  <label className="field">
                    批量区间实测
                    <textarea
                      aria-label="批量区间实测"
                      rows={4}
                      value={measuredPaste}
                      onChange={(event) => {
                        setMeasuredPaste(event.target.value);
                        setMeasuredPreview(null);
                      }}
                    />
                  </label>
                  <Button className="button" onClick={previewMeasured}>
                    校验实测粘贴
                  </Button>
                  {measuredPreview && (
                    <>
                      <PastePreview rows={measuredPreview} caption="粘贴实测预览" />
                      {!measuredPreview.some((row) => row.error) && (
                        <Button
                          className="button"
                          onClick={() => {
                            setEditor({
                              ...editor,
                              measured: [
                                ...editor.measured,
                                ...measuredPreview.flatMap((row) => (row.row ? [row.row] : [])),
                              ],
                            });
                            setMeasuredPaste('');
                            setMeasuredPreview(null);
                          }}
                        >
                          加入实测草稿
                        </Button>
                      )}
                    </>
                  )}
                </details>
              </section>
            </fieldset>
            <div className="dialog-actions">
              <Button className="button" disabled={busy} onClick={closeEditor}>
                取消
              </Button>
              <Button type="submit" className="button primary" disabled={busy || discarding}>
                {busy ? '保存中…' : '保存全部运营资料'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
