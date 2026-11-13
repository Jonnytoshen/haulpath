'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  operatingBases,
  validOperatingRate,
  tariffWindowIssue,
  operatingFlows,
  operatingFlowBases,
  type OperatingCashflowInput,
  type OperatingCashflowYear,
  type OperatingPriceLine,
  type OperatingFlow,
  type PlanningScenarioContext,
} from '@haulpath/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { CashflowTable } from './operating-cashflow-ledger';
import styles from './operating-cashflows.module.css';

export function emptyOperatingYear(year: number): OperatingCashflowYear {
  return { year, scopeSource: '', stationCostMode: null, lines: [], electricity: [] };
}
function pastedInput(
  text: string,
  kind: '收支' | '电价',
  draft: OperatingCashflowInput,
): OperatingCashflowInput {
  if (!text.trim()) throw new Error('请先粘贴内容');
  const next = structuredClone(draft);
  const touched = new Set<number>();
  for (const [index, raw] of text
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .entries()) {
    const values = raw.split('\t');
    if (values.length !== (kind === '收支' ? 8 : 7))
      throw new Error(`第 ${index + 1} 行列数不符，请按说明使用制表符分列`);
    const year = next.years.find((y) => y.year === Number(values[0]));
    if (!year || !values[0].trim())
      throw new Error(`第 ${index + 1} 行年份不在当前表单中，请先补齐年度`);
    if (!touched.has(year.year)) {
      if (kind === '收支') year.lines = [];
      else year.electricity = [];
      touched.add(year.year);
    }
    if (kind === '收支') {
      const [, id, name, flow, basis, rate, source, stationId] = values;
      if (!validOperatingRate(rate.trim() || null))
        throw new Error(`第 ${index + 1} 行单价须为非负十进制数，最多6位小数`);
      if (
        !Object.hasOwn(operatingFlowBases, flow) ||
        !operatingFlowBases[flow as OperatingFlow].includes(basis as OperatingPriceLine['basis'])
      )
        throw new Error(`第 ${index + 1} 行归属或单位无效`);
      if (!id.trim() || !name.trim() || year.lines.some((l) => l.id === id))
        throw new Error(`第 ${index + 1} 行身份或名称为空，或身份重复`);
      year.lines.push({
        id,
        name,
        flow: flow as OperatingFlow,
        basis: basis as OperatingPriceLine['basis'],
        rate: rate.trim() || null,
        source,
        stationId: stationId.trim() || null,
      });
    } else {
      const [, powerSourceId, payer, start, end, rate, source] = values;
      if (!validOperatingRate(rate.trim() || null))
        throw new Error(`第 ${index + 1} 行电价须为非负十进制数，最多6位小数`);
      if (
        !powerSourceId.trim() ||
        !['station', 'transport', 'external', ''].includes(payer) ||
        !start.trim() ||
        !end.trim() ||
        !Number.isInteger(Number(start)) ||
        !Number.isInteger(Number(end))
      )
        throw new Error(`第 ${index + 1} 行电源、承担方或日内分钟无效`);
      let power = year.electricity.find((p) => p.powerSourceId === powerSourceId);
      if (!power) {
        power = {
          powerSourceId,
          payer: (payer || null) as 'station' | 'transport' | 'external' | null,
          windows: [],
        };
        year.electricity.push(power);
      }
      if (power.payer !== (payer || null))
        throw new Error(`第 ${index + 1} 行同一电源的承担方须一致`);
      power.windows.push({
        startMinute: Number(start),
        endMinute: Number(end),
        rate: rate.trim() || null,
        source,
      });
    }
  }
  for (const year of next.years) {
    for (const power of year.electricity) {
      const issue = tariffWindowIssue(power.windows);
      if (issue) throw new Error(`${year.year}：${issue}`);
    }
  }
  return next;
}

export default function OperatingCashflowEditor({
  draft,
  context,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: OperatingCashflowInput;
  context: PlanningScenarioContext;
  busy: boolean;
  onChange: (input: OperatingCashflowInput) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [pasteKind, setPasteKind] = useState<'收支' | '电价' | null>(null);
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<OperatingCashflowInput | null>(null);
  const [error, setError] = useState('');
  function updateYear(index: number, patch: Partial<OperatingCashflowYear>) {
    onChange({
      ...draft,
      years: draft.years.map((y, i) => (i === index ? { ...y, ...patch } : y)),
    });
  }
  function updateLine(yearIndex: number, lineIndex: number, patch: Partial<OperatingPriceLine>) {
    updateYear(yearIndex, {
      lines: draft.years[yearIndex].lines.map((l, i) => (i === lineIndex ? { ...l, ...patch } : l)),
    });
  }
  const sites =
    context.stationNetwork?.fixedLayout
      .map((s) => context.stationNetwork!.sites.find((site) => site.id === s.siteId))
      .filter((s) => !!s) ?? [];
  const powers = context.stationNetwork?.powerSources ?? [];
  return (
    <fieldset className={styles.editor} disabled={busy}>
      <legend>运营收支输入</legend>
      <label className={styles.field}>
        业务边界
        <NativeSelect
          aria-label="业务边界"
          value={draft.boundary ?? ''}
          onChange={(e) =>
            onChange({
              ...draft,
              boundary: (e.target.value || null) as OperatingCashflowInput['boundary'],
            })
          }
        >
          <option value="">请选择</option>
          <option value="integrated">一体化</option>
          <option value="station-only">仅站方</option>
        </NativeSelect>
      </label>
      <p className={styles.help}>
        一体化纳入运输、站点及所承担购电，抵销内部换电；仅站方纳入站方取得或承担的项目。所有单价为元/所选单位，未知留空，零价须明确填写
        0 并记录来源。税费及含税方式另行校核。
      </p>
      <Button
        className="button"
        onClick={() =>
          onChange({
            ...draft,
            years: [
              ...draft.years,
              ...(context.annualTransport ?? [])
                .filter((p) => !draft.years.some((y) => y.year === p.year))
                .map((y) => emptyOperatingYear(y.year)),
            ],
          })
        }
      >
        补齐当前评价年份
      </Button>
      {draft.years.map((year, yi) => (
        <section
          key={year.year}
          className={styles.yearEditor}
          aria-label={`${year.year} 年价格输入`}
        >
          <div className={styles.heading}>
            <h4>{year.year} 年</h4>
            <Button
              className="text-button"
              onClick={() => onChange({ ...draft, years: draft.years.filter((_, i) => i !== yi) })}
              aria-label={`移除 ${year.year} 年收支输入`}
            >
              <Trash2 />
              移除本年输入
            </Button>
          </div>
          <div className={styles.fields}>
            <label className={styles.field}>
              收入与费用范围依据
              <Input
                aria-label={`${year.year} 年收支范围依据`}
                value={year.scopeSource}
                placeholder="列全所纳入项目；无其他费用也须明确依据"
                onChange={(e) => updateYear(yi, { scopeSource: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              站点运维口径
              <NativeSelect
                aria-label={`${year.year} 年站点运维口径`}
                value={year.stationCostMode ?? ''}
                onChange={(e) =>
                  updateYear(yi, {
                    stationCostMode: (e.target.value ||
                      null) as OperatingCashflowYear['stationCostMode'],
                  })
                }
              >
                <option value="">请选择</option>
                <option value="annual-lines">年度明细替代站型运维</option>
                <option value="station-types">逐站采用所选站型年度运维</option>
              </NativeSelect>
            </label>
          </div>
          <p className={styles.help}>
            两种运维口径互斥。年度固定金额按整年计入，运营天数为 0
            也保留；变动费用按本年实际业务数量计量。
          </p>
          {year.lines.map((line, li) => (
            <fieldset key={line.id} className={styles.line}>
              <legend>收支项目 {li + 1}</legend>
              <div className={styles.fields}>
                <label className={styles.field}>
                  名称
                  <Input
                    aria-label={`${year.year} 年明细 ${li + 1} 名称`}
                    value={line.name}
                    onChange={(e) => updateLine(yi, li, { name: e.target.value })}
                  />
                </label>
                <label className={styles.field}>
                  归属
                  <NativeSelect
                    aria-label={`${year.year} 年明细 ${li + 1} 归属`}
                    value={line.flow}
                    onChange={(e) => {
                      const flow = e.target.value as OperatingFlow;
                      updateLine(yi, li, {
                        flow,
                        basis: operatingFlowBases[flow][0],
                        stationId: null,
                      });
                    }}
                  >
                    {Object.entries(operatingFlows).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className={styles.field}>
                  计费单位
                  <NativeSelect
                    aria-label={`${year.year} 年明细 ${li + 1} 计费单位`}
                    value={line.basis}
                    onChange={(e) =>
                      updateLine(yi, li, { basis: e.target.value as OperatingPriceLine['basis'] })
                    }
                  >
                    {operatingFlowBases[line.flow].map((key) => (
                      <option key={key} value={key}>
                        {operatingBases[key]}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className={styles.field}>
                  单价（元）
                  <Input
                    aria-label={`${year.year} 年明细 ${li + 1} 单价（元）`}
                    inputMode="decimal"
                    value={line.rate ?? ''}
                    onChange={(e) => updateLine(yi, li, { rate: e.target.value || null })}
                  />
                </label>
                <label className={styles.field}>
                  来源
                  <Input
                    aria-label={`${year.year} 年明细 ${li + 1} 来源`}
                    value={line.source}
                    onChange={(e) => updateLine(yi, li, { source: e.target.value })}
                  />
                </label>
                {!line.flow.startsWith('transport') && (
                  <label className={styles.field}>
                    适用站址
                    <NativeSelect
                      aria-label={`${year.year} 年明细 ${li + 1} 站址`}
                      value={line.stationId ?? ''}
                      onChange={(e) => updateLine(yi, li, { stationId: e.target.value || null })}
                    >
                      <option value="">全部入选站</option>
                      {line.stationId && !sites.some((s) => s.id === line.stationId) && (
                        <option value={line.stationId}>失效站址 {line.stationId}</option>
                      )}
                      {sites.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                )}
              </div>
              <Button
                className="text-button"
                aria-label={`移除 ${year.year} 年明细 ${li + 1}`}
                onClick={() => updateYear(yi, { lines: year.lines.filter((_, i) => i !== li) })}
              >
                <Trash2 />
                移除项目
              </Button>
            </fieldset>
          ))}
          <Button
            className="button"
            onClick={() =>
              updateYear(yi, {
                lines: [
                  ...year.lines,
                  {
                    id: crypto.randomUUID(),
                    name: '',
                    flow: 'transport-revenue',
                    basis: 'tonne',
                    rate: null,
                    source: '',
                    stationId: null,
                  },
                ],
              })
            }
          >
            <Plus />
            添加 {year.year} 年收支项目
          </Button>
          <h4>分时购电价格</h4>
          <p className={styles.help}>
            按电源录入实际购电的承担方和电价窗口；以日内分钟表示，结束早于开始表示跨午夜。电源合计与逐站分摊只收费一次。
          </p>
          {year.electricity.map((power, pi) => (
            <fieldset key={power.powerSourceId} className={styles.line}>
              <legend>
                {powers.find((p) => p.id === power.powerSourceId)?.point.name ??
                  `失效电源 ${power.powerSourceId}`}
              </legend>
              <label className={styles.field}>
                购电承担方
                <NativeSelect
                  aria-label={`${year.year} 年电源 ${pi + 1} 承担方`}
                  value={power.payer ?? ''}
                  onChange={(e) =>
                    updateYear(yi, {
                      electricity: year.electricity.map((p, i) =>
                        i === pi
                          ? { ...p, payer: (e.target.value || null) as typeof power.payer }
                          : p,
                      ),
                    })
                  }
                >
                  <option value="">请选择</option>
                  <option value="station">站方</option>
                  <option value="transport">运输方</option>
                  <option value="external">外部承担，不计本边界</option>
                </NativeSelect>
              </label>
              {power.windows.map((window, wi) => (
                <div key={wi} className={styles.fields}>
                  {(['startMinute', 'endMinute', 'rate', 'source'] as const).map((field) => (
                    <label key={field} className={styles.field}>
                      {
                        {
                          startMinute: '开始分钟',
                          endMinute: '结束分钟',
                          rate: '元/kWh',
                          source: '电价来源',
                        }[field]
                      }
                      <Input
                        aria-label={`${year.year} 年电源 ${pi + 1} 窗口 ${wi + 1} ${field}`}
                        value={
                          typeof window[field] === 'number' && Number.isNaN(window[field])
                            ? ''
                            : (window[field] ?? '')
                        }
                        onChange={(e) =>
                          updateYear(yi, {
                            electricity: year.electricity.map((p, i) =>
                              i !== pi
                                ? p
                                : {
                                    ...p,
                                    windows: p.windows.map((w, j) =>
                                      j !== wi
                                        ? w
                                        : {
                                            ...w,
                                            [field]:
                                              field === 'startMinute' || field === 'endMinute'
                                                ? e.target.value.trim()
                                                  ? Number(e.target.value)
                                                  : NaN
                                                : e.target.value || (field === 'rate' ? null : ''),
                                          },
                                    ),
                                  },
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
                  <Button
                    className="text-button"
                    aria-label={`移除 ${year.year} 年电源 ${pi + 1} 窗口 ${wi + 1}`}
                    onClick={() =>
                      updateYear(yi, {
                        electricity: year.electricity.map((p, i) =>
                          i !== pi ? p : { ...p, windows: p.windows.filter((_, j) => j !== wi) },
                        ),
                      })
                    }
                  >
                    移除窗口
                  </Button>
                </div>
              ))}
              <div className={styles.actions}>
                <Button
                  className="button"
                  onClick={() =>
                    updateYear(yi, {
                      electricity: year.electricity.map((p, i) =>
                        i !== pi
                          ? p
                          : {
                              ...p,
                              windows: [
                                ...p.windows,
                                { startMinute: 0, endMinute: 1440, rate: null, source: '' },
                              ],
                            },
                      ),
                    })
                  }
                >
                  添加电价窗口
                </Button>
                <Button
                  className="text-button"
                  onClick={() =>
                    updateYear(yi, { electricity: year.electricity.filter((_, i) => i !== pi) })
                  }
                >
                  移除此电源电价
                </Button>
              </div>
            </fieldset>
          ))}
          <label className={styles.field}>
            添加电源电价
            <NativeSelect
              aria-label={`${year.year} 年添加电源电价`}
              value=""
              onChange={(e) => {
                if (e.target.value)
                  updateYear(yi, {
                    electricity: [
                      ...year.electricity,
                      { powerSourceId: e.target.value, payer: null, windows: [] },
                    ],
                  });
              }}
            >
              <option value="">选择方案内电源</option>
              {powers
                .filter((p) => !year.electricity.some((s) => s.powerSourceId === p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.point.name}
                  </option>
                ))}
            </NativeSelect>
          </label>
        </section>
      ))}
      {!draft.years.length && (
        <p className={styles.help}>先在「年度能力」保存评价年份，再补齐收支输入。</p>
      )}
      <div className={styles.actions}>
        {(['收支', '电价'] as const).map((kind) => (
          <Button
            className="button"
            key={kind}
            onClick={() => {
              setPasteKind(pasteKind === kind ? null : kind);
              setPaste('');
              setPreview(null);
              setError('');
            }}
          >
            批量粘贴{kind}
          </Button>
        ))}
      </div>
      {pasteKind && (
        <section className={styles.paste} aria-label={`${pasteKind}批量粘贴`}>
          <h4>{pasteKind}批量粘贴</h4>
          <p className={styles.help}>
            {pasteKind === '收支'
              ? '每行8列：年份、明细身份、名称、归属代码、单位代码、单价、来源、站址身份（全部站留空）。归属：transport-revenue / external-station-revenue / internal-swap / transport-cost / station-cost；单位：tonne / tonne-km / vehicle-km / empty-km / swap / grid-kwh / year。'
              : '每行7列：年份、电源身份、承担方（station / transport / external）、开始分钟、结束分钟、元/kWh、来源。电源身份可在下方查询。'}
          </p>
          <p className={styles.help}>
            预览后替换涉及年份的全部{pasteKind}明细，其他年份和另一类资料保留。空单价表示未知。
          </p>
          {pasteKind === '电价' && (
            <details>
              <summary>电源身份对照</summary>
              {powers.map((p) => (
                <p key={p.id}>
                  {p.point.name}：{p.id}
                </p>
              ))}
            </details>
          )}
          <label>
            {pasteKind}粘贴内容
            <textarea
              aria-label={`${pasteKind}粘贴内容`}
              rows={6}
              value={paste}
              onChange={(e) => {
                setPaste(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <Button
            className="button"
            onClick={() => {
              try {
                setPreview(pastedInput(paste, pasteKind, draft));
                setError('');
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            预览{pasteKind}粘贴
          </Button>
          {preview && (
            <section aria-label={`${pasteKind}粘贴预览`}>
              <CashflowTable
                label={`${pasteKind}预览明细`}
                columns={['年份', '项目 / 电源', '归属 / 单位', '价格及来源']}
                rows={preview.years.flatMap((y) =>
                  pasteKind === '收支'
                    ? y.lines.map((l) => [
                        y.year,
                        l.name,
                        `${operatingFlows[l.flow]} / ${operatingBases[l.basis]}`,
                        `${l.rate ?? '未知'} / ${l.source || '缺来源'}`,
                      ])
                    : y.electricity.flatMap((p) =>
                        p.windows.map((w) => [
                          y.year,
                          powers.find((s) => s.id === p.powerSourceId)?.point.name ??
                            p.powerSourceId,
                          `${p.payer ?? '缺承担方'} / ${w.startMinute}–${w.endMinute}`,
                          `${w.rate ?? '未知'} / ${w.source || '缺来源'}`,
                        ]),
                      ),
                )}
              />
              <Button
                className="button"
                onClick={() => {
                  const affectedYears = new Set(
                    paste.split(/\r?\n/).map((line) => Number(line.split('\t')[0])),
                  );
                  onChange({
                    ...draft,
                    years: draft.years.map((year) => {
                      const adopted = preview.years.find((p) => p.year === year.year);
                      if (!adopted || !affectedYears.has(year.year)) return year;
                      return pasteKind === '收支'
                        ? { ...year, lines: adopted.lines }
                        : { ...year, electricity: adopted.electricity };
                    }),
                  });
                  setPreview(null);
                  setPasteKind(null);
                }}
              >
                采用{pasteKind}预览
              </Button>
            </section>
          )}
        </section>
      )}
      <div className={styles.actions}>
        <Button className="button primary" onClick={onSave}>
          保存运营收支
        </Button>
        <Button className="button" onClick={onCancel}>
          取消编辑
        </Button>
        <span>保存后输入版本更新，旧账目按原版本保留。</span>
      </div>
    </fieldset>
  );
}
