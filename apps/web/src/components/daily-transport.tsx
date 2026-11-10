'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { BatteryCharging, Play, RefreshCw, Square, Warehouse, Zap } from 'lucide-react';
import {
  PLANNING_NOTICE,
  formatKilometers,
  type DailyTransportStage,
  type DailyTransportEvent,
  type DailyTransportEventKind,
  type DailyTransportTask,
  type DailyTransportTaskSummary,
  type DailyTransportView,
  type PlanningScenario,
  type RoadTaskStatus,
  type VehicleEnergyEvent,
} from '@haulpath/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { request } from '@/lib/client-request';
import { BatteryTrace, energyNumber, percent } from './daily-transport-soc-trace';
import {
  StationTurnoverLedger,
  serviceWaitLabels,
  stationClockTime,
} from './daily-transport-station-ledger';
import styles from './daily-transport.module.css';
import { SharedPowerLedger } from './daily-transport-power-ledger';

const statuses: Record<RoadTaskStatus, string> = {
  queued: '等待试算',
  running: '正在试算',
  completed: '试算完成',
  stopped: '已停止',
  failed: '试算失败',
  'timed-out': '试算超时',
  interrupted: '服务中断',
  superseded: '输入已更新',
};
const kinds: Record<DailyTransportEventKind | VehicleEnergyEvent['kind'], string> = {
  transport: '运输',
  loading: '装货',
  unloading: '卸货',
  continuation: '跨线空驶',
  return: '归位空驶',
  'station-entry': '驶入站址',
  swap: '换电',
  'station-exit': '驶离站址',
};
type Mutation = DailyTransportStage | 'stop' | 'save-limits';
type DetourDraft = { revision: number; kilometers: string; minutes: string };
const active = (status?: RoadTaskStatus) => status === 'queued' || status === 'running';
const tonnes = (value: number) =>
  value.toLocaleString('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const minutes = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const stages: Record<DailyTransportStage, string> = {
  transport: '运输试算',
  'vehicle-energy': '车辆电量试算',
  'station-turnover': '站内周转试算',
  'shared-power': '共享电源试算',
};
const stageName = (task?: DailyTransportTaskSummary | null) =>
  stages[task?.config.stage ?? 'transport'];
const limitDistance = (value: number | null | undefined) =>
  value == null ? '不限距离' : `额外里程 ≤ ${formatKilometers(value)} km`;
const limitTime = (value: number | null | undefined) =>
  value == null ? '不限时间' : `额外行驶 ≤ ${value} 分钟`;
const time = (minute: number) => {
  const whole = Math.round(minute);
  const day = Math.floor(whole / 1440);
  return `${day ? `${day === 1 ? '次日' : `第${day + 1}日`} ` : ''}${String(Math.floor((whole % 1440) / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
};
const savedTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const message = (error: unknown) =>
  error instanceof Error ? error.message : '读取或生成运输日计划失败，请重试。';

export default function DailyTransport({
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
  const path = `/api/projects/${encodeURIComponent(scenario.projectId)}/scenarios/${encodeURIComponent(scenario.id)}/daily-transport`;
  const [view, setView] = useState<DailyTransportView | null>(null);
  const [reading, setReading] = useState(true);
  const [operation, setOperation] = useState<Mutation | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  const [historyId, setHistoryId] = useState('');
  const [history, setHistory] = useState<DailyTransportTask | null>(null);
  const [historyReading, setHistoryReading] = useState(false);
  const [vehicleId, setVehicleId] = useState('');
  const [runtime, setRuntime] = useState('10');
  const [seed, setSeed] = useState('1');
  const [detourDraft, setDetourDraft] = useState<DetourDraft | null>(null);
  const [savedLimitsRevision, setSavedLimitsRevision] = useState<number | null>(null);
  const alive = useRef(false);
  const reads = useRef(0);
  const historyReads = useRef(0);
  const writing = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const task = view?.task;
  const running = active(task?.status);
  const baselineProgress = task?.config.stage && task.config.stage !== 'transport';
  const runningTaskId = running ? task?.taskId : undefined;
  const frozen = scenario.status === 'frozen';
  const current = view?.inputVersion === scenario.inputVersion;
  const displayed = historyId ? history : view?.resultTask;
  const result = displayed?.result;
  const snapshot = displayed?.snapshot.context;
  const energy = result?.vehicleEnergy;
  const turnover = result?.stationTurnover;
  const eventTime = turnover ? stationClockTime : time;
  const stationSwaps = new Map(
    turnover?.stations.flatMap((station) =>
      station.swaps.map((swap) => [swap.eventId, swap] as const),
    ),
  );
  const energyVehicles = new Map(energy?.vehicles.map((vehicle) => [vehicle.vehicleId, vehicle]));
  const selectedVehicle =
    result?.vehicles.find((vehicle) => vehicle.vehicleId === vehicleId) ?? result?.vehicles[0];
  const selectedEnergy = selectedVehicle && energyVehicles.get(selectedVehicle.vehicleId);
  const selectedEvents = selectedEnergy?.events ?? selectedVehicle?.events ?? [];
  const energyGaps = view?.vehicleEnergyGaps ?? [];
  const turnoverGaps = view?.stationTurnoverGaps ?? [];
  const limits = scenario.context.swapDetourLimits;
  const savedDistance = limits?.maxExtraMeters ?? null;
  const savedMinutes = limits?.maxExtraMinutes ?? null;
  const draft =
    detourDraft?.revision === scenario.revision
      ? detourDraft
      : {
          revision: scenario.revision,
          kilometers: savedDistance == null ? '' : String(savedDistance / 1000),
          minutes: savedMinutes == null ? '' : String(savedMinutes),
        };
  const kilometers = Number(draft.kilometers);
  const maxExtraMeters = draft.kilometers === '' ? null : Math.round(kilometers * 1000);
  const maxExtraMinutes = draft.minutes === '' ? null : Number(draft.minutes);
  const validLimits =
    (maxExtraMeters == null ||
      (kilometers >= 0 &&
        Number.isSafeInteger(maxExtraMeters) &&
        kilometers === maxExtraMeters / 1000)) &&
    (maxExtraMinutes == null || (Number.isFinite(maxExtraMinutes) && maxExtraMinutes >= 0));
  const dirtyLimits = maxExtraMeters !== savedDistance || maxExtraMinutes !== savedMinutes;
  const configValid =
    Number.isInteger(Number(runtime)) &&
    Number(runtime) >= 5 &&
    Number(runtime) <= 120 &&
    seed.trim() !== '' &&
    Number.isSafeInteger(Number(seed)) &&
    Number(seed) >= 0;

  const refresh = useCallback(
    async (taskId?: string) => {
      if (writing.current) return;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const read = ++reads.current;
      try {
        if (taskId) {
          const summary = await request<DailyTransportTaskSummary>(
            `${path}/${encodeURIComponent(taskId)}?summary=1`,
            'GET',
            undefined,
            abort.signal,
          );
          if (!alive.current || read !== reads.current) return;
          if (active(summary.status)) {
            setView((previous) =>
              previous?.task?.taskId === taskId ? { ...previous, task: summary } : previous,
            );
            setError('');
            return;
          }
        }
        const next = await request<DailyTransportView>(path, 'GET', undefined, abort.signal);
        if (!alive.current || read !== reads.current) return;
        setView(next);
        setError('');
      } catch (failure) {
        if (alive.current && read === reads.current && !abort.signal.aborted)
          setError(message(failure));
      } finally {
        if (alive.current && read === reads.current) setReading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    const lifecycle = reads;
    const historical = historyReads;
    alive.current = true;
    return () => {
      alive.current = false;
      lifecycle.current++;
      historical.current++;
      controller.current?.abort();
    };
  }, [path]);

  useEffect(() => {
    // Subscribe to the persisted task; no computation depends on the page staying open.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh, scenario.inputVersion, scenario.revision]);

  useEffect(() => {
    if (!runningTaskId) return;
    let stopped = false;
    let timer: number;
    async function poll() {
      await refresh(runningTaskId);
      if (!stopped) timer = window.setTimeout(() => void poll(), 800);
    }
    timer = window.setTimeout(() => void poll(), 800);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [refresh, runningTaskId]);

  async function mutate(operation: Mutation) {
    if (writing.current || disabled || frozen) return;
    writing.current = true;
    reads.current++;
    controller.current?.abort();
    setOperation(operation);
    setError('');
    onWritingChange(true);
    try {
      if (operation === 'save-limits') {
        const saved = await request<PlanningScenario>(path, 'PUT', {
          expectedRevision: draft.revision,
          swapDetourLimits: { maxExtraMeters, maxExtraMinutes },
        });
        if (alive.current) {
          setDetourDraft(null);
          setSavedLimitsRevision(saved.revision);
          setReading(false);
          onChange(saved);
        }
        return;
      }
      const next = await request<DailyTransportView>(
        operation === 'stop' ? `${path}/${task!.taskId}/stop` : path,
        'POST',
        operation !== 'stop'
          ? {
              expectedRevision: scenario.revision,
              config: {
                seed: Number(seed),
                maxRuntimeMs: Number(runtime) * 60000,
                ...(operation === 'transport' ? {} : { stage: operation }),
              },
            }
          : undefined,
      );
      if (alive.current) {
        setView(next);
        setReading(false);
        if (operation !== 'stop') {
          setHistoryId('');
          setHistory(null);
          setHistoryReading(false);
          historyReads.current++;
        }
      }
    } catch (failure) {
      if (alive.current) setError(message(failure));
    } finally {
      writing.current = false;
      if (alive.current) {
        setOperation(null);
        onWritingChange(false);
      }
    }
  }

  async function selectHistory(taskId: string) {
    const read = ++historyReads.current;
    setHistoryId(taskId);
    setHistory(null);
    setError('');
    setHistoryReading(Boolean(taskId));
    if (!taskId) return;
    try {
      const next = await request<DailyTransportTask>(`${path}/${encodeURIComponent(taskId)}`);
      if (alive.current && read === historyReads.current) setHistory(next);
    } catch (failure) {
      if (alive.current && read === historyReads.current) setError(message(failure));
    } finally {
      if (alive.current && read === historyReads.current) setHistoryReading(false);
    }
  }

  const cycleName = (id: string) =>
    snapshot?.transportCycles?.find((cycle) => cycle.id === id)?.name ?? '原循环';
  const positionNames = new Map(
    snapshot?.transportCycles?.flatMap((cycle) =>
      cycle.positions.map(
        (position, index) =>
          [
            position.id,
            { label: `${position.point.name}（第 ${index + 1} 位）`, cycleName: cycle.name },
          ] as const,
      ),
    ),
  );
  const positionName = (positionId: string) => positionNames.get(positionId)?.label ?? '原位置';
  function eventLocation(event: DailyTransportEvent | VehicleEnergyEvent): string {
    const from = positionNames.get(event.fromPositionId);
    const to = positionNames.get(event.toPositionId);
    if (event.kind === 'swap') return event.from.name;
    if (event.kind === 'loading' || event.kind === 'unloading')
      return from?.label ?? event.from.name;
    if (
      event.kind === 'transport' ||
      event.kind === 'station-entry' ||
      event.kind === 'station-exit'
    )
      return `${from?.label ?? event.from.name} → ${to?.label ?? event.to.name}`;
    return `${from?.cycleName ?? '原循环'} · ${from?.label ?? event.from.name} → ${to?.cycleName ?? '原循环'} · ${to?.label ?? event.to.name}`;
  }
  const allocationText = (event: DailyTransportEvent | VehicleEnergyEvent) =>
    event.allocations
      .map((allocation) => {
        const demand = result?.demands.find((entry) => entry.demandId === allocation.demandId);
        return `${demand ? `${positionName(demand.loadingPositionId)} → ${positionName(demand.unloadingPositionId)}` : '原需求'} ${tonnes(allocation.tonnes)} 吨`;
      })
      .join('；');
  const timelineStart = result?.vehicles.length
    ? Math.floor(
        Math.min(
          ...result.vehicles.flatMap((vehicle) => vehicle.shifts.map((shift) => shift.startMinute)),
        ) / 60,
      ) * 60
    : 0;
  const timelineEnd = result?.vehicles.length
    ? Math.ceil(
        Math.max(
          ...result.vehicles.flatMap((vehicle) => vehicle.shifts.map((shift) => shift.endMinute)),
        ) / 60,
      ) * 60
    : 1440;
  const timelineSpan = Math.max(60, timelineEnd - timelineStart);
  const tickStep = Math.ceil(timelineSpan / 4 / 60) * 60;
  const ticks = Array.from(
    { length: Math.floor(timelineSpan / tickStep) + 1 },
    (_, index) => timelineStart + index * tickStep,
  );
  const presentKinds = result
    ? [
        ...new Set(
          result.vehicles.flatMap((vehicle) =>
            (energyVehicles.get(vehicle.vehicleId)?.events ?? vehicle.events).map(
              (event) => event.kind,
            ),
          ),
        ),
      ]
    : [];
  const startDisabled =
    busy || disabled || frozen || reading || !current || Boolean(view?.gaps.length) || !configValid;
  const energyDisabled = startDisabled || energyGaps.length > 0 || !validLimits || dirtyLimits;
  const turnoverDisabled = energyDisabled || turnoverGaps.length > 0;

  return (
    <section className={styles.section} aria-label="方案每日运输计划">
      <header className={styles.heading}>
        <div>
          <h3>每日运输计划</h3>
          <p>按给定车队、完整循环与班次，试算逐车运输、换电访问和固定布局内的电池周转。</p>
        </div>
        <Button
          className="text-button"
          disabled={busy || reading}
          onClick={() => {
            setReading(true);
            void refresh();
          }}
          aria-label="刷新运输日计划"
        >
          <RefreshCw aria-hidden="true" />
          刷新
        </Button>
      </header>
      <p className={styles.boundary}>
        {energy ? (
          <>
            <strong>
              {result?.sharedPower
                ? '共享电源校核通过'
                : turnover
                  ? '站内周转校核通过'
                  : '车辆电量校核通过'}
            </strong>
            {displayed &&
              displayed.inputVersion !== scenario.inputVersion &&
              `（输入版本 ${displayed.inputVersion} 的结果）`}
            {result?.sharedPower
              ? ' · 24 小时周期尚未校核。'
              : turnover
                ? ' · 共享电源及 24 小时周期尚未校核。'
                : ' · 工位、库存、共享电源及 24 小时周期尚未校核。'}
          </>
        ) : (
          <>
            <strong>补能校核未完成</strong> · 运输试算核对运输载荷与时间。
          </>
        )}
        不能据此判断完整物理可行。
        {PLANNING_NOTICE}
      </p>
      <div className={styles.taskPanel}>
        <div className={styles.taskHeading}>
          <strong>
            {reading && !view
              ? '正在读取运输任务…'
              : task
                ? `${stageName(task)} · ${statuses[task.status]}`
                : '尚未生成运输日计划'}
          </strong>
          <span>当前输入版本 {scenario.inputVersion}</span>
        </div>
        {running && (
          <>
            <p role="status">
              {baselineProgress && '运输基线 · '}
              已安排 {task!.progress.completedTrips} 个完整循环，完成{' '}
              {tonnes(task!.progress.completedTonnes)} / {tonnes(task!.progress.totalTonnes)}{' '}
              吨。关闭页面后继续试算。
            </p>
            <progress
              className={styles.progress}
              aria-label={baselineProgress ? '运输基线试算进度' : '运输试算进度'}
              value={task!.progress.completedTonnes}
              max={task!.progress.totalTonnes || 1}
            />
          </>
        )}
        {task?.error && (
          <p className={styles.error} role="status">
            {task.error}
          </p>
        )}
        <div className={styles.actions}>
          {running ? (
            <Button
              className="button"
              disabled={busy || disabled || frozen}
              onClick={() => void mutate('stop')}
            >
              <Square aria-hidden="true" />
              停止{stageName(task)}
            </Button>
          ) : (
            <>
              <Button
                className={`button${energyDisabled ? ' primary' : ''}`}
                disabled={startDisabled}
                onClick={() => void mutate('transport')}
              >
                <Play aria-hidden="true" />
                {operation === 'transport' ? '正在启动…' : '生成运输日计划'}
              </Button>
              <Button
                className={`button${!energyDisabled && turnoverDisabled ? ' primary' : ''}`}
                disabled={energyDisabled}
                onClick={() => void mutate('vehicle-energy')}
              >
                <BatteryCharging aria-hidden="true" />
                {operation === 'vehicle-energy' ? '正在启动…' : '生成车辆电量试算'}
              </Button>
              <Button
                className="button"
                disabled={turnoverDisabled}
                onClick={() => void mutate('station-turnover')}
              >
                <Warehouse aria-hidden="true" />
                {operation === 'station-turnover' ? '正在启动…' : '生成站内周转试算'}
              </Button>
              <Button
                className={`button${turnoverDisabled ? '' : ' primary'}`}
                disabled={turnoverDisabled}
                onClick={() => void mutate('shared-power')}
              >
                <Zap aria-hidden="true" />
                {operation === 'shared-power' ? '正在启动…' : '生成共享电源试算'}
              </Button>
            </>
          )}
          <span>
            {frozen ? '冻结版本只读，可复制为新草案调整。' : '单任务队列，试算完成后提前结束。'}
          </span>
        </div>
        <details className={styles.detourLimits}>
          <summary>
            换电绕行限额{' '}
            <span>
              {limitDistance(savedDistance)} · {limitTime(savedMinutes)}
            </span>
          </summary>
          <p id="detour-limit-help">
            以业务区间直达为基准，只比较额外行驶，换电和等待另计入班次。留空不限，填 0
            则只允许无额外里程或时间的绕行。
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (validLimits && dirtyLimits && !running) void mutate('save-limits');
            }}
          >
            <div className={styles.config}>
              <label>
                最多额外里程（km）
                <Input
                  type="number"
                  min={0}
                  step={0.001}
                  aria-describedby="detour-limit-help"
                  value={draft.kilometers}
                  disabled={disabled || frozen || busy || running}
                  placeholder="不限"
                  onChange={(event) => setDetourDraft({ ...draft, kilometers: event.target.value })}
                />
              </label>
              <label>
                最多额外行驶时间（分钟）
                <Input
                  type="number"
                  min={0}
                  step="any"
                  aria-describedby="detour-limit-help"
                  value={draft.minutes}
                  disabled={disabled || frozen || busy || running}
                  placeholder="不限"
                  onChange={(event) => setDetourDraft({ ...draft, minutes: event.target.value })}
                />
              </label>
            </div>
            {!validLimits && (
              <p className={styles.error}>限额须为非负数，额外里程最多保留三位小数。</p>
            )}
            <div className={styles.actions}>
              <Button
                className="button"
                type="submit"
                disabled={disabled || frozen || busy || running || !validLimits || !dirtyLimits}
              >
                {operation === 'save-limits' ? '正在保存…' : '保存绕行限额'}
              </Button>
              <span role="status">
                {dirtyLimits
                  ? '保存后才能按新限额试算。'
                  : savedLimitsRevision === scenario.revision
                    ? '绕行限额已保存。请在「输入资料」为新版本准备道路。'
                    : ''}
              </span>
            </div>
          </form>
        </details>
        {!running && !frozen && (
          <details className={styles.record} open={!configValid}>
            <summary>试算设置</summary>
            <div className={styles.config}>
              <label>
                最长试算时间（分钟）
                <Input
                  type="number"
                  min={5}
                  max={120}
                  step={1}
                  value={runtime}
                  disabled={disabled || frozen || busy}
                  onChange={(event) => setRuntime(event.target.value)}
                />
              </label>
              <label>
                随机种子
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={seed}
                  disabled={disabled || frozen || busy}
                  onChange={(event) => setSeed(event.target.value)}
                />
              </label>
            </div>
          </details>
        )}
        {!configValid && (
          <p className={styles.error}>试算时间须为 5–120 分钟，随机种子须为非负整数。</p>
        )}
        {view?.gaps.length ? (
          <details className={styles.gaps} open>
            <summary>运输试算待补齐（{view.gaps.length} 项）</summary>
            <ul>
              {view.gaps.map((gap, index) => (
                <li key={`${index}-${gap}`}>{gap}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {energyGaps.length > 0 && (
          <details className={styles.gaps} open>
            <summary>车辆电量试算待补齐（{energyGaps.length} 项）</summary>
            <ul>
              {energyGaps.map((gap, index) => (
                <li key={`${index}-${gap}`}>{gap}</li>
              ))}
            </ul>
          </details>
        )}
        {turnoverGaps.length > 0 && (
          <details className={styles.gaps} open>
            <summary>站内周转与共享电源试算待补齐（{turnoverGaps.length} 项）</summary>
            <ul>
              {turnoverGaps.map((gap, index) => (
                <li key={`${index}-${gap}`}>{gap}</li>
              ))}
            </ul>
          </details>
        )}
        {task && (
          <details className={styles.record}>
            <summary>任务与算法依据</summary>
            <dl>
              <div>
                <dt>试算阶段</dt>
                <dd>{stageName(task)}</dd>
              </div>
              <div>
                <dt>任务标识</dt>
                <dd>{task.taskId}</dd>
              </div>
              <div>
                <dt>输入版本</dt>
                <dd>{task.inputVersion}</dd>
              </div>
              <div>
                <dt>算法版本</dt>
                <dd>{task.algorithmVersion}</dd>
              </div>
              <div>
                <dt>随机种子 / 时限</dt>
                <dd>
                  {task.config.seed} / {minutes(task.config.maxRuntimeMs / 60000)} 分钟
                </dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{savedTime(task.createdAt)}</dd>
              </div>
              {task.finishedAt && (
                <div>
                  <dt>结束时间</dt>
                  <dd>{savedTime(task.finishedAt)}</dd>
                </div>
              )}
            </dl>
          </details>
        )}
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {view && view.tasks.length > 0 && (
        <label className={styles.history}>
          核对已保存任务
          <NativeSelect
            aria-label="核对已保存任务"
            value={historyId}
            disabled={busy}
            onChange={(event) => void selectHistory(event.target.value)}
          >
            <option value="">最近完整试算结果</option>
            {view.tasks.map((entry) => (
              <option key={entry.taskId} value={entry.taskId} disabled={active(entry.status)}>
                输入版本 {entry.inputVersion} · {stageName(entry)} · {statuses[entry.status]} ·{' '}
                {savedTime(entry.createdAt)}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}
      {historyReading && <p role="status">正在读取已保存任务…</p>}
      {history && !history.result && (
        <div className={styles.empty}>
          <p>
            {stageName(history)} · 输入版本 {history.inputVersion} · {statuses[history.status]}
          </p>
          {history.error && <p className={styles.error}>{history.error}</p>}
        </div>
      )}
      {result && displayed && (
        <div className={styles.result}>
          <div className={styles.resultHeading}>
            <h3>
              {stageName(displayed)}结果 · 输入版本 {displayed.inputVersion}
            </h3>
            <span>{savedTime(displayed.finishedAt ?? displayed.createdAt)}</span>
          </div>
          {displayed.inputVersion !== scenario.inputVersion && (
            <p className={styles.stale}>
              这是旧输入版本的保存结果，当前输入尚未采用此结果。名称、道路和参数均按原任务快照核对。
            </p>
          )}
          <dl className={styles.metrics}>
            <div>
              <dt>实际完成</dt>
              <dd>
                {tonnes(result.totalCompletedTonnes)}
                <span>吨</span>
              </dd>
            </div>
            <div>
              <dt>运量缺口</dt>
              <dd>
                {tonnes(result.totalMissingTonnes)}
                <span>吨</span>
              </dd>
            </div>
            <div>
              <dt>完整循环</dt>
              <dd>
                {result.trips.length}
                <span>车次</span>
              </dd>
            </div>
            <div>
              <dt>总行驶里程</dt>
              <dd>
                {formatKilometers(energy?.totalDistanceMeters ?? result.totalDistanceMeters)}
                <span>km</span>
              </dd>
            </div>
          </dl>
          {energy && (
            <p className={styles.energySummary}>
              <strong>换电 {energy.swapCount} 次</strong>
              <span>统一电池 {energyNumber(energy.batteryCapacityKwh)} kWh</span>
              <span>首日出发与换入电池均按满电试算</span>
            </p>
          )}
          {result.sharedPower && turnover && displayed && (
            <SharedPowerLedger
              key={`power-${displayed.taskId}`}
              power={result.sharedPower}
              turnover={turnover}
            />
          )}
          {turnover && displayed && (
            <StationTurnoverLedger
              key={displayed.taskId}
              turnover={turnover}
              network={snapshot?.stationNetwork}
            />
          )}
          <section className={styles.block} aria-label="逐车时间轴">
            <h4>逐车时间轴</h4>
            <p className={styles.caption}>
              {energy
                ? '选择车辆，沿作业时间核对换电、SOC 与安全线。'
                : '以作业窗口为时间范围，包含完整循环、装卸、跨线接续及归位。选择车辆核对事件。'}
            </p>
            <ul className={styles.legend}>
              {presentKinds.map((kind) => (
                <li key={kind}>
                  <span className={`${styles.swatch} ${styles[kind]}`} />
                  {kinds[kind]}
                </li>
              ))}
            </ul>
            <div
              className={styles.timelineScroll}
              role="region"
              aria-label="时间轴图表"
              tabIndex={0}
            >
              <div className={`${styles.timeline}${energy ? ` ${styles.energyTimeline}` : ''}`}>
                <div className={styles.axis}>
                  <span>计划车辆</span>
                  <div>
                    {ticks.map((tick) => (
                      <span
                        key={tick}
                        style={{ left: `${((tick - timelineStart) / timelineSpan) * 100}%` }}
                      >
                        {time(tick)}
                      </span>
                    ))}
                  </div>
                </div>
                {result.vehicles.map((vehicle) => {
                  const vehicleEnergy = energyVehicles.get(vehicle.vehicleId);
                  return (
                    <Fragment key={vehicle.vehicleId}>
                      <div className={styles.lane}>
                        <Button
                          className={`${styles.vehicle} ${selectedVehicle?.vehicleId === vehicle.vehicleId ? styles.selectedVehicle : ''}`}
                          aria-pressed={selectedVehicle?.vehicleId === vehicle.vehicleId}
                          onClick={() => setVehicleId(vehicle.vehicleId)}
                        >
                          <strong title={vehicle.vehicleId}>{vehicle.vehicleId}</strong>
                          <span>
                            {vehicle.vehicleGroupName} ·{' '}
                            {minutes(vehicleEnergy?.workingMinutes ?? vehicle.workingMinutes)} 分钟
                          </span>
                        </Button>
                        <div className={styles.track}>
                          {vehicle.shifts.map((shift, index) => (
                            <span
                              key={index}
                              className={styles.shift}
                              style={{
                                left: `${((shift.startMinute - timelineStart) / timelineSpan) * 100}%`,
                                width: `${((shift.endMinute - shift.startMinute) / timelineSpan) * 100}%`,
                              }}
                            />
                          ))}
                          {(vehicleEnergy?.events ?? vehicle.events).map((event) => (
                            <span
                              key={event.id}
                              className={`${styles.event} ${styles[event.kind]}`}
                              style={{
                                left: `${((event.startMinute - timelineStart) / timelineSpan) * 100}%`,
                                width: `${((event.endMinute - event.startMinute) / timelineSpan) * 100}%`,
                              }}
                              title={`${kinds[event.kind]} ${eventTime(event.startMinute)}–${eventTime(event.endMinute)} · ${eventLocation(event)}${'startSocPercent' in event ? ` · SOC ${percent(event.startSocPercent)} → ${percent(event.endSocPercent)}` : ` · ${tonnes(event.loadTonnes)} 吨`}`}
                            />
                          ))}
                        </div>
                      </div>
                      {energy &&
                        vehicleEnergy &&
                        vehicle.vehicleId === selectedVehicle?.vehicleId && (
                          <BatteryTrace
                            vehicle={vehicleEnergy}
                            capacityKwh={energy.batteryCapacityKwh}
                            start={timelineStart}
                            span={timelineSpan}
                          />
                        )}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          </section>
          {selectedVehicle && (
            <section className={styles.block} aria-label="所选车辆事件">
              <div className={styles.subheading}>
                <h4>车辆事件明细</h4>
                <label>
                  计划车辆
                  <NativeSelect
                    value={selectedVehicle.vehicleId}
                    onChange={(event) => setVehicleId(event.target.value)}
                  >
                    {result.vehicles.map((vehicle) => (
                      <option key={vehicle.vehicleId} value={vehicle.vehicleId}>
                        {vehicle.vehicleGroupName} · {vehicle.vehicleId}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              </div>
              <p className={styles.caption}>
                {selectedVehicle.vehicleGroupName} · 载重上限{' '}
                {tonnes(selectedVehicle.payloadTonnes)} 吨 ·{' '}
                {selectedVehicle.returnedToBase ? '已回基准循环起点' : '未归位'} · 作业{' '}
                {minutes(selectedEnergy?.workingMinutes ?? selectedVehicle.workingMinutes)} 分钟 ·{' '}
                {formatKilometers(
                  selectedEnergy?.totalDistanceMeters ?? selectedVehicle.totalDistanceMeters,
                )}{' '}
                km
              </p>
              {selectedEnergy && (
                <>
                  <p className={styles.caption}>
                    电量 {energyNumber(selectedEnergy.initialKwh)} →{' '}
                    {energyNumber(selectedEnergy.finalKwh)} kWh · 安全电量{' '}
                    {energyNumber(selectedEnergy.safetyKwh)} kWh · 行驶耗电{' '}
                    {energyNumber(selectedEnergy.consumedKwh)} kWh
                  </p>
                  <p className={styles.tableHint}>横向滚动可核对时间、里程与耗电。</p>
                </>
              )}
              <div
                className={styles.tableScroll}
                role="region"
                aria-label="车辆事件表格"
                tabIndex={0}
              >
                <table
                  aria-label="车辆事件明细"
                  className={selectedEnergy ? styles.energyTable : undefined}
                >
                  <thead>
                    <tr>
                      <th>事件 / 地点</th>
                      {selectedEnergy && <th className={styles.num}>SOC（起 → 止）</th>}
                      <th className={styles.num}>起止时间</th>
                      <th className={styles.num}>时长（分钟）</th>
                      <th className={styles.num}>载荷 / 作业量（吨）</th>
                      <th className={styles.num}>里程（km）</th>
                      {selectedEnergy && <th className={styles.num}>行驶耗电（kWh）</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedEvents.map((event) => {
                      const charge = 'startSocPercent' in event ? event : null;
                      const stationSwap = stationSwaps.get(event.id);
                      return (
                        <tr key={event.id}>
                          <td>
                            <strong>{kinds[event.kind]}</strong>
                            <span>{eventLocation(event)}</span>
                            <small>
                              {event.kind === 'swap'
                                ? '站型换电服务'
                                : event.durationSource === 'measured'
                                  ? '区间实测'
                                  : event.durationSource === 'speed'
                                    ? '业务速度模板'
                                    : '装卸耗时模板'}
                              {event.allocations.length > 0 ? ` · ${allocationText(event)}` : ''}
                            </small>
                            {charge?.detour && (
                              <small>
                                服务 {eventTime(charge.detour.serviceStartMinute)} 开始 · 换电{' '}
                                {minutes(event.endMinute - charge.detour.serviceStartMinute)} 分钟
                                {stationSwap && ` · 工位 ${stationSwap.bay}`}
                                {charge.detour.serviceStartMinute > event.startMinute &&
                                  ` · ${stationSwap ? '等待' : '等待开放'} ${(stationSwap ? energyNumber : minutes)(charge.detour.serviceStartMinute - event.startMinute)} 分钟`}
                                {stationSwap?.waitReasons.length
                                  ? `（${stationSwap.waitReasons.map((reason) => serviceWaitLabels[reason]).join('、')}）`
                                  : ''}
                                <br />
                                较直达额外行驶 {formatKilometers(charge.detour.extraMeters)} km ·{' '}
                                {minutes(charge.detour.extraMinutes)} 分钟
                              </small>
                            )}
                          </td>
                          {charge && (
                            <td className={styles.num}>
                              {percent(charge.startSocPercent)} → {percent(charge.endSocPercent)}
                              <small>
                                {energyNumber(charge.startKwh)} → {energyNumber(charge.endKwh)} kWh
                              </small>
                            </td>
                          )}
                          <td className={styles.num}>
                            {eventTime(event.startMinute)}–{eventTime(event.endMinute)}
                          </td>
                          <td className={styles.num}>
                            {minutes(event.endMinute - event.startMinute)}
                          </td>
                          <td className={styles.num}>{tonnes(event.loadTonnes)}</td>
                          <td className={styles.num}>{formatKilometers(event.distanceMeters)}</td>
                          {charge && (
                            <td className={styles.num}>
                              {energyNumber(charge.energyKwh)}
                              {charge.energySource !== 'none' && (
                                <small>
                                  {charge.energySource === 'measured'
                                    ? '区间实测耗电'
                                    : '运营模板耗电'}
                                </small>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {selectedEvents.length === 0 && (
                  <p className={styles.empty}>此车未安排运输事件。</p>
                )}
              </div>
            </section>
          )}
          <section className={styles.block} aria-label="完成量与缺口">
            <h4>完成量与缺口</h4>
            <div className={styles.tableScroll}>
              <table aria-label="需求完成量与缺口">
                <thead>
                  <tr>
                    <th>循环 / 装卸需求</th>
                    <th className={styles.num}>需求（吨）</th>
                    <th className={styles.num}>完成（吨）</th>
                    <th className={styles.num}>缺口（吨）</th>
                  </tr>
                </thead>
                <tbody>
                  {result.demands.map((demand) => (
                    <tr key={demand.demandId}>
                      <td>
                        <strong>{cycleName(demand.cycleId)}</strong>
                        <span>
                          {positionName(demand.loadingPositionId)} →{' '}
                          {positionName(demand.unloadingPositionId)}
                        </span>
                        {demand.reason && <small>{demand.reason}</small>}
                      </td>
                      <td className={styles.num}>{tonnes(demand.requestedTonnes)}</td>
                      <td className={styles.num}>{tonnes(demand.completedTonnes)}</td>
                      <td className={styles.num}>{tonnes(demand.missingTonnes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <details className={styles.block}>
            <summary>核对车次与区间载荷</summary>
            {energy && <p>里程与时间为直达业务区间的比较基准。实际绕行与换电见车辆事件明细。</p>}
            <div className={styles.tableScroll}>
              <table aria-label="车次区间载荷">
                <thead>
                  <tr>
                    <th>车次 / 业务区间</th>
                    <th>计划车辆 / 载荷依据</th>
                    <th className={styles.num}>载荷（吨）</th>
                    <th className={styles.num}>里程（km）</th>
                    <th className={styles.num}>时间（分钟）</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trips.flatMap((trip) =>
                    trip.segments.map((segment, index) => (
                      <tr key={`${trip.id}-${index}`}>
                        <td>
                          <strong>
                            {cycleName(trip.cycleId)} · 第 {trip.sequence} 车次
                          </strong>
                          <span>
                            {positionName(segment.fromPositionId)} →{' '}
                            {positionName(segment.toPositionId)}
                          </span>
                        </td>
                        <td>
                          <strong>{trip.vehicleId}</strong>
                          <small>
                            {segment.allocations.length
                              ? segment.allocations
                                  .map((allocation) => `${tonnes(allocation.tonnes)} 吨`)
                                  .join(' + ')
                              : '空载'}{' '}
                            · {segment.durationSource === 'measured' ? '区间实测' : '业务速度'}
                          </small>
                        </td>
                        <td className={styles.num}>{tonnes(segment.loadTonnes)}</td>
                        <td className={styles.num}>{formatKilometers(segment.distanceMeters)}</td>
                        <td className={styles.num}>{minutes(segment.durationMinutes)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </details>
          <details className={styles.block}>
            <summary>
              {turnover
                ? '运输、车辆电量与站内周转校验及适用边界'
                : energy
                  ? '运输与车辆电量校验及适用边界'
                  : '运输校验与适用边界'}
            </summary>
            <p>
              {result.validation.valid
                ? '运输载荷、需求完成量、事件互斥、作业窗口与归位校验通过。'
                : '运输独立校验未通过。'}
            </p>
            <ul>
              {[...result.validation.issues, ...result.limitations].map((issue, index) => (
                <li key={`${index}-${issue}`}>{issue}</li>
              ))}
            </ul>
            {energy ? (
              <>
                <p>独立校验已核对实际行驶、作业窗口、归位及途中安全电量。</p>
                <p>
                  换电绕行限额 · {limitDistance(snapshot?.swapDetourLimits?.maxExtraMeters)} ·{' '}
                  {limitTime(snapshot?.swapDetourLimits?.maxExtraMinutes)}。
                </p>
                {turnover ? (
                  <p>
                    独立校验已核对工位占用、满电库存与站内充电。共享电源及 24 小时周期尚未校核。
                  </p>
                ) : (
                  <p>工位、库存、共享电源及 24 小时周期尚未校核。</p>
                )}
              </>
            ) : (
              <p>补能校核未完成，完整物理可行性尚未建立。</p>
            )}
          </details>
        </div>
      )}
      {!result && !historyReading && !historyId && (
        <div className={styles.empty}>
          <h4>逐车计划待生成</h4>
          <p>补齐试算资料后开始计算，完成后可核对逐车事件、区间载荷和需求缺口。</p>
        </div>
      )}
    </section>
  );
}
