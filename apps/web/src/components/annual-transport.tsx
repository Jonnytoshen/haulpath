'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Square, Trash2 } from 'lucide-react';
import type {
  AnnualTransportYear,
  DailyTransportTask,
  DailyTransportTaskSummary,
  DailyTransportView,
  PlanningScenario,
} from '@haulpath/domain';
import { annualTransportInputIssues } from '@haulpath/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { request } from '@/lib/client-request';
import { PeriodicityLedger } from './daily-transport-periodicity';
import {
  LedgerTable,
  StationTurnoverLedger,
  stationClockTime,
} from './daily-transport-station-ledger';
import { SharedPowerLedger } from './daily-transport-power-ledger';
import styles from './daily-transport.module.css';
import annualStyles from './annual-transport.module.css';

const active = (status?: string) => status === 'queued' || status === 'running';
const number = (value: number | null | undefined) =>
  value == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(value);
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '年度操作失败，请重试';
const statuses: Record<string, string> = {
  queued: '排队中',
  running: '逐年计算中',
  completed: '本次年度评价已结束',
  stopped: '已停止',
  interrupted: '服务中断',
  'timed-out': '已达总时限',
  failed: '计算失败',
  superseded: '输入已变化或冻结',
};
type DraftYear = { year: string; operatingDays: string; demands: Record<string, string> };
const draftOf = (years: AnnualTransportYear[]): DraftYear[] =>
  years.map((y) => ({
    year: String(y.year),
    operatingDays: String(y.operatingDays),
    demands: Object.fromEntries(y.demands.map((d) => [d.demandId, String(d.dailyTonnes)])),
  }));

export default function AnnualTransport({
  scenario,
  disabled,
  onChange,
  onWritingChange,
  onEditingChange,
}: {
  scenario: PlanningScenario;
  disabled: boolean;
  onChange: (scenario: PlanningScenario) => void;
  onWritingChange: (value: boolean) => void;
  onEditingChange: (value: boolean) => void;
}) {
  const path = `/api/projects/${encodeURIComponent(scenario.projectId)}/scenarios/${encodeURIComponent(scenario.id)}/annual-transport`;
  const [view, setView] = useState<DailyTransportView | null>(null);
  const [history, setHistory] = useState<DailyTransportTask | null>(null);
  const [historyId, setHistoryId] = useState('');
  const [draft, setDraft] = useState<DraftYear[] | null>(null);
  const [paste, setPaste] = useState('');
  const [budget, setBudget] = useState('10');
  const [seed, setSeed] = useState('1');
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [vehicleId, setVehicleId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const reads = useRef(0);
  const writing = useRef(false);
  const alive = useRef(false);
  const historyRead = useRef(0);
  const publication = useRef('');
  const task = view?.task;
  const running = active(task?.status);
  const years = scenario.context.annualTransport ?? [];
  const demands = scenario.context.transportDemands ?? [];
  const cycles = scenario.context.transportCycles ?? [];
  const demandName = (id: string) => {
    const demand = demands.find((d) => d.id === id);
    const cycle = cycles.find((c) => c.id === demand?.cycleId);
    const from =
      cycle?.positions.find((p) => p.id === demand?.loadingPositionId)?.point.name ??
      '失效装货位置';
    const to =
      cycle?.positions.find((p) => p.id === demand?.unloadingPositionId)?.point.name ??
      '失效卸货位置';
    return `${cycle?.name ?? '失效循环'}：${from} → ${to}`;
  };
  const displayed = historyId ? history : view?.resultTask;
  const result = displayed?.annualResult;
  const selected = result?.years.find((y) => y.year === selectedYear) ?? result?.years[0];
  const evidence = selected?.evidence;
  const vehicle =
    evidence?.vehicleEnergy?.vehicles.find((v) => v.vehicleId === vehicleId) ??
    evidence?.vehicleEnergy?.vehicles[0];
  const current = view?.inputVersion === scenario.inputVersion;
  const gaps = [
    ...new Set([
      ...(view?.gaps ?? []),
      ...(view?.vehicleEnergyGaps ?? []),
      ...(view?.stationTurnoverGaps ?? []),
      ...annualTransportInputIssues(scenario.context),
    ]),
  ];
  const configValid =
    budget.trim() !== '' &&
    Number.isInteger(Number(budget)) &&
    Number(budget) >= 5 &&
    Number(budget) <= 120 &&
    seed.trim() !== '' &&
    Number.isSafeInteger(Number(seed)) &&
    Number(seed) >= 0;

  const refresh = useCallback(
    async (taskId?: string) => {
      if (writing.current) return;
      const read = ++reads.current;
      try {
        if (taskId) {
          const summary = await request<DailyTransportTaskSummary>(
            `${path}/${encodeURIComponent(taskId)}?summary=1`,
          );
          if (!alive.current || read !== reads.current) return;
          const key = `${summary.taskId}/${summary.status}/${summary.annualProgress?.publication ?? 0}`;
          if (key === publication.current) {
            setView((previous) =>
              previous?.task?.taskId === taskId ? { ...previous, task: summary } : previous,
            );
            return;
          }
        }
        const next = await request<DailyTransportView>(path);
        publication.current = `${next.task?.taskId}/${next.task?.status}/${next.task?.annualProgress?.publication ?? 0}`;
        if (alive.current && read === reads.current) {
          setView(next);
          setError('');
        }
      } catch (error) {
        if (alive.current && read === reads.current) setError(messageOf(error));
      }
    },
    [path],
  );
  useEffect(() => {
    const lifecycle = reads;
    const historyLifecycle = historyRead;
    const read = ++lifecycle.current;
    alive.current = true;
    async function load() {
      try {
        const next = await request<DailyTransportView>(path);
        if (alive.current && read === lifecycle.current) {
          setView(next);
          setError('');
        }
      } catch (error) {
        if (alive.current && read === lifecycle.current) setError(messageOf(error));
      }
    }
    void load();
    return () => {
      alive.current = false;
      lifecycle.current++;
      historyLifecycle.current++;
    };
  }, [path, scenario.inputVersion]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(task?.taskId), 1000);
    return () => clearInterval(timer);
  }, [running, task?.taskId, refresh]);
  useEffect(() => {
    if (!draft) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [draft]);

  function edit(next: DraftYear[] | null) {
    setDraft(next);
    onEditingChange(next !== null);
    setError('');
  }
  async function mutate(action: 'save' | 'start' | 'stop' | 'continue') {
    if (writing.current) return;
    writing.current = true;
    reads.current++;
    setBusy(true);
    onWritingChange(true);
    setError('');
    setNotice('');
    try {
      if (action === 'save') {
        const input = (draft ?? []).map((year, index) => {
          if (
            !year.year.trim() ||
            !year.operatingDays.trim() ||
            demands.some((d) => !year.demands[d.id]?.trim())
          )
            throw new Error(`第 ${index + 1} 行：年份、运营天数和全部需求吨数必须明确填写`);
          return {
            year: Number(year.year),
            operatingDays: Number(year.operatingDays),
            demands: demands.map((d) => ({
              demandId: d.id,
              dailyTonnes: Number(year.demands[d.id]),
            })),
          };
        });
        const saved = await request<PlanningScenario>(path, 'PUT', {
          expectedRevision: scenario.revision,
          years: input,
        });
        if (!alive.current) return;
        onChange(saved);
        edit(null);
        setNotice('年度输入已保存；输入变化后请在输入资料中显式准备道路。');
      } else {
        const source = action === 'stop' ? task : historyId ? history : task;
        const target =
          action === 'start' ? path : `${path}/${encodeURIComponent(source!.taskId)}/${action}`;
        const next = await request<DailyTransportView>(
          target,
          'POST',
          action === 'stop'
            ? undefined
            : action === 'continue'
              ? { expectedRevision: scenario.revision, maxRuntimeMs: Number(budget) * 60000 }
              : {
                  expectedRevision: scenario.revision,
                  config: { seed: Number(seed), maxRuntimeMs: Number(budget) * 60000 },
                },
        );
        if (!alive.current) return;
        setView(next);
        setHistoryId('');
        setHistory(null);
      }
    } catch (error) {
      if (alive.current) setError(messageOf(error));
    } finally {
      writing.current = false;
      if (alive.current) {
        setBusy(false);
        onWritingChange(false);
      }
    }
  }
  async function chooseHistory(id: string) {
    setHistoryId(id);
    setHistory(null);
    const read = ++historyRead.current;
    if (!id) return;
    try {
      const next = await request<DailyTransportTask>(`${path}/${encodeURIComponent(id)}`);
      if (alive.current && read === historyRead.current) setHistory(next);
    } catch (error) {
      if (alive.current && read === historyRead.current) setError(messageOf(error));
    }
  }
  function importPaste() {
    try {
      if (!paste.trim()) throw new Error('请先粘贴年度资料');
      const rows = paste
        .trim()
        .split(/\r?\n/)
        .map((line, i) => {
          const cells = line.split('\t');
          if (
            cells.length !== demands.length + 2 ||
            cells.some((c) => !c.trim() || !Number.isFinite(Number(c)))
          )
            throw new Error(`第 ${i + 1} 行：列数或数值无效，请按年份、运营天数及全部需求顺序填写`);
          return {
            year: cells[0],
            operatingDays: cells[1],
            demands: Object.fromEntries(demands.map((d, index) => [d.id, cells[index + 2]])),
          };
        });
      setDraft(rows);
      setError('');
    } catch (error) {
      setError(messageOf(error));
    }
  }
  const resume = historyId ? history : task;
  const canContinue =
    resume &&
    !active(resume.status) &&
    resume.inputVersion === scenario.inputVersion &&
    scenario.status === 'draft';
  return (
    <section className={styles.section} aria-label="方案年度运输能力">
      <div className={styles.heading}>
        <div>
          <h3>年度运输能力</h3>
          <p>同一站网和车队逐年重算代表日，不自动扩建或增车。每年的日吨数与年运营天数分别录入。</p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !!draft}
          onClick={() => void refresh()}
        >
          <RefreshCw aria-hidden="true" />
          刷新年度状态
        </Button>
      </div>
      <p className={styles.boundary}>
        按实际完成量乘运营天数形成年度数量。各年独立寻找可重复 24 小时状态，不连续结转跨年电量。
        <strong>经济校核尚未就绪</strong>
        ，不等待税费、贷款或完整财务；已启用的预算硬约束仍须满足。未校验重卡限高、限重及货车限行。
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.caption}>
          {notice}
        </p>
      )}
      <section className={styles.block} aria-label="年度输入">
        <div className={styles.subheading}>
          <h4>评价年份与需求</h4>
          {!draft && (
            <Button
              variant="outline"
              disabled={disabled || busy}
              onClick={() => edit(draftOf(years))}
            >
              编辑年度输入
            </Button>
          )}
        </div>
        <p className={styles.caption}>
          年份按升序保存。日吨数须为正数，运营天数可为
          0–366；零天不产生年度业务量，仍核对代表日能力。留空不补默认值。
        </p>
        {!draft ? (
          years.length ? (
            <LedgerTable label="年度需求输入">
              <thead>
                <tr>
                  <th>年份</th>
                  <th>运营天数</th>
                  <th>代表日需求</th>
                </tr>
              </thead>
              <tbody>
                {years.map((y) => (
                  <tr key={y.year}>
                    <th>{y.year}</th>
                    <td>{y.operatingDays} 天</td>
                    <td>
                      {y.demands.map((d) => (
                        <div key={d.demandId}>
                          {demandName(d.demandId)} · {number(d.dailyTonnes)} 吨/日
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </LedgerTable>
          ) : (
            <p className={styles.caption}>尚未录入评价年份，请先配置运输需求，再编辑年度输入。</p>
          )
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void mutate('save');
            }}
          >
            <fieldset disabled={busy || disabled} className={annualStyles.fieldset}>
              <LedgerTable label="编辑年度需求">
                <thead>
                  <tr>
                    <th>年份</th>
                    <th>运营天数</th>
                    {demands.map((d, i) => (
                      <th key={d.id}>
                        需求 {i + 1} · {demandName(d.id)}（吨/日）
                      </th>
                    ))}
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.map((y, i) => (
                    <tr key={i}>
                      <td>
                        <Input
                          aria-label={`第 ${i + 1} 行年份`}
                          type="number"
                          min="1"
                          max="9999"
                          step="1"
                          value={y.year}
                          onChange={(e) =>
                            setDraft(
                              draft.map((row, n) =>
                                n === i ? { ...row, year: e.target.value } : row,
                              ),
                            )
                          }
                          required
                        />
                      </td>
                      <td>
                        <Input
                          aria-label={`第 ${i + 1} 行运营天数`}
                          type="number"
                          min="0"
                          max="366"
                          step="1"
                          value={y.operatingDays}
                          onChange={(e) =>
                            setDraft(
                              draft.map((row, n) =>
                                n === i ? { ...row, operatingDays: e.target.value } : row,
                              ),
                            )
                          }
                          required
                        />
                      </td>
                      {demands.map((d, j) => (
                        <td key={d.id}>
                          <Input
                            aria-label={`第 ${i + 1} 行需求 ${j + 1} 日吨数`}
                            type="number"
                            min="0"
                            step="any"
                            value={y.demands[d.id] ?? ''}
                            onChange={(e) =>
                              setDraft(
                                draft.map((row, n) =>
                                  n === i
                                    ? {
                                        ...row,
                                        demands: { ...row.demands, [d.id]: e.target.value },
                                      }
                                    : row,
                                ),
                              )
                            }
                            required
                          />
                        </td>
                      ))}
                      <td>
                        <Button
                          type="button"
                          variant="ghost"
                          aria-label={`删除第 ${i + 1} 个评价年份`}
                          onClick={() => setDraft(draft.filter((_, n) => n !== i))}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </LedgerTable>
              <div className={styles.actions}>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDraft([...draft, { year: '', operatingDays: '', demands: {} }])}
                >
                  <Plus aria-hidden="true" />
                  添加评价年份
                </Button>
              </div>
              <details className={annualStyles.paste}>
                <summary>批量粘贴年度输入</summary>
                <p>
                  每行依次为年份、运营天数、按上表顺序排列的各需求日吨数，列间用制表符分隔，不含表头。预览替换当前编辑表，保存后生效。
                </p>
                <textarea
                  aria-label="年度批量粘贴"
                  rows={4}
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                />
                <Button type="button" variant="outline" onClick={importPaste}>
                  预览年度输入
                </Button>
              </details>
              <div className={styles.actions}>
                <Button type="submit">保存年度输入</Button>
                <Button type="button" variant="outline" onClick={() => edit(null)}>
                  取消年度编辑
                </Button>
              </div>
            </fieldset>
          </form>
        )}
      </section>
      <section className={styles.taskPanel} aria-label="年度计算任务">
        <div className={styles.taskHeading}>
          <strong>{task ? statuses[task.status] : '尚未开始年度评价'}</strong>
          {task && (
            <span>
              输入 v{task.inputVersion} · {number((task.elapsedMs ?? 0) / 1000)} 秒
            </span>
          )}
        </div>
        <p>
          预算覆盖整个多年任务；各年按剩余预算均分，等价代表日可复用。有限搜索不证明最优或全局能力上限，未找到周期不等于已证明无解。
        </p>
        {task?.annualProgress && (
          <p role="status">
            已评价 {task.annualProgress.completedYears} / {task.annualProgress.totalYears} 年
            {task.annualProgress.currentYear && `，当前 ${task.annualProgress.currentYear} 年`}
            。已有 {task.annualProgress.validatedYears} 年保留完整周期证据。
          </p>
        )}
        {task?.error && <p role="status">{task.error}</p>}
        <div className={styles.config}>
          <label>
            多年任务总预算（分钟）
            <Input
              type="number"
              min="5"
              max="120"
              value={budget}
              disabled={busy || running}
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
          <label>
            随机种子
            <Input
              type="number"
              min="0"
              step="1"
              value={seed}
              disabled={busy || running}
              onChange={(e) => setSeed(e.target.value)}
            />
          </label>
        </div>
        {!running && gaps.length > 0 && (
          <details>
            <summary>查看启动缺口（{gaps.length}）</summary>
            <ul>
              {gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </details>
        )}
        <div className={styles.actions}>
          <Button
            disabled={
              disabled || busy || !!draft || !current || running || !configValid || gaps.length > 0
            }
            onClick={() => void mutate('start')}
          >
            逐年校核运输能力
          </Button>
          {running && (
            <Button variant="outline" disabled={busy} onClick={() => void mutate('stop')}>
              <Square aria-hidden="true" />
              停止年度计算
            </Button>
          )}
          {canContinue && (
            <Button
              variant="outline"
              disabled={disabled || busy || !!draft || running || !configValid}
              onClick={() => void mutate('continue')}
            >
              继续年度计算
            </Button>
          )}
        </div>
        {canContinue && (
          <p>
            续算创建新任务，沿用原输入、道路和种子；复核已完成年度，其他年度重新搜索，不恢复指令位置。
          </p>
        )}
      </section>
      {(view?.tasks.length ?? 0) > 0 && (
        <label className={annualStyles.history}>
          查看年度任务
          <NativeSelect
            aria-label="查看年度任务"
            value={historyId}
            onChange={(e) => void chooseHistory(e.target.value)}
          >
            <option value="">最近保留的年度成果</option>
            {view!.tasks.map((t) => (
              <option value={t.taskId} key={t.taskId}>
                v{t.inputVersion} ·{' '}
                {new Date(t.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} ·{' '}
                {statuses[t.status]}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}
      {result && (
        <>
          <section className={styles.block} aria-label="年度能力汇总">
            <h4>逐年目标与实际完成</h4>
            <p className={styles.caption}>
              评价期已校核实际完成 {number(result.totalCompletedTonnes)} 吨。
              {result.complete
                ? '全部年度均有完整物理证据。'
                : '多年成果尚不完整，未校核年度不计入已完成量。'}
              经济校核尚未就绪。
            </p>
            {displayed!.inputVersion !== scenario.inputVersion && (
              <p role="status" className={styles.stale}>
                这是旧输入版本的保存结果（v{displayed!.inputVersion}），不代表当前输入。
              </p>
            )}
            <p className={styles.caption}>
              年份列保持可见；横向滚动可核对完成率、瓶颈并选择年度账目。
            </p>
            <div className={annualStyles.summary}>
              <LedgerTable label="逐年运输能力汇总">
                <thead>
                  <tr>
                    <th>年份</th>
                    <th>日目标 / 完成（吨）</th>
                    <th>年目标（吨）</th>
                    <th>年完成（吨）</th>
                    <th>年缺口（吨）</th>
                    <th>完成率</th>
                    <th>校核与瓶颈</th>
                    <th>账目</th>
                  </tr>
                </thead>
                <tbody>
                  {result.years.map((y) => (
                    <tr key={y.year} aria-selected={y.year === selected?.year}>
                      <th>{y.year}</th>
                      <td>
                        {number(y.dailyTargetTonnes)} / {number(y.dailyCompletedTonnes)}
                      </td>
                      <td>{number(y.targetTonnes)}</td>
                      <td>{number(y.completedTonnes)}</td>
                      <td>{number(y.missingTonnes)}</td>
                      <td>
                        {y.completionRate == null ? '—' : `${number(y.completionRate * 100)}%`}
                      </td>
                      <td>
                        {y.status === 'checked'
                          ? '周期已校核'
                          : y.status === 'searching'
                            ? '本年仍在搜索'
                            : '本次未找到周期'}
                        {y.reusedFromYear !== null && `；复用 ${y.reusedFromYear} 年等价代表日`}
                        {y.bottlenecks.map((b, i) => (
                          <div key={i}>{b}</div>
                        ))}
                      </td>
                      <td>
                        <Button
                          variant="ghost"
                          aria-pressed={y.year === selected?.year}
                          onClick={() => setSelectedYear(y.year)}
                        >
                          核对 {y.year} 年
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </LedgerTable>
            </div>
          </section>
          {selected && (
            <section className={styles.block} aria-label={`${selected.year} 年运营账目`}>
              <h4>{selected.year} 年运营账目</h4>
              <p className={styles.caption}>
                输入 v{displayed!.inputVersion} · {selected.operatingDays}{' '}
                个运营日；以下详细账目均为代表日。年数量为该日实际账目乘运营天数，不能作为连续跨年排程或财务结论。
              </p>
              <div className={annualStyles.quantities}>
                <LedgerTable label="年度运营数量">
                  <thead>
                    <tr>
                      <th>实际行驶（km/年）</th>
                      <th>其中空驶（km/年）</th>
                      <th>换电（次/年）</th>
                      <th>购电（kWh/年）</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        {number(
                          selected.annualDistanceMeters == null
                            ? null
                            : selected.annualDistanceMeters / 1000,
                        )}
                      </td>
                      <td>
                        {number(
                          selected.annualEmptyDistanceMeters == null
                            ? null
                            : selected.annualEmptyDistanceMeters / 1000,
                        )}
                      </td>
                      <td>{number(selected.annualSwapCount)}</td>
                      <td>{number(selected.annualGridEnergyKwh)}</td>
                    </tr>
                  </tbody>
                </LedgerTable>
              </div>
              {evidence ? (
                <>
                  <PeriodicityLedger result={evidence} />
                  <label className={annualStyles.history}>
                    计划车辆
                    <NativeSelect
                      aria-label="年度计划车辆"
                      value={vehicle?.vehicleId ?? ''}
                      onChange={(e) => setVehicleId(e.target.value)}
                    >
                      {evidence.vehicleEnergy!.vehicles.map((v) => (
                        <option key={v.vehicleId} value={v.vehicleId}>
                          {v.vehicleId}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  {vehicle && (
                    <LedgerTable label="年度代表日逐车事件">
                      <thead>
                        <tr>
                          <th>事件</th>
                          <th>开始 / 结束</th>
                          <th>载荷（吨）</th>
                          <th>里程（km）</th>
                          <th>电量（kWh）</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vehicle.events.map((e) => (
                          <tr key={e.id}>
                            <td>
                              {
                                {
                                  transport: '运输',
                                  loading: '装货',
                                  unloading: '卸货',
                                  continuation: '接续空驶',
                                  return: '归位空驶',
                                  'station-entry': '进站',
                                  swap: '换电',
                                  'station-exit': '出站',
                                }[e.kind]
                              }
                            </td>
                            <td>
                              {stationClockTime(e.startMinute)} / {stationClockTime(e.endMinute)}
                            </td>
                            <td>{number(e.loadTonnes)}</td>
                            <td>{number(e.distanceMeters / 1000)}</td>
                            <td>
                              {number(e.startKwh)} → {number(e.endKwh)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </LedgerTable>
                  )}
                  <StationTurnoverLedger
                    turnover={evidence.stationTurnover!}
                    network={displayed!.snapshot.context.stationNetwork}
                  />
                  <SharedPowerLedger
                    power={evidence.sharedPower!}
                    turnover={evidence.stationTurnover!}
                  />
                </>
              ) : (
                <p>该年尚无完整周期证据，实际完成量与运营账目留空。本次未找到不证明全局无解。</p>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
