'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  assetCategories,
  assetOwners,
  assetEventNames,
  type AssetCashflowInput,
  type AssetCashflowResult,
  type AssetCashflowView,
  type PlanningScenario,
} from '@haulpath/domain';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { request } from '@/lib/client-request';
import AssetCashflowEditor, { AssetField } from './asset-cashflow-editor';
import { CashflowTable, cashflowMoney } from './operating-cashflow-ledger';
import styles from './operating-cashflows.module.css';

const boundaryName = (v: AssetCashflowInput['boundary']) =>
  v === 'integrated' ? '一体化' : v === 'station-only' ? '仅站方' : '待选择业务边界';
export default function AssetCashflows({
  scenario,
  disabled,
  onChange,
  onWritingChange,
  onEditingChange,
}: {
  scenario: PlanningScenario;
  disabled: boolean;
  onChange: (scenario: PlanningScenario) => void;
  onWritingChange: (v: boolean) => void;
  onEditingChange: (v: boolean) => void;
}) {
  const path = `/api/projects/${encodeURIComponent(scenario.projectId)}/scenarios/${encodeURIComponent(scenario.id)}/asset-cashflows`;
  const [view, setView] = useState<AssetCashflowView | null>(null);
  const [draft, setDraft] = useState<AssetCashflowInput | null>(null);
  const [historyId, setHistoryId] = useState('');
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(false),
    writing = useRef(false),
    reads = useRef(0);
  useEffect(() => {
    const lifecycle = reads;
    const read = ++lifecycle.current;
    alive.current = true;
    void request<AssetCashflowView>(path)
      .then((next) => {
        if (alive.current && read === lifecycle.current) {
          setView(next);
          setError('');
        }
      })
      .catch((e) => {
        if (alive.current && read === lifecycle.current) setError((e as Error).message);
      });
    return () => {
      alive.current = false;
      lifecycle.current++;
    };
  }, [path, scenario.inputVersion, refresh]);
  useEffect(() => {
    if (!draft) return;
    const protect = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [draft]);
  function edit(value: AssetCashflowInput | null) {
    setDraft(value);
    onEditingChange(value !== null);
    setError('');
    setNotice('');
  }
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
        const saved = await request<PlanningScenario>(path, 'PUT', {
          expectedRevision: scenario.revision,
          input: draft,
        });
        if (!alive.current) return;
        edit(null);
        onChange(saved);
        setHistoryId('');
        setNotice('资产与资金已保存，历史账目保留。');
      } else {
        const result = await request<AssetCashflowResult>(path, 'POST', {
          expectedRevision: scenario.revision,
        });
        if (!alive.current) return;
        setView((v) => ({
          inputVersion: scenario.inputVersion,
          issues: v?.issues ?? [],
          results: [result, ...(v?.results ?? [])],
        }));
        setHistoryId(result.id);
        setSelectedYear(result.years[0]?.year ?? null);
        setNotice(
          result.complete ? '资产资本收付已核对。' : '已保留逐项账目，请补齐缺口后重新核对。',
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
    <section className={styles.section} aria-label="方案资产与资本收付">
      <div className={styles.heading}>
        <div>
          <h3>资产与资本收付</h3>
          <p>
            {boundaryName(scenario.context.assetCashflows?.boundary ?? null)} · 当前输入版本{' '}
            {scenario.inputVersion}
          </p>
        </div>
        <Button
          className="text-button"
          disabled={busy || !!draft}
          onClick={() => setRefresh((v) => v + 1)}
        >
          <RefreshCw />
          刷新资产账目
        </Button>
      </div>
      <p className={styles.help}>
        独立维护初始投资、设备更换、处置残值及营运资金。历史购置不重复列支，站网投资只对账一次。
        <strong>未校核折旧、税费、融资及 NPV</strong>
        ；本账目不表示项目或股权现金流，也不改变物理可行状态。
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
        <AssetCashflowEditor
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
                    scenario.context.assetCashflows ?? {
                      boundary: null,
                      initialYear: null,
                      years: [],
                      scopeSource: '',
                      assets: [],
                      workingCapital: [],
                      overrides: [],
                    },
                  ),
                )
              }
            >
              编辑资产与资金
            </Button>
            <Button
              className="button primary"
              disabled={disabled || busy || !scenario.context.assetCashflows}
              onClick={() => void mutate('calculate')}
            >
              {busy ? '核对中…' : '核对资本收付'}
            </Button>
          </div>
          <details className={styles.trace}>
            <summary>已保存资产依据与资料缺口</summary>
            {view?.issues.length ? (
              <ul className={styles.issues}>
                {view.issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            ) : (
              <p>逐项金额、预算及余额连续性在核对时检查。</p>
            )}
            <p>{scenario.context.assetCashflows?.scopeSource || '范围依据待填写'}</p>
            <CashflowTable
              label="已保存分类资产"
              numericColumns={[4]}
              columns={['资产', '分类', '归属', '取得方式', '取得金额（元）', '来源及范围']}
              rows={(scenario.context.assetCashflows?.assets ?? []).map((a) => [
                a.name,
                assetCategories[a.category],
                a.owner ? assetOwners[a.owner] : '未知',
                a.acquisition === 'existing'
                  ? '历史依据，不列初始支出'
                  : a.acquisition === 'new'
                    ? '本次新增'
                    : '未知',
                a.amount ?? '未知',
                `${a.source}；${a.notes}`,
              ])}
            />
          </details>
        </>
      )}
      {displayed ? (
        <section className={styles.result} aria-label="资本收付结果">
          <div className={styles.heading}>
            <h4>
              {boundaryName(displayed.input.boundary)} ·{' '}
              {displayed.complete ? '资产资本收付完整' : '资产资本收付不完整'}
            </h4>
            <span>
              {displayed.inputVersion === scenario.inputVersion
                ? `本版输入 ${displayed.inputVersion}`
                : `历史输入版本 ${displayed.inputVersion}，当前版本已变化`}
            </span>
          </div>
          <AssetField label="历史资产账目">
            <NativeSelect
              aria-label="历史资产账目"
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
          </AssetField>
          <p className={styles.help}>
            建设年份 {displayed.input.initialYear ?? '未知'} · 评价年份{' '}
            {displayed.input.years.join('、')} · {displayed.policy}
            。账目采用本版资产和完整站网快照，不自动引入其他版本资料。
          </p>
          {displayed.issues.length > 0 && (
            <ul className={styles.issues}>
              {displayed.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
          <CashflowTable
            label="逐年资本收付汇总"
            numericColumns={[1, 2, 3, 4, 5, 6, 7]}
            columns={[
              '年份',
              '初始投资（元）',
              '更换投资（元）',
              '处置/残值（元）',
              '资金增加/释放（元）',
              '流出（元）',
              '流入（元）',
              '资本余额（元）',
              '资料状态',
            ]}
            rows={displayed.years.map((y) => [
              <Button
                key={y.year}
                className="text-button"
                aria-pressed={year?.year === y.year}
                onClick={() => setSelectedYear(y.year)}
              >
                核对 {y.year} 年资本
              </Button>,
              cashflowMoney(y.investmentCents),
              cashflowMoney(y.replacementCents),
              `${cashflowMoney(y.disposalCents)} / ${cashflowMoney(y.residualCents)}`,
              `${cashflowMoney(y.workingCapitalIncreaseCents)} / ${cashflowMoney(y.workingCapitalReleaseCents)}`,
              cashflowMoney(y.outflowCents),
              cashflowMoney(y.inflowCents),
              cashflowMoney(y.balanceCents),
              y.complete ? '资本账目完整' : y.issues.join('；'),
            ])}
          />
          <details className={styles.trace}>
            <summary>站网预算与分类资产对账（不再扣款）</summary>
            <p>
              完整建站配置包括备电池等必要投入，接电工程另列；按每个站址对账全部承担方的本次新增资产。更换、车辆及营运资金不计入选址上限。差额或缺价须显式修复，财务替代不改变站网硬约束。
            </p>
            <CashflowTable
              label="站网投资对账"
              numericColumns={[2, 3, 4]}
              columns={['站址', '预算项目', '站网预算（元）', '分类资产（元）', '差额（元）']}
              rows={displayed.reconciliation.map((r) => [
                r.siteName,
                r.bucket === 'station' ? '完整建站配置' : '接电工程',
                cashflowMoney(r.budgetCents),
                cashflowMoney(r.classifiedCents),
                cashflowMoney(r.differenceCents),
              ])}
            />
          </details>
          {year && (
            <section className={styles.yearResult} aria-label={`${year.year} 年资本明细`}>
              <h4>{year.year} 年资本明细</h4>
              <CashflowTable
                label={`${year.year} 年资产收付`}
                numericColumns={[4, 5]}
                columns={[
                  '资产',
                  '分类及归属',
                  '收付项目',
                  '边界',
                  '基准金额（元）',
                  '采用金额（元）',
                  '来源及替代依据',
                ]}
                rows={year.events.map((e) => [
                  e.name,
                  `${assetCategories[e.category]} · ${e.owner ? assetOwners[e.owner] : '未知'}`,
                  assetEventNames[e.kind],
                  e.included ? '纳入' : '边界外',
                  e.baseAmount ?? '未知',
                  cashflowMoney(e.amountCents),
                  e.override
                    ? `${e.source}；替代：${e.override.reason}；${e.override.source}`
                    : e.source,
                ])}
              />
              <CashflowTable
                label={`${year.year} 年营运资金`}
                numericColumns={[2, 3, 4, 5]}
                columns={[
                  '归属',
                  '边界',
                  '期初余额（元）',
                  '期末余额（元）',
                  '增加（元）',
                  '释放（元）',
                  '来源',
                ]}
                rows={year.workingCapital.map((w) => [
                  assetOwners[w.owner],
                  w.included ? '纳入' : '边界外',
                  cashflowMoney(w.openingCents),
                  cashflowMoney(w.closingCents),
                  cashflowMoney(w.increaseCents),
                  cashflowMoney(w.releaseCents),
                  w.source,
                ])}
              />
            </section>
          )}
          <details className={styles.trace}>
            <summary>资产取得与投运依据</summary>
            <p>{displayed.input.scopeSource}</p>
            <CashflowTable
              label="采用资产依据"
              numericColumns={[2, 3]}
              columns={['资产', '取得方式', '投运年份', '历史取得金额（元）', '资产范围及来源']}
              rows={displayed.assets.map((a) => [
                a.name,
                a.acquisition === 'existing' ? '历史已发生（不列初始现金流）' : '本次新增',
                a.serviceYear ?? '未知',
                cashflowMoney(a.historicalCostCents),
                `${a.notes}；${a.source}`,
              ])}
            />
          </details>
        </section>
      ) : (
        <p className={styles.empty}>尚无资本收付账目。保存资产及资金安排后即可独立核对。</p>
      )}
    </section>
  );
}
