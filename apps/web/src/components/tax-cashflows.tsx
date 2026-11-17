'use client';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  taxTargets,
  taxPaymentNames,
  taxPricingNames,
  taxCreditNames,
  assetCategories,
  type PlanningScenario,
  type TaxCashflowInput,
  type TaxCashflowView,
  type TaxCashflowResult,
  type OperatingCashflowView,
  type AssetCashflowView,
} from '@haulpath/domain';
import { request } from '@/lib/client-request';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { AssetField } from './asset-cashflow-editor';
import TaxCashflowEditor, { emptyTaxInput, extendTaxInput } from './tax-cashflow-editor';
import { CashflowTable, cashflowMoney as money } from './operating-cashflow-ledger';
import ScenarioInputValue, { scenarioInputNames } from './scenario-input-value';
import styles from './operating-cashflows.module.css';
import taxStyles from './tax-cashflows.module.css';

export default function TaxCashflows({
  scenario,
  disabled,
  onChange,
  onWritingChange,
  onEditingChange,
}: {
  scenario: PlanningScenario;
  disabled: boolean;
  onChange: (s: PlanningScenario) => void;
  onWritingChange: (v: boolean) => void;
  onEditingChange: (v: boolean) => void;
}) {
  const base = `/api/projects/${encodeURIComponent(scenario.projectId)}/scenarios/${encodeURIComponent(scenario.id)}`;
  const path = `${base}/tax-cashflows`;
  const [view, setView] = useState<TaxCashflowView | null>(null);
  const [operating, setOperating] = useState<OperatingCashflowView | null>(null);
  const [assets, setAssets] = useState<AssetCashflowView | null>(null);
  const [operatingId, setOperatingId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [draft, setDraft] = useState<TaxCashflowInput | null>(null);
  const [historyId, setHistoryId] = useState('');
  const [yearNumber, setYearNumber] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(false),
    writing = useRef(false),
    reads = useRef(0);
  useEffect(() => {
    const lifecycle = reads,
      read = ++lifecycle.current;
    alive.current = true;
    void Promise.all([
      request<TaxCashflowView>(path),
      request<OperatingCashflowView>(`${base}/operating-cashflows`),
      request<AssetCashflowView>(`${base}/asset-cashflows`),
    ])
      .then(([v, o, a]) => {
        if (alive.current && read === lifecycle.current) {
          setView(v);
          setOperating(o);
          setAssets(a);
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
  }, [base, path, scenario.inputVersion, refresh]);
  useEffect(() => {
    if (!draft) return;
    const protect = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [draft]);
  function edit(value: TaxCashflowInput | null) {
    setDraft(value);
    onEditingChange(value !== null);
    setError('');
    setNotice('');
  }
  const op = operating?.results.find((r) => r.id === operatingId);
  const cap = assets?.results.find((r) => r.id === assetId);
  const targets = op && cap ? taxTargets(op, cap) : [];
  const inputNames = {
    ...scenarioInputNames(scenario.context),
    ...Object.fromEntries(targets.map((target) => [target.key, `${target.year} · ${target.name}`])),
  };
  const displayed =
    view?.results.find((r) => r.id === historyId) ??
    view?.results.find((r) => r.inputVersion === scenario.inputVersion) ??
    view?.results[0];
  const year = displayed?.years.find((y) => y.year === yearNumber) ?? displayed?.years[0];
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
        setNotice('税务规则已保存，历史账目保留。');
        setRefresh((v) => v + 1);
      } else {
        const result = await request<TaxCashflowResult>(path, 'POST', {
          expectedRevision: scenario.revision,
          operatingResultId: operatingId,
          assetResultId: assetId,
        });
        if (!alive.current) return;
        setView((v) => ({
          inputVersion: scenario.inputVersion,
          issues: v?.issues ?? [],
          results: [result, ...(v?.results ?? [])],
        }));
        setHistoryId(result.id);
        setNotice(
          result.complete
            ? '税费与项目现金流已核对。'
            : '已保留不完整账目，请补齐列出的规则或依据。',
        );
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      className={`${styles.section} ${taxStyles.section}`}
      role="region"
      aria-label="方案税费与项目现金流"
    >
      <div className={styles.heading}>
        <h3>税费与项目现金流</h3>
        <Button variant="ghost" disabled={busy || !!draft} onClick={() => setRefresh((v) => v + 1)}>
          <RefreshCw aria-hidden="true" />
          刷新税务账目
        </Button>
      </div>
      <p className={styles.help}>
        当前输入版本 {scenario.inputVersion} ·{' '}
        {scenario.context.assetCashflows?.boundary === 'integrated'
          ? '一体化'
          : scenario.context.assetCashflows?.boundary === 'station-only'
            ? '仅站方'
            : '待统一业务边界'}{' '}
        · 项目口径
      </p>
      <p className={styles.help}>
        显式采用实际运营与资产收付，逐年核对价税、折旧及亏损结转。折旧不重复扣现金，亏损不自动退税。
        <strong>融资、股权现金流与 NPV 仍待独立校核。</strong>
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
      <div className={styles.adoption}>
        <h4>采用账目依据</h4>
        <p className={styles.help}>
          选择同方案完整账目。纯税务变更可沿用等价旧证据；来源或物理输入变化须重新核对。
        </p>
        <div className={styles.fields}>
          <AssetField label="采用运营账目">
            <NativeSelect
              aria-label="采用运营账目"
              disabled={busy || !!draft || disabled}
              value={operatingId}
              onChange={(e) => setOperatingId(e.target.value)}
            >
              <option value="">请选择运营账目</option>
              {operating?.results.map((r) => (
                <option key={r.id} value={r.id} disabled={!r.complete}>
                  版本 {r.inputVersion} · {r.input.boundary === 'integrated' ? '一体化' : '仅站方'}{' '}
                  · {r.complete ? '完整' : '不完整'} ·{' '}
                  {new Date(r.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </option>
              ))}
            </NativeSelect>
          </AssetField>
          <AssetField label="采用资产账目">
            <NativeSelect
              aria-label="采用资产账目"
              disabled={busy || !!draft || disabled}
              value={assetId}
              onChange={(e) => setAssetId(e.target.value)}
            >
              <option value="">请选择资产账目</option>
              {assets?.results.map((r) => (
                <option key={r.id} value={r.id} disabled={!r.complete}>
                  版本 {r.inputVersion} · {r.input.boundary === 'integrated' ? '一体化' : '仅站方'}{' '}
                  · {r.complete ? '完整' : '不完整'} ·{' '}
                  {new Date(r.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </option>
              ))}
            </NativeSelect>
          </AssetField>
        </div>
      </div>
      {draft ? (
        <>
          <TaxCashflowEditor
            value={draft}
            context={scenario.context}
            targets={targets}
            disabled={busy || disabled}
            onChange={edit}
          />
          <div className={styles.actions}>
            <Button disabled={busy || disabled} onClick={() => void mutate('save')}>
              保存税务规则
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => edit(null)}>
              取消税务编辑
            </Button>
          </div>
        </>
      ) : (
        <div className={styles.actions}>
          <Button
            variant="outline"
            disabled={busy || disabled || !view}
            onClick={() =>
              edit(
                extendTaxInput(
                  scenario.context.taxCashflows ?? emptyTaxInput(),
                  scenario.context,
                  targets,
                ),
              )
            }
          >
            编辑税务规则
          </Button>
          <Button
            disabled={
              busy || disabled || !scenario.context.taxCashflows || !op?.complete || !cap?.complete
            }
            onClick={() => void mutate('calculate')}
          >
            核对税后项目现金流
          </Button>
        </div>
      )}
      <details className={styles.trace}>
        <summary>已保存税务规则与资料缺口</summary>
        {view?.issues.length ? (
          <ul className={styles.issues}>
            {view.issues.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        ) : (
          <p>输入基础资料已填写，仍须采用账目作联合核对。</p>
        )}
        <ScenarioInputValue
          value={scenario.context.taxCashflows}
          field="taxCashflows"
          names={inputNames}
        />
      </details>
      {!displayed ? (
        <p className={styles.empty}>尚无税务账目。先保存规则，再显式选择运营及资产依据核对。</p>
      ) : (
        <div className={styles.result}>
          <div className={styles.heading}>
            <h4>{displayed.complete ? '税后项目现金流完整' : '税后项目现金流待补齐'}</h4>
            <span>
              {displayed.inputVersion === scenario.inputVersion
                ? `本版输入 ${displayed.inputVersion}`
                : `历史输入 ${displayed.inputVersion}，不代表当前结论`}
            </span>
          </div>
          <AssetField label="历史税务账目">
            <NativeSelect
              aria-label="历史税务账目"
              value={displayed.id}
              onChange={(e) => setHistoryId(e.target.value)}
            >
              {view?.results.map((r) => (
                <option key={r.id} value={r.id}>
                  版本 {r.inputVersion} · {r.complete ? '完整' : '待补齐'} ·{' '}
                  {new Date(r.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </option>
              ))}
            </NativeSelect>
          </AssetField>
          <p className={styles.help}>
            采用运营版本 {displayed.operatingResult.inputVersion}、资产版本{' '}
            {displayed.assetResult.inputVersion} · 年度末、折现前 · {displayed.policy}
          </p>
          <p className={styles.help}>
            融资利息及其税务影响：未纳入项目口径，留待融资评价；本账目不表示投资推荐成立。
          </p>
          {displayed.issues.length > 0 && (
            <ul className={styles.issues}>
              {displayed.issues.map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
          )}
          <CashflowTable
            label="年度税务与项目现金流"
            columns={[
              '年份',
              '运营现金流',
              '资本现金流',
              '资金增减',
              '增值税',
              '其他税费',
              '所得税',
              '项目现金流',
              '状态',
            ]}
            numericColumns={[1, 2, 3, 4, 5, 6, 7]}
            rows={displayed.years.map((y) => [
              y.year,
              money(y.operatingCashflowCents),
              money(y.capitalCashflowCents),
              money(y.workingCapitalCashflowCents),
              money(y.payments[0].adoptedCents),
              money(y.payments[2].adoptedCents),
              money(y.payments[1].adoptedCents),
              money(y.projectCashflowCents),
              y.complete ? '完整' : '待补齐',
            ])}
          />
          <AssetField label="核对税务年份">
            <NativeSelect
              aria-label="核对税务年份"
              value={year?.year ?? ''}
              onChange={(e) => setYearNumber(Number(e.target.value))}
            >
              {displayed.years.map((y) => (
                <option key={y.year} value={y.year}>
                  {y.year} 年
                </option>
              ))}
            </NativeSelect>
          </AssetField>
          {year && (
            <section className={styles.yearResult} aria-label={`${year.year} 年税务依据`}>
              <h4>{year.year} 年计税、折旧与结转</h4>
              <p>相对建设首年 {year.period} 年 · 年末收付 · 金额单位：元</p>
              {!!year.issues.length && (
                <ul className={styles.issues}>
                  {year.issues.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
              )}
              <CashflowTable
                label="年度税基及留抵"
                columns={['项目', '金额']}
                numericColumns={[1]}
                rows={[
                  ['折旧（仅计税）', money(year.depreciationCents)],
                  ['亏损抵扣前计税收益', money(year.taxableBeforeLossCents)],
                  ['亏损抵扣后税基', money(year.taxableAfterLossCents)],
                  ['销项税额', money(year.outputVatCents)],
                  ['本年允许抵扣进项', money(year.inputVatCents)],
                  ['期初进项留抵', money(year.openingVatCreditCents)],
                  ['期末进项留抵（不退现）', money(year.closingVatCreditCents)],
                  ['期初可结转亏损', money(year.lossOpeningCents)],
                  ['本年到期亏损', money(year.lossExpiredCents)],
                  ['本年抵扣亏损', money(year.lossUsedCents)],
                  ['本年新增可结转亏损', money(year.lossAddedCents)],
                  ['期末亏损余额', money(year.lossClosingCents)],
                ]}
              />
              <CashflowTable
                label="税款基准及替代"
                columns={['税种', '基准', '采用', '替代原因与来源']}
                numericColumns={[1, 2]}
                rows={year.payments.map((p) => [
                  taxPaymentNames[p.kind],
                  money(p.baseCents),
                  money(p.adoptedCents),
                  p.override ? `${p.override.reason} · ${p.override.source}` : '沿用基准',
                ])}
              />
              <details className={styles.trace}>
                <summary>逐项价税与计税依据 · {year.lines.length} 项</summary>
                <CashflowTable
                  label="逐项价税及计税处理"
                  columns={[
                    '项目',
                    '含税口径及抵扣',
                    '源金额',
                    '未税',
                    '实收付',
                    '税额',
                    '可抵进项',
                    '所得税基依据',
                    '来源',
                  ]}
                  numericColumns={[2, 3, 4, 5, 6, 7]}
                  rows={year.lines.map((l) => [
                    l.name,
                    `${l.rule?.pricing ? taxPricingNames[l.rule.pricing] : '未知'} · ${l.rule?.credit ? taxCreditNames[l.rule.credit] : '未知'}`,
                    money(l.amountCents),
                    money(l.netCents),
                    money(l.grossCents),
                    money(l.vatCents),
                    money(l.creditCents),
                    `${money(l.incomeBasisCents)} · ${l.rule?.incomeTax === 'included' ? '纳入' : l.rule?.incomeTax === 'excluded' ? '排除' : '未知'}`,
                    l.rule?.source || '未知',
                  ])}
                />
              </details>
              <details className={styles.trace}>
                <summary>资产代际折旧及处置剩余税基</summary>
                <CashflowTable
                  label="分类资产折旧"
                  columns={[
                    '资产',
                    '分类',
                    '代际年份',
                    '期初税基',
                    '本年折旧',
                    '处置税基',
                    '期末税基',
                    '来源',
                  ]}
                  numericColumns={[2, 3, 4, 5, 6]}
                  rows={year.depreciation.map((d) => [
                    d.name,
                    assetCategories[d.category],
                    d.generationYear,
                    money(d.openingBasisCents),
                    money(d.depreciationCents),
                    money(d.disposedBasisCents),
                    money(d.closingBasisCents),
                    d.source || '未知',
                  ])}
                />
              </details>
              <details className={styles.trace}>
                <summary>期末亏损批次</summary>
                {year.lossLots === null ? (
                  <p>前期依据未知</p>
                ) : (
                  <CashflowTable
                    label="期末亏损批次"
                    columns={['发生年', '最后可用年', '剩余金额']}
                    numericColumns={[0, 1, 2]}
                    rows={year.lossLots.map((l) => [
                      l.originYear,
                      l.expiresAfterYear,
                      money(l.amountCents),
                    ])}
                  />
                )}
              </details>
            </section>
          )}
          <details className={styles.trace}>
            <summary>本账目输入与来源追溯</summary>
            <p>
              年度任务 {displayed.operatingResult.sourceTaskId} · 物理输入版本{' '}
              {displayed.operatingResult.sourceInputVersion} · 运营账目{' '}
              {displayed.operatingResult.id} · 资产账目 {displayed.assetResult.id}
            </p>
            <ScenarioInputValue
              value={displayed.input}
              field="taxCashflows"
              names={{
                ...scenarioInputNames({
                  ...scenario.context,
                  assetCashflows: displayed.assetResult.input,
                  operatingCashflows: displayed.operatingResult.input,
                }),
                ...Object.fromEntries(
                  taxTargets(displayed.operatingResult, displayed.assetResult).map((target) => [
                    target.key,
                    `${target.year} · ${target.name}`,
                  ]),
                ),
              }}
            />
          </details>
        </div>
      )}
    </section>
  );
}
