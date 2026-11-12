'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RefreshCw, Square } from 'lucide-react';
import {
  PLANNING_NOTICE,
  formatKilometers,
  strategyGroups,
  strategyLabels,
  type PlanningScenario,
  type RoadPreparationView,
  type RoadTaskStatus,
  type RoadUse,
  type Strategy,
} from '@haulpath/domain';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { request } from '@/lib/client-request';
import styles from './directed-road-data.module.css';

const taskLabels: Record<RoadTaskStatus, string> = {
  queued: '等待准备',
  running: '正在准备',
  completed: '准备完成',
  stopped: '已停止',
  failed: '准备失败',
  'timed-out': '准备超时',
  interrupted: '服务中断',
  superseded: '输入已更新',
};
const useLabels: Record<RoadUse['kind'], string> = {
  business: '业务区间',
  'station-entry': '进站',
  'station-exit': '出站',
  continuation: '跨线接续',
};
const sourceLabels = {
  amap: '高德普通驾车',
  'cycle-snapshot': '已引入循环快照',
  'same-location': '同坐标，无需行驶',
};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '读取或准备道路失败，请重试。';
const displayTime = (time: string) =>
  new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const activeTask = (status?: RoadTaskStatus) => status === 'queued' || status === 'running';

export default function DirectedRoadData({
  scenario,
  disabled,
  onChange,
  onWritingChange,
  onViewChange,
}: {
  scenario: PlanningScenario;
  disabled: boolean;
  onChange: (scenario: PlanningScenario) => void;
  onWritingChange: (writing: boolean) => void;
  onViewChange: (view: RoadPreparationView | null) => void;
}) {
  const path = `/api/projects/${encodeURIComponent(scenario.projectId)}/scenarios/${encodeURIComponent(scenario.id)}`;
  const [now, setNow] = useState(0);
  const [view, setView] = useState<RoadPreparationView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(true);
  const alive = useRef(false);
  const reads = useRef(0);
  const writing = useRef(false);
  const currentRequest = useRef<AbortController | null>(null);
  const task = view?.task;
  const running = activeTask(task?.status);
  const roadElapsed =
    task?.startedAt && task.status !== 'interrupted'
      ? Math.max(
          0,
          (task.finishedAt ? Date.parse(task.finishedAt) : now || Date.parse(task.startedAt)) -
            Date.parse(task.startedAt),
        )
      : null;
  const current = view?.inputVersion === scenario.inputVersion;
  const ready = current && view.currentReady && view.total > 0;
  const frozen = scenario.status === 'frozen';

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const refresh = useCallback(async () => {
    if (writing.current) return;
    currentRequest.current?.abort();
    const controller = new AbortController();
    currentRequest.current = controller;
    const read = ++reads.current;
    try {
      const next = await request<RoadPreparationView>(
        `${path}/roads`,
        'GET',
        undefined,
        controller.signal,
      );
      if (!alive.current || read !== reads.current) return;
      setView(next);
      onViewChange(next);
      setError('');
    } catch (failure) {
      if (!alive.current || read !== reads.current || controller.signal.aborted) return;
      setError(errorMessage(failure));
    } finally {
      if (alive.current && read === reads.current) setReading(false);
    }
  }, [path, onViewChange]);

  useEffect(() => {
    alive.current = true;
    // The effect subscribes to persisted HTTP data; refresh writes state only after awaiting it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    return () => {
      alive.current = false;
      currentRequest.current?.abort();
    };
  }, [refresh, scenario.inputVersion, scenario.revision]);

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let timer: number;
    async function poll() {
      await refresh();
      if (!stopped) timer = window.setTimeout(() => void poll(), 800);
    }
    timer = window.setTimeout(() => void poll(), 800);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [refresh, running]);

  async function mutate(operation: 'start' | 'stop' | 'settings', strategy?: Strategy) {
    if (writing.current || disabled || frozen) return;
    writing.current = true;
    reads.current++;
    currentRequest.current?.abort();
    setBusy(true);
    setReading(false);
    setError('');
    onWritingChange(true);
    try {
      if (operation === 'settings') {
        const saved = await request<PlanningScenario>(`${path}/road-settings`, 'PUT', {
          expectedRevision: scenario.revision,
          continuationStrategy: strategy,
        });
        if (alive.current) onChange(saved);
      } else {
        const next = await request<RoadPreparationView>(
          operation === 'stop' ? `${path}/roads/${task!.taskId}/stop` : `${path}/roads`,
          'POST',
          operation === 'start' ? { expectedRevision: scenario.revision } : undefined,
        );
        if (alive.current) {
          setView(next);
          onViewChange(next);
        }
      }
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure));
    } finally {
      writing.current = false;
      if (alive.current) {
        setBusy(false);
        onWritingChange(false);
      }
    }
  }

  const prepared = new Map(view?.roads.map((road) => [road.key, road]));
  const count = current ? view.completed : null;
  const total = current ? view.total : null;
  return (
    <section className={styles.section} aria-label="方案有向道路资料">
      <header className={styles.heading}>
        <div>
          <h3>有向道路资料</h3>
          <p>准备业务区间、候选站址进出与跨线接续道路，按方向和偏好复用。</p>
        </div>
        <Button
          className="text-button"
          disabled={busy || reading}
          onClick={() => {
            setReading(true);
            void refresh();
          }}
          aria-label="刷新道路资料"
        >
          <RefreshCw aria-hidden="true" />
          刷新
        </Button>
      </header>
      <div className={styles.settings}>
        <label>
          <span>跨线接续驾车偏好</span>
          <NativeSelect
            aria-label="跨线接续驾车偏好"
            value={scenario.context.roadSettings?.continuationStrategy ?? 32}
            disabled={disabled || frozen || busy}
            onChange={(event) => void mutate('settings', Number(event.target.value) as Strategy)}
          >
            {strategyGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </NativeSelect>
        </label>
        <p>选择后保存到本方案。业务区间与进出站沿用循环偏好，不改变项目偏好记忆。</p>
      </div>
      <div className={styles.status} aria-live="polite">
        <div className={styles.statusHeading}>
          <strong className={ready ? styles.ready : undefined}>
            {reading && !view
              ? '正在读取道路资料…'
              : !view
                ? '尚未读取到道路资料'
                : !current
                  ? '输入已变化，请刷新方案'
                  : ready
                    ? '道路矩阵完整就绪'
                    : total === 0
                      ? '尚无待准备道路'
                      : '道路资料待完善'}
          </strong>
          <span className={styles.count}>
            {count === null ? '—' : count} / {total === null ? '—' : total} 条已准备
          </span>
        </div>
        {total !== null && total > 0 && (
          <progress
            className={styles.progress}
            value={count ?? 0}
            max={total}
            aria-label="当前输入道路准备进度"
          />
        )}
        <div className={styles.actions}>
          <Button
            className="button"
            disabled={disabled || frozen || busy || reading || !current || total === 0 || running}
            onClick={() => void mutate('start')}
          >
            <Play aria-hidden="true" />
            {ready ? '复用道路并核对' : '准备缺失道路'}
          </Button>
          {running && (
            <Button
              className="button"
              disabled={disabled || frozen || busy}
              onClick={() => void mutate('stop')}
            >
              <Square aria-hidden="true" />
              停止道路准备
            </Button>
          )}
        </div>
        {frozen ? (
          <p>冻结版本只读。复制为新草案后可继续准备道路。</p>
        ) : total === 0 ? (
          <p>先引入运输循环，再准备对应的道路资料。</p>
        ) : (
          <p>关闭页面后任务继续运行，重新打开可查看进度。</p>
        )}
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {task && (
        <div className={styles.task}>
          <p>
            {task.status === 'queued'
              ? '排队等待，尚未开始计时'
              : roadElapsed === null
                ? '服务中断，未记录完整道路运行耗时'
                : `道路准备耗时 ${(roadElapsed / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 秒，不计入搜索预算`}
          </p>
          <div className={styles.statusHeading}>
            <strong>{taskLabels[task.status]}</strong>
            <span>任务输入版本 {task.inputVersion}</span>
          </div>
          <p>
            已准备 {task.completed} / {task.total} 条，复用 {task.reused} 条
          </p>
          {task.inputVersion !== scenario.inputVersion && (
            <p>此任务保留旧版资料，当前输入需另行准备。</p>
          )}
          {task.error && (
            <p className={styles.error} role="alert">
              {task.error}
            </p>
          )}
          <details className={styles.record}>
            <summary>任务依据与记录</summary>
            <dl>
              <div>
                <dt>任务标识</dt>
                <dd>{task.taskId}</dd>
              </div>
              <div>
                <dt>输入依据</dt>
                <dd>
                  输入版本 {task.inputVersion} · 修订 {task.snapshot.revision}
                </dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{displayTime(task.createdAt)}</dd>
              </div>
              {task.finishedAt && (
                <div>
                  <dt>结束时间</dt>
                  <dd>{displayTime(task.finishedAt)}</dd>
                </div>
              )}
            </dl>
          </details>
        </div>
      )}
      {view && view.requirements.length > 0 && (
        <details className={styles.roads}>
          <summary>核对有向道路（{view.requirements.length} 条）</summary>
          <ol className={styles.list}>
            {view.requirements.map((requirement) => {
              const road = prepared.get(requirement.key);
              const kinds = [...new Set(requirement.uses.map((use) => useLabels[use.kind]))];
              return (
                <li key={requirement.key}>
                  <div className={styles.roadHeading}>
                    <strong>
                      {requirement.from.name} → {requirement.to.name}
                    </strong>
                    <span className={styles.distance}>
                      {road ? `${formatKilometers(road.distanceMeters)} km` : '待准备'}
                    </span>
                  </div>
                  <p>
                    {kinds.join(' / ')} · {strategyLabels[requirement.strategy]}
                  </p>
                  <p>
                    {road
                      ? `${road.distanceMeters.toLocaleString('zh-CN')} 米 · ${sourceLabels[road.source]}`
                      : '缺少匹配方向、坐标和偏好的道路资料'}
                  </p>
                  <details className={styles.basis}>
                    <summary>坐标与来源依据</summary>
                    <p>
                      起点 {requirement.from.longitude}, {requirement.from.latitude}
                    </p>
                    <p>
                      终点 {requirement.to.longitude}, {requirement.to.latitude}
                    </p>
                    {road && <p>资料保存于 {displayTime(road.preparedAt)}</p>}
                  </details>
                </li>
              );
            })}
          </ol>
        </details>
      )}
      <p className={styles.boundary}>
        {PLANNING_NOTICE}。道路齐全仅表示资料已备，不表示运输、换电或供电校核通过。
      </p>
    </section>
  );
}
