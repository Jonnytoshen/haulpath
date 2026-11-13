'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  operatingFlows,
  operatingBases,
  type DailyTransportView,
  type OperatingCashflowInput,
  type OperatingCashflowResult,
  type OperatingCashflowView,
  type PlanningScenario,
} from '@haulpath/domain';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { request } from '@/lib/client-request';
import OperatingCashflowEditor, { emptyOperatingYear } from './operating-cashflow-editor';
import { CashflowTable, cashflowMoney, OperatingYearLedger } from './operating-cashflow-ledger';
import styles from './operating-cashflows.module.css';

const taskStatus: Record<string, string> = {
  completed: '评价结束',
  stopped: '已停止',
  interrupted: '服务中断',
  'timed-out': '已达时限',
  failed: '失败',
  superseded: '输入已变化',
};
const boundaryName = (value: OperatingCashflowInput['boundary']) =>
  value === 'integrated' ? '一体化' : value === 'station-only' ? '仅站方' : '待选择业务边界';
export default function OperatingCashflows({
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
  const path = `/api/projects/${encodeURIComponent(scenario.projectId)}/scenarios/${encodeURIComponent(scenario.id)}`;
  const [view, setView] = useState<OperatingCashflowView | null>(null);
  const [transport, setTransport] = useState<DailyTransportView | null>(null);
  const [draft, setDraft] = useState<OperatingCashflowInput | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [historyId, setHistoryId] = useState('');
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const writing = useRef(false);
  const reads = useRef(0);
  const load = useCallback(async () => {
    const read = ++reads.current;
    try {
      const [next, annual] = await Promise.all([
        request<OperatingCashflowView>(`${path}/operating-cashflows`),
        request<DailyTransportView>(`${path}/annual-transport`),
      ]);
      if (alive.current && read === reads.current) {
        setView(next);
        setTransport(annual);
        setError('');
      }
    } catch (e) {
      if (alive.current && read === reads.current) setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    const lifecycle = reads;
    const read = ++lifecycle.current;
    alive.current = true;
    async function readView() {
      try {
        const [next, annual] = await Promise.all([
          request<OperatingCashflowView>(`${path}/operating-cashflows`),
          request<DailyTransportView>(`${path}/annual-transport`),
        ]);
        if (alive.current && read === lifecycle.current) {
          setView(next);
          setTransport(annual);
          setError('');
        }
      } catch (error) {
        if (alive.current && read === lifecycle.current) setError((error as Error).message);
      }
    }
    void readView();
    return () => {
      alive.current = false;
      lifecycle.current++;
    };
  }, [path, scenario.inputVersion]);
  useEffect(() => {
    if (!draft) return;
    const protect = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [draft]);
  function edit(input: OperatingCashflowInput | null) {
    setDraft(input);
    onEditingChange(input !== null);
    setError('');
    setNotice('');
  }
  const tasks = transport?.tasks.filter((t) => !['queued', 'running'].includes(t.status)) ?? [];
  const chosenSource =
    sourceId || tasks.find((t) => (t.annualProgress?.validatedYears ?? 0) > 0)?.taskId || '';
  const displayed =
    view?.results.find((r) => r.id === historyId) ??
    view?.results.find((r) => r.inputVersion === scenario.inputVersion) ??
    view?.results[0];
  const year = displayed?.years.find((y) => y.year === selectedYear) ?? displayed?.years[0];
  async function mutate(action: 'save' | 'calculate') {
    if (writing.current) return;
    writing.current = true;
    reads.current++;
    setBusy(true);
    onWritingChange(true);
    setError('');
    setNotice('');
    try {
      if (action === 'save') {
        const saved = await request<PlanningScenario>(`${path}/operating-cashflows`, 'PUT', {
          expectedRevision: scenario.revision,
          input: draft,
        });
        if (!alive.current) return;
        edit(null);
        onChange(saved);
        setHistoryId('');
        setNotice('运营收支已保存，历史账目保留。');
      } else {
        const result = await request<OperatingCashflowResult>(
          `${path}/operating-cashflows`,
          'POST',
          { expectedRevision: scenario.revision, sourceTaskId: chosenSource },
        );
        if (!alive.current) return;
        setView((v) =>
          v
            ? { ...v, results: [result, ...v.results] }
            : {
                projectId: scenario.projectId,
                scenarioId: scenario.id,
                inputVersion: scenario.inputVersion,
                issues: [],
                results: [result],
              },
        );
        setHistoryId(result.id);
        setSelectedYear(result.years[0]?.year ?? null);
        setNotice(
          result.complete ? '年度运营收支已核对。' : '已保留可核对的年度账目，请补齐缺失资料。',
        );
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      writing.current = false;
      if (alive.current) {
        setBusy(false);
        onWritingChange(false);
      }
    }
  }
  return (
    <section className={styles.section} aria-label="方案年度运营收支">
      <div className={styles.heading}>
        <div>
          <h3>年度运营收支</h3>
          <p>
            {boundaryName(scenario.context.operatingCashflows?.boundary ?? null)} · 当前输入版本{' '}
            {scenario.inputVersion}
          </p>
        </div>
        <Button className="text-button" disabled={busy || !!draft} onClick={() => void load()}>
          <RefreshCw />
          刷新收支状态
        </Button>
      </div>
      <p className={styles.help}>
        以实际运输、空驶、换电和分时购电账目核对收入与费用。<strong>未校核税费、投资及融资</strong>
        ，运营余额不表示项目或股权现金流、NPV 或投资可行。
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {draft ? (
        <OperatingCashflowEditor
          draft={draft}
          context={scenario.context}
          busy={busy}
          onChange={setDraft}
          onSave={() => void mutate('save')}
          onCancel={() => edit(null)}
        />
      ) : (
        <>
          <div className={styles.actions}>
            <Button
              className="button"
              disabled={disabled || busy}
              onClick={() =>
                edit(
                  structuredClone(
                    scenario.context.operatingCashflows ?? {
                      boundary: null,
                      years: (scenario.context.annualTransport ?? []).map((y) =>
                        emptyOperatingYear(y.year),
                      ),
                    },
                  ),
                )
              }
            >
              编辑运营收支
            </Button>
            <span>按年保存独立价格；本站网和车队仍由年度能力校核。</span>
          </div>
          <details className={styles.trace}>
            <summary>已保存的价格与资料缺口</summary>
            {view?.issues.length ? (
              <ul className={styles.issues}>
                {view.issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            ) : (
              <p>基本输入已保存，具体电价覆盖及年度证据在核对时检查。</p>
            )}
            <CashflowTable
              label="已保存运营价格"
              columns={['年份', '项目', '归属', '单位', '单价', '来源']}
              rows={(scenario.context.operatingCashflows?.years ?? []).flatMap((y) =>
                y.lines.map((l) => [
                  y.year,
                  l.name,
                  operatingFlows[l.flow],
                  operatingBases[l.basis],
                  l.rate ?? '未知',
                  l.source || '缺来源',
                ]),
              )}
            />
          </details>
          <div className={styles.adoption}>
            <label className={styles.field}>
              采用的年度任务
              <NativeSelect
                aria-label="采用的年度任务"
                value={chosenSource}
                disabled={busy}
                onChange={(e) => setSourceId(e.target.value)}
              >
                <option value="">选择已结束的年度任务</option>
                {tasks.map((t) => (
                  <option key={t.taskId} value={t.taskId}>
                    输入版本 {t.inputVersion} · {taskStatus[t.status] ?? t.status} ·{' '}
                    {t.annualProgress?.validatedYears ?? 0} 年证据 · {t.taskId}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <p className={styles.help}>
              点击核对即显式采用所选任务保存的实际道路和年度证据。价格变化后会检查全部物理输入等价；物理输入有变化时须重新校核。单次结果只使用同一任务，不拼接不同年度任务。
            </p>
            <Button
              className="button primary"
              disabled={disabled || busy || !chosenSource || !scenario.context.operatingCashflows}
              onClick={() => void mutate('calculate')}
            >
              {busy ? '核对中…' : '核对运营收支'}
            </Button>
          </div>
        </>
      )}
      {displayed && (
        <section className={styles.result} aria-label="运营收支结果">
          <div className={styles.heading}>
            <h4>
              {boundaryName(displayed.input.boundary)} ·{' '}
              {displayed.complete ? '运营收支完整' : '运营收支不完整'}
            </h4>
            <span>
              {displayed.inputVersion === scenario.inputVersion
                ? `本版输入 ${displayed.inputVersion}`
                : `历史输入版本 ${displayed.inputVersion}，当前版本已变化`}
            </span>
          </div>
          <label className={styles.field}>
            历史收支账目
            <NativeSelect
              aria-label="历史收支账目"
              value={displayed.id}
              disabled={busy}
              onChange={(e) => {
                setHistoryId(e.target.value);
                setSelectedYear(null);
              }}
            >
              {view?.results.map((r) => (
                <option key={r.id} value={r.id}>
                  版本 {r.inputVersion} · {boundaryName(r.input.boundary)} ·{' '}
                  {new Date(r.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </option>
              ))}
            </NativeSelect>
          </label>
          <p className={styles.help}>
            来源年度任务 {displayed.sourceTaskId} · 物理输入版本 {displayed.sourceInputVersion} ·{' '}
            {displayed.sourceComplete ? '多年证据完整' : '仅保留部分成果'}
            。本结果绑定项目、方案、输入版本及价格快照。
          </p>
          {displayed.issues.length > 0 && (
            <ul className={styles.issues}>
              {displayed.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
          <CashflowTable
            label="逐年运营收支汇总"
            columns={['年份', '运营天数', '收入（元）', '支出（元）', '运营余额（元）', '资料状态']}
            rows={displayed.years.map((y) => [
              <Button
                key={y.year}
                className="text-button"
                aria-pressed={year?.year === y.year}
                onClick={() => setSelectedYear(y.year)}
              >
                核对 {y.year} 年收支
              </Button>,
              y.operatingDays,
              cashflowMoney(y.incomeCents),
              cashflowMoney(y.expenseCents),
              cashflowMoney(y.balanceCents),
              y.complete ? '运营账目完整' : y.issues.join('；'),
            ])}
          />
          {year && <OperatingYearLedger result={displayed} year={year} />}
        </section>
      )}
      {!displayed && (
        <p className={styles.empty}>
          尚无运营收支账目。保存价格后，选择年度任务并核对；缺失资料会逐年列出。
        </p>
      )}
    </section>
  );
}
