'use client';
import { useState } from 'react';
import {
  assetCategories,
  taxPricingNames,
  taxCreditNames,
  taxPaymentNames,
  validAssetAmount,
  type TaxCashflowInput,
  type TaxTarget,
  type TaxYearInput,
  type PlanningScenarioContext,
} from '@haulpath/domain';
import { AssetField } from './asset-cashflow-editor';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { CashflowTable } from './operating-cashflow-ledger';
import styles from './operating-cashflows.module.css';

export function emptyTaxInput(): TaxCashflowInput {
  return {
    scopeSource: '',
    openingVatCredit: null,
    openingVatSource: '',
    lossCarryYears: null,
    lossSource: '',
    openingLosses: [],
    years: [],
    rules: [],
    depreciation: [],
    historicalAssets: [],
    overrides: [],
  };
}
export function extendTaxInput(
  input: TaxCashflowInput,
  context: PlanningScenarioContext,
  targets: TaxTarget[],
): TaxCashflowInput {
  const next = structuredClone(input);
  for (const year of context.assetCashflows?.years ?? [])
    if (!next.years.some((y) => y.year === year))
      next.years.push({
        year,
        activity: null,
        source: '',
        incomeTaxRate: null,
        otherTax: null,
        otherTaxDeductible: null,
        taxSource: '',
      });
  for (const target of targets)
    if (!next.rules.some((r) => r.targetKey === target.key))
      next.rules.push({
        targetKey: target.key,
        pricing: null,
        vatRate: null,
        credit: null,
        incomeTax: null,
        source: '',
      });
  for (const a of context.assetCashflows?.assets ?? []) {
    if (!next.depreciation.some((r) => r.category === a.category))
      next.depreciation.push({
        category: a.category,
        years: null,
        residualRate: null,
        start: null,
        source: '',
      });
    if (a.acquisition === 'existing' && !next.historicalAssets.some((h) => h.assetId === a.id))
      next.historicalAssets.push({
        assetId: a.id,
        openingBasis: null,
        remainingYears: null,
        residualBasis: null,
        source: '',
      });
  }
  return next;
}
function Text({
  label,
  value,
  onChange,
  numeric = false,
}: {
  label: string;
  value: string | number | null;
  onChange: (value: string) => void;
  numeric?: boolean;
}) {
  return (
    <AssetField label={label}>
      <Input
        aria-label={label}
        value={value ?? ''}
        inputMode={numeric ? 'decimal' : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </AssetField>
  );
}
function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <AssetField label={label}>
      <NativeSelect
        aria-label={label}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">待选择</option>
        {Object.entries(options).map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </NativeSelect>
    </AssetField>
  );
}
const number = (v: string) => (v === '' ? null : Number(v));
const nullable = (v: string) => v || null;
function parseYears(raw: string): TaxYearInput[] {
  const rows = raw
    .split(/\r?\n/)
    .filter((r) => r.trim())
    .map((r) => r.split('\t').map((c) => c.trim()));
  if (!rows.length || rows.length > 1000) throw new Error('请粘贴1至1000行年度税务资料');
  const years = rows.map((r) => {
    if (r.length !== 7) throw new Error('每行须为7列，末尾空列也须保留制表符');
    const [year, activity, rate, tax, deductible, source, taxSource] = r;
    if (!/^\d{1,4}$/.test(year) || Number(year) < 1) throw new Error('税务年份须为1至9999的整数');
    if (activity && !['operating', 'non-operating'].includes(activity))
      throw new Error('年度活动须为operating或non-operating');
    if (rate && !/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/.test(rate))
      throw new Error('税率须为0至1，最多6位小数');
    if (!validAssetAmount(nullable(tax))) throw new Error('其他税费金额无效');
    if (deductible && !['true', 'false'].includes(deductible))
      throw new Error('扣除条件须为true或false，未知留空');
    if (r.some((c) => c.length > 2000)) throw new Error('文本最多2000字');
    return {
      year: Number(year),
      activity: nullable(activity) as TaxYearInput['activity'],
      incomeTaxRate: nullable(rate),
      otherTax: nullable(tax),
      otherTaxDeductible: deductible === '' ? null : deductible === 'true',
      source,
      taxSource,
    };
  });
  if (new Set(years.map((y) => y.year)).size !== years.length) throw new Error('年度不能重复');
  return years;
}
export default function TaxCashflowEditor({
  value,
  context,
  targets,
  onChange,
  disabled,
}: {
  value: TaxCashflowInput;
  context: PlanningScenarioContext;
  targets: TaxTarget[];
  onChange: (v: TaxCashflowInput) => void;
  disabled: boolean;
}) {
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<TaxYearInput[] | null>(null);
  const [error, setError] = useState('');
  function change(edit: (v: TaxCashflowInput) => void) {
    const next = structuredClone(value);
    edit(next);
    onChange(next);
  }
  const labels = new Map(targets.map((t) => [t.key, `${t.year} · ${t.name}`]));
  return (
    <fieldset disabled={disabled} className={styles.editor}>
      <legend>税务规则草稿</legend>
      <p className={styles.help}>
        空值表示未知；税率用0至1的小数。所有零值及不适用规则均须显式声明并记录来源。
      </p>
      <Text
        label="税务范围依据"
        value={value.scopeSource}
        onChange={(v) =>
          change((a) => {
            a.scopeSource = v;
          })
        }
      />
      <div className={styles.fields}>
        <Text
          label="期初进项留抵（元）"
          numeric
          value={value.openingVatCredit}
          onChange={(v) =>
            change((a) => {
              a.openingVatCredit = nullable(v);
            })
          }
        />
        <Text
          label="期初留抵来源"
          value={value.openingVatSource}
          onChange={(v) =>
            change((a) => {
              a.openingVatSource = v;
            })
          }
        />
        <Text
          label="亏损结转年数（0为不结转）"
          numeric
          value={value.lossCarryYears}
          onChange={(v) =>
            change((a) => {
              a.lossCarryYears = number(v);
            })
          }
        />
        <Text
          label="亏损结转来源"
          value={value.lossSource}
          onChange={(v) =>
            change((a) => {
              a.lossSource = v;
            })
          }
        />
      </div>
      <Button variant="outline" onClick={() => onChange(extendTaxInput(value, context, targets))}>
        补齐所选账目规则
      </Button>
      <h4>年度规则</h4>
      {value.years.map((y, i) => (
        <fieldset key={y.year} className={styles.line}>
          <legend>{y.year} 年规则</legend>
          <div className={styles.fields}>
            <Select
              label={`${y.year} 年度活动`}
              value={y.activity}
              options={{ operating: '采用实际运营证据', 'non-operating': '明确无运营收支' }}
              onChange={(v) =>
                change((a) => {
                  a.years[i].activity = nullable(v) as typeof y.activity;
                })
              }
            />
            <Text
              label={`${y.year} 年度活动来源`}
              value={y.source}
              onChange={(v) =>
                change((a) => {
                  a.years[i].source = v;
                })
              }
            />
            <Text
              label={`${y.year} 所得税率`}
              numeric
              value={y.incomeTaxRate}
              onChange={(v) =>
                change((a) => {
                  a.years[i].incomeTaxRate = nullable(v);
                })
              }
            />
            <Text
              label={`${y.year} 其他税费（元）`}
              numeric
              value={y.otherTax}
              onChange={(v) =>
                change((a) => {
                  a.years[i].otherTax = nullable(v);
                })
              }
            />
            <Select
              label={`${y.year} 其他税费税前扣除`}
              value={y.otherTaxDeductible === null ? null : String(y.otherTaxDeductible)}
              options={{ true: '允许扣除', false: '不允许扣除' }}
              onChange={(v) =>
                change((a) => {
                  a.years[i].otherTaxDeductible = v === '' ? null : v === 'true';
                })
              }
            />
            <Text
              label={`${y.year} 税率及其他税费来源`}
              value={y.taxSource}
              onChange={(v) =>
                change((a) => {
                  a.years[i].taxSource = v;
                })
              }
            />
          </div>
          <Button
            variant="ghost"
            onClick={() =>
              change((a) => {
                a.years.splice(i, 1);
              })
            }
          >
            移除 {y.year} 年规则
          </Button>
        </fieldset>
      ))}
      <details className={styles.paste}>
        <summary>批量粘贴年度税务规则</summary>
        <p className={styles.help}>
          7列：年份、活动（operating / non-operating）、所得税率、其他税费、允许扣除（true /
          false）、活动来源、税费来源。未知留空，采用仅替代涉及年份。
        </p>
        <textarea
          aria-label="年度税务粘贴内容"
          rows={4}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setPreview(null);
            setError('');
          }}
        />
        <Button
          variant="outline"
          onClick={() => {
            setPreview(null);
            try {
              setPreview(parseYears(raw));
              setError('');
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          预览年度税务粘贴
        </Button>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {preview && (
          <div role="region" aria-label="年度税务粘贴预览">
            <CashflowTable
              label="年度税务粘贴预览表"
              columns={['年份', '活动', '所得税率', '其他税费', '允许扣除', '活动来源', '税费来源']}
              numericColumns={[0, 2, 3]}
              rows={preview.map((y) => [
                String(y.year),
                y.activity ?? '未知',
                y.incomeTaxRate ?? '未知',
                y.otherTax ?? '未知',
                y.otherTaxDeductible === null ? '未知' : y.otherTaxDeductible ? '是' : '否',
                y.source || '未知',
                y.taxSource || '未知',
              ])}
            />
            <Button
              variant="outline"
              onClick={() => {
                change((a) => {
                  a.years = [
                    ...a.years.filter((y) => !preview.some((p) => p.year === y.year)),
                    ...preview,
                  ].sort((a, b) => a.year - b.year);
                });
                setPreview(null);
              }}
            >
              采用年度税务预览
            </Button>
          </div>
        )}
      </details>
      <details className={styles.trace}>
        <summary>逐项含税、抵扣及所得税处理 · {value.rules.length} 项</summary>
        {value.rules.map((r, i) => (
          <fieldset key={r.targetKey} className={styles.line}>
            <legend>{labels.get(r.targetKey) ?? `失效目标 ${r.targetKey}`}</legend>
            <div className={styles.fields}>
              <Select
                label={`规则 ${i + 1} 含税方式`}
                value={r.pricing}
                options={taxPricingNames}
                onChange={(v) =>
                  change((a) => {
                    a.rules[i].pricing = nullable(v) as typeof r.pricing;
                  })
                }
              />
              <Text
                label={`规则 ${i + 1} 税率`}
                numeric
                value={r.vatRate}
                onChange={(v) =>
                  change((a) => {
                    a.rules[i].vatRate = nullable(v);
                  })
                }
              />
              <Select
                label={`规则 ${i + 1} 进项条件`}
                value={r.credit}
                options={taxCreditNames}
                onChange={(v) =>
                  change((a) => {
                    a.rules[i].credit = nullable(v) as typeof r.credit;
                  })
                }
              />
              <Select
                label={`规则 ${i + 1} 所得税处理`}
                value={r.incomeTax}
                options={{ included: '纳入计税/扣除或投资税基', excluded: '明确排除计税及扣除' }}
                onChange={(v) =>
                  change((a) => {
                    a.rules[i].incomeTax = nullable(v) as typeof r.incomeTax;
                  })
                }
              />
              <Text
                label={`规则 ${i + 1} 来源`}
                value={r.source}
                onChange={(v) =>
                  change((a) => {
                    a.rules[i].source = v;
                  })
                }
              />
            </div>
            <Button
              variant="ghost"
              onClick={() =>
                change((a) => {
                  a.rules.splice(i, 1);
                })
              }
            >
              移除规则 {i + 1}
            </Button>
          </fieldset>
        ))}
      </details>
      <details className={styles.trace}>
        <summary>分类直线折旧及历史剩余税基</summary>
        <p className={styles.help}>
          更换年初停止旧代际折旧，末年回收在年末。历史剩余税基须单独确认，不能由原值推算。
        </p>
        {value.depreciation.map((r, i) => (
          <fieldset key={r.category} className={styles.line}>
            <legend>{assetCategories[r.category]}</legend>
            <div className={styles.fields}>
              <Text
                label={`${assetCategories[r.category]} 折旧年数（0为不折旧）`}
                numeric
                value={r.years}
                onChange={(v) =>
                  change((a) => {
                    a.depreciation[i].years = number(v);
                  })
                }
              />
              <Text
                label={`${assetCategories[r.category]} 税务残值率`}
                numeric
                value={r.residualRate}
                onChange={(v) =>
                  change((a) => {
                    a.depreciation[i].residualRate = nullable(v);
                  })
                }
              />
              <Select
                label={`${assetCategories[r.category]} 折旧起算`}
                value={r.start}
                options={{ 'service-year': '投运当年', 'next-year': '投运次年' }}
                onChange={(v) =>
                  change((a) => {
                    a.depreciation[i].start = nullable(v) as typeof r.start;
                  })
                }
              />
              <Text
                label={`${assetCategories[r.category]} 折旧来源`}
                value={r.source}
                onChange={(v) =>
                  change((a) => {
                    a.depreciation[i].source = v;
                  })
                }
              />
            </div>
            <Button
              variant="ghost"
              onClick={() =>
                change((a) => {
                  a.depreciation.splice(i, 1);
                })
              }
            >
              移除{assetCategories[r.category]}折旧规则
            </Button>
          </fieldset>
        ))}
        {value.historicalAssets.map((h, i) => {
          const name =
            context.assetCashflows?.assets.find((a) => a.id === h.assetId)?.name ?? h.assetId;
          return (
            <fieldset key={h.assetId} className={styles.line}>
              <legend>{name} · 历史资产</legend>
              <div className={styles.fields}>
                <Text
                  label={`${name} 期初剩余税基（元）`}
                  numeric
                  value={h.openingBasis}
                  onChange={(v) =>
                    change((a) => {
                      a.historicalAssets[i].openingBasis = nullable(v);
                    })
                  }
                />
                <Text
                  label={`${name} 剩余折旧年数`}
                  numeric
                  value={h.remainingYears}
                  onChange={(v) =>
                    change((a) => {
                      a.historicalAssets[i].remainingYears = number(v);
                    })
                  }
                />
                <Text
                  label={`${name} 税务残值（元）`}
                  numeric
                  value={h.residualBasis}
                  onChange={(v) =>
                    change((a) => {
                      a.historicalAssets[i].residualBasis = nullable(v);
                    })
                  }
                />
                <Text
                  label={`${name} 历史税基来源`}
                  value={h.source}
                  onChange={(v) =>
                    change((a) => {
                      a.historicalAssets[i].source = v;
                    })
                  }
                />
              </div>
              <Button
                variant="ghost"
                onClick={() =>
                  change((a) => {
                    a.historicalAssets.splice(i, 1);
                  })
                }
              >
                移除{name}历史税基
              </Button>
            </fieldset>
          );
        })}
      </details>
      <details className={styles.trace}>
        <summary>期初亏损及特殊年度税费替代</summary>
        {value.openingLosses.map((l, i) => (
          <fieldset key={i} className={styles.line}>
            <legend>期初亏损 {i + 1}</legend>
            <div className={styles.fields}>
              <Text
                label={`亏损 ${i + 1} 发生年份`}
                numeric
                value={l.originYear}
                onChange={(v) =>
                  change((a) => {
                    a.openingLosses[i].originYear = Number(v);
                  })
                }
              />
              <Text
                label={`亏损 ${i + 1} 剩余可用金额（元）`}
                numeric
                value={l.amount}
                onChange={(v) =>
                  change((a) => {
                    a.openingLosses[i].amount = nullable(v);
                  })
                }
              />
              <Text
                label={`亏损 ${i + 1} 来源`}
                value={l.source}
                onChange={(v) =>
                  change((a) => {
                    a.openingLosses[i].source = v;
                  })
                }
              />
            </div>
            <Button
              variant="ghost"
              onClick={() =>
                change((a) => {
                  a.openingLosses.splice(i, 1);
                })
              }
            >
              移除亏损 {i + 1}
            </Button>
          </fieldset>
        ))}
        <Button
          variant="outline"
          onClick={() =>
            change((a) => {
              a.openingLosses.push({ originYear: 0, amount: null, source: '' });
            })
          }
        >
          添加期初亏损
        </Button>
        <p className={styles.help}>
          替代只改变指定税款；增值税替代不改留抵，所得税替代不改亏损余额。其他税费替代按扣除条件影响税基。
        </p>
        {value.overrides.map((o, i) => (
          <fieldset key={i} className={styles.line}>
            <legend>税费替代 {i + 1}</legend>
            <div className={styles.fields}>
              <Text
                label={`替代 ${i + 1} 年份`}
                numeric
                value={o.year}
                onChange={(v) =>
                  change((a) => {
                    a.overrides[i].year = Number(v);
                  })
                }
              />
              <Select
                label={`替代 ${i + 1} 税种`}
                value={o.kind}
                options={taxPaymentNames}
                onChange={(v) =>
                  change((a) => {
                    if (v) a.overrides[i].kind = v as typeof o.kind;
                  })
                }
              />
              <Text
                label={`替代 ${i + 1} 金额（元）`}
                numeric
                value={o.amount}
                onChange={(v) =>
                  change((a) => {
                    a.overrides[i].amount = nullable(v);
                  })
                }
              />
              <Text
                label={`替代 ${i + 1} 原因`}
                value={o.reason}
                onChange={(v) =>
                  change((a) => {
                    a.overrides[i].reason = v;
                  })
                }
              />
              <Text
                label={`替代 ${i + 1} 来源`}
                value={o.source}
                onChange={(v) =>
                  change((a) => {
                    a.overrides[i].source = v;
                  })
                }
              />
            </div>
            <Button
              variant="ghost"
              onClick={() =>
                change((a) => {
                  a.overrides.splice(i, 1);
                })
              }
            >
              移除替代 {i + 1}
            </Button>
          </fieldset>
        ))}
        <Button
          variant="outline"
          onClick={() =>
            change((a) => {
              a.overrides.push({
                year: context.assetCashflows?.years[0] ?? 0,
                kind: 'income',
                amount: null,
                reason: '',
                source: '',
              });
            })
          }
        >
          添加税费替代
        </Button>
      </details>
    </fieldset>
  );
}
