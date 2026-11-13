'use client';

import { useState, type ReactNode } from 'react';
import {
  assetCategories,
  assetAssociationIssue,
  assetOwners,
  assetEventNames,
  validAssetAmount,
  type AssetCashflowInput,
  type AssetEntry,
  type AssetOwner,
  type PlanningScenarioContext,
} from '@haulpath/domain';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { CashflowTable } from './operating-cashflow-ledger';
import styles from './operating-cashflows.module.css';

export function AssetField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={styles.field}>
      {label}
      {children}
    </label>
  );
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
        inputMode={numeric ? 'decimal' : undefined}
        value={value ?? ''}
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
export function emptyAsset(): AssetEntry {
  return {
    id: '',
    name: '',
    category: 'other',
    owner: null,
    acquisition: null,
    amount: null,
    serviceYear: null,
    source: '',
    notes: '',
    siteId: null,
    budgetBucket: null,
    replacements: [],
    residual: null,
  };
}
type Preview =
  | { kind: 'assets'; assets: AssetEntry[]; rows: string[][] }
  | { kind: 'working'; accounts: AssetCashflowInput['workingCapital']; rows: string[][] };
function parsePreview(
  raw: string,
  kind: 'assets' | 'working',
  context: PlanningScenarioContext,
): Preview {
  const rows = raw
    .split(/\r?\n/)
    .filter((r) => r.trim())
    .map((r) => r.split('\t').map((cell) => cell.trim()));
  if (rows.some((row) => row.some((cell) => cell.length > 2000))) throw new Error('文本最多2000字');
  if (!raw.trim() || rows.length > 1000) throw new Error('请粘贴1至1000行资料');
  const money = (value: string) => {
    const result = value === '' ? null : value;
    if (!validAssetAmount(result)) throw new Error('金额须为非负十进制文本，最多12位整数、6位小数');
    return result;
  };
  const year = (v: string) => {
    if (!/^\d{1,4}$/.test(v) || Number(v) < 1) throw new Error('年份须为1至9999的整数');
    return Number(v);
  };
  if (kind === 'assets') {
    const assets = rows.map((r) => {
      if (r.length !== 13) throw new Error('资产每行须为13列；空值也保留制表符');
      const [
        name,
        category,
        owner,
        acquisition,
        amount,
        serviceYear,
        source,
        notes,
        siteId,
        budgetBucket,
        residualYear,
        residual,
        residualSource,
      ] = r;
      if (
        !name.trim() ||
        !Object.hasOwn(assetCategories, category) ||
        !Object.hasOwn(assetOwners, owner) ||
        !['new', 'existing'].includes(acquisition)
      )
        throw new Error('资产名称、分类、归属或取得方式无效');
      if (siteId && !context.stationNetwork?.fixedLayout.some((s) => s.siteId === siteId))
        throw new Error('站址身份不属于固定布局');
      const associationIssue = assetAssociationIssue(
        category,
        siteId || null,
        budgetBucket || null,
      );
      if (associationIssue) throw new Error(associationIssue);
      if (!residualYear && (residual || residualSource))
        throw new Error('有残值资料时须填写残值年份');
      return {
        ...emptyAsset(),
        name,
        category,
        owner,
        acquisition,
        amount: money(amount),
        serviceYear: serviceYear ? year(serviceYear) : null,
        source,
        notes,
        siteId: siteId || null,
        budgetBucket: budgetBucket || null,
        residual: residualYear
          ? { year: year(residualYear), amount: money(residual), source: residualSource }
          : null,
      } as AssetEntry;
    });
    return { kind, assets, rows };
  }
  const accounts: AssetCashflowInput['workingCapital'] = [];
  for (const r of rows) {
    if (r.length !== 6) throw new Error('营运资金每行须为6列');
    const [owner, openingBalance, openingSource, y, balance, source] = r;
    if (!Object.hasOwn(assetOwners, owner)) throw new Error('营运资金归属无效');
    let account = accounts.find((a) => a.owner === owner);
    if (!account) {
      account = {
        owner: owner as AssetOwner,
        openingBalance: money(openingBalance),
        source: openingSource,
        years: [],
      };
      accounts.push(account);
    }
    if (account.openingBalance !== money(openingBalance) || account.source !== openingSource)
      throw new Error('同一归属的期初余额及来源须一致');
    const annualYear = year(y);
    if (account.years.some((y) => y.year === annualYear)) throw new Error('营运资金年份不能重复');
    account.years.push({ year: annualYear, balance: money(balance), source });
  }
  return { kind, accounts, rows };
}
export default function AssetCashflowEditor({
  draft,
  context,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: AssetCashflowInput;
  context: PlanningScenarioContext;
  busy: boolean;
  onChange: (input: AssetCashflowInput) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [yearsText, setYearsText] = useState(draft.years.join('、'));
  const [pasteKind, setPasteKind] = useState<'assets' | 'working'>('assets');
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const set = (change: Partial<AssetCashflowInput>) => onChange({ ...draft, ...change });
  function asset(index: number, change: Partial<AssetEntry>) {
    set({ assets: draft.assets.map((a, i) => (i === index ? { ...a, ...change } : a)) });
  }
  const sites = Object.fromEntries(
    (context.stationNetwork?.fixedLayout ?? []).map((s) => [
      s.siteId,
      context.stationNetwork!.sites.find((a) => a.id === s.siteId)?.name ?? s.siteId,
    ]),
  );
  return (
    <fieldset className={styles.editor} disabled={busy}>
      <legend>资产与资金安排</legend>
      <p className={styles.help}>
        金额单位为元，留空表示未知，0
        表示明确无收付。金额逐项四舍五入至分；历史取得只作依据。仅维护资产也可核对，无需年度收入或运输结果。
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.fields}>
        <Select
          label="资产业务边界"
          value={draft.boundary}
          options={{ integrated: '一体化', 'station-only': '仅站方' }}
          onChange={(v) => set({ boundary: (v as AssetCashflowInput['boundary']) || null })}
        />
        <Text
          label="初始建设年份"
          numeric
          value={draft.initialYear}
          onChange={(v) => set({ initialYear: v ? Number(v) : null })}
        />
        <Text
          label="资产评价年份（用顿号或逗号分隔）"
          value={yearsText}
          onChange={(v) => {
            setYearsText(v);
            const values = v
              .split(/[、,，\s]+/)
              .filter(Boolean)
              .map(Number);
            set({ years: values });
          }}
        />
      </div>
      <Text
        label="全部资产及营运资金范围依据"
        value={draft.scopeSource}
        onChange={(v) => set({ scopeSource: v })}
      />
      <p className={styles.help}>
        一次新建投运，初始建设年份为评价首年；如已有年度能力输入，须对齐其年份（可增加首年建设期）。站型完整投资已含必要备电池，关联站址的资产须分拆归集对账。
      </p>
      <h4>分类资产</h4>
      {draft.assets.map((a, i) => (
        <fieldset className={styles.line} key={a.id || `new-${i}`}>
          <legend>
            资产 {i + 1} · {a.name || '待命名'}
          </legend>
          {a.id && <p className={styles.help}>资产身份：{a.id}</p>}
          <div className={styles.fields}>
            <Text
              label={`资产 ${i + 1} 名称`}
              value={a.name}
              onChange={(v) => asset(i, { name: v })}
            />
            <Select
              label={`资产 ${i + 1} 分类`}
              value={a.category}
              options={assetCategories}
              onChange={(v) => asset(i, { category: v as AssetEntry['category'] })}
            />
            <Select
              label={`资产 ${i + 1} 归属`}
              value={a.owner}
              options={assetOwners}
              onChange={(v) => asset(i, { owner: (v as AssetOwner) || null })}
            />
            <Select
              label={`资产 ${i + 1} 取得方式`}
              value={a.acquisition}
              options={{ new: '本次新增', existing: '历史已发生' }}
              onChange={(v) => asset(i, { acquisition: (v as AssetEntry['acquisition']) || null })}
            />
            <Text
              label={`资产 ${i + 1} 取得金额（元）`}
              numeric
              value={a.amount}
              onChange={(v) => asset(i, { amount: v || null })}
            />
            <Text
              label={`资产 ${i + 1} 投运年份`}
              numeric
              value={a.serviceYear}
              onChange={(v) => asset(i, { serviceYear: v ? Number(v) : null })}
            />
            <Select
              label={`资产 ${i + 1} 关联站址`}
              value={a.siteId}
              options={{
                ...sites,
                ...(a.siteId && !sites[a.siteId] ? { [a.siteId]: `失效站址 ${a.siteId}` } : {}),
              }}
              onChange={(v) => asset(i, { siteId: v || null })}
            />
            <Select
              label={`资产 ${i + 1} 预算归集`}
              value={a.budgetBucket}
              options={{ station: '完整建站配置（含备电池）', connection: '接电工程' }}
              onChange={(v) =>
                asset(i, { budgetBucket: (v as AssetEntry['budgetBucket']) || null })
              }
            />
          </div>
          <Text
            label={`资产 ${i + 1} 来源`}
            value={a.source}
            onChange={(v) => asset(i, { source: v })}
          />
          <Text
            label={`资产 ${i + 1} 范围说明`}
            value={a.notes}
            onChange={(v) => asset(i, { notes: v })}
          />
          <p className={styles.help}>
            更换仅替换设备，不增加车队或站网规模；每次更换同时填写旧件回收（无则填0）。
          </p>
          {a.replacements.map((r, j) => (
            <div key={j} className={styles.line}>
              <div className={styles.fields}>
                <Text
                  label={`资产 ${i + 1} 更换 ${j + 1} 年份`}
                  numeric
                  value={r.year || null}
                  onChange={(v) =>
                    asset(i, {
                      replacements: a.replacements.map((r, k) =>
                        k === j ? { ...r, year: Number(v) } : r,
                      ),
                    })
                  }
                />
                <Text
                  label={`资产 ${i + 1} 更换 ${j + 1} 投资（元）`}
                  numeric
                  value={r.amount}
                  onChange={(v) =>
                    asset(i, {
                      replacements: a.replacements.map((r, k) =>
                        k === j ? { ...r, amount: v || null } : r,
                      ),
                    })
                  }
                />
                <Text
                  label={`资产 ${i + 1} 更换 ${j + 1} 旧件回收（元）`}
                  numeric
                  value={r.disposal}
                  onChange={(v) =>
                    asset(i, {
                      replacements: a.replacements.map((r, k) =>
                        k === j ? { ...r, disposal: v || null } : r,
                      ),
                    })
                  }
                />
                <Text
                  label={`资产 ${i + 1} 更换 ${j + 1} 来源`}
                  value={r.source}
                  onChange={(v) =>
                    asset(i, {
                      replacements: a.replacements.map((r, k) =>
                        k === j ? { ...r, source: v } : r,
                      ),
                    })
                  }
                />
              </div>
              <Button
                className="text-button"
                onClick={() => asset(i, { replacements: a.replacements.filter((_, k) => k !== j) })}
              >
                移除资产 {i + 1} 更换 {j + 1}
              </Button>
            </div>
          ))}
          <Button
            className="text-button"
            onClick={() =>
              asset(i, {
                replacements: [
                  ...a.replacements,
                  { year: 0, amount: null, disposal: null, source: '' },
                ],
              })
            }
          >
            添加资产 {i + 1} 更换
          </Button>
          {a.residual ? (
            <div className={styles.fields}>
              <Text
                label={`资产 ${i + 1} 残值年份`}
                numeric
                value={a.residual.year || null}
                onChange={(v) => asset(i, { residual: { ...a.residual!, year: Number(v) } })}
              />
              <Text
                label={`资产 ${i + 1} 残值（元）`}
                numeric
                value={a.residual.amount}
                onChange={(v) => asset(i, { residual: { ...a.residual!, amount: v || null } })}
              />
              <Text
                label={`资产 ${i + 1} 残值来源`}
                value={a.residual.source}
                onChange={(v) => asset(i, { residual: { ...a.residual!, source: v } })}
              />
            </div>
          ) : (
            <Button
              className="text-button"
              onClick={() => asset(i, { residual: { year: 0, amount: null, source: '' } })}
            >
              填写资产 {i + 1} 末期残值
            </Button>
          )}
          <Button
            className="text-button"
            onClick={() => set({ assets: draft.assets.filter((_, j) => j !== i) })}
          >
            移除资产 {i + 1}
          </Button>
        </fieldset>
      ))}
      <Button className="button" onClick={() => set({ assets: [...draft.assets, emptyAsset()] })}>
        添加分类资产
      </Button>
      <h4>营运资金余额计划</h4>
      <p className={styles.help}>
        按承担方维护期初与各年期末余额，只将余额增加列支、减少回收。末年不会自动释放；如全部收回应显式填期末0。没有账户时，在范围依据说明无营运资金。
      </p>
      {draft.workingCapital.map((w, i) => (
        <fieldset className={styles.line} key={i}>
          <legend>营运资金 {i + 1}</legend>
          <div className={styles.fields}>
            <Select
              label={`营运资金 ${i + 1} 归属`}
              value={w.owner}
              options={assetOwners}
              onChange={(v) =>
                set({
                  workingCapital: draft.workingCapital.map((w, j) =>
                    j === i ? { ...w, owner: v as AssetOwner } : w,
                  ),
                })
              }
            />
            <Text
              label={`营运资金 ${i + 1} 期初余额（元）`}
              numeric
              value={w.openingBalance}
              onChange={(v) =>
                set({
                  workingCapital: draft.workingCapital.map((w, j) =>
                    j === i ? { ...w, openingBalance: v || null } : w,
                  ),
                })
              }
            />
            <Text
              label={`营运资金 ${i + 1} 期初来源`}
              value={w.source}
              onChange={(v) =>
                set({
                  workingCapital: draft.workingCapital.map((w, j) =>
                    j === i ? { ...w, source: v } : w,
                  ),
                })
              }
            />
          </div>
          {w.years.map((y, j) => (
            <div className={styles.fields} key={j}>
              <Text
                label={`营运资金 ${i + 1} 年度 ${j + 1} 年份`}
                numeric
                value={y.year || null}
                onChange={(v) =>
                  set({
                    workingCapital: draft.workingCapital.map((w, k) =>
                      k === i
                        ? {
                            ...w,
                            years: w.years.map((y, k) => (k === j ? { ...y, year: Number(v) } : y)),
                          }
                        : w,
                    ),
                  })
                }
              />
              <Text
                label={`营运资金 ${i + 1} 年度 ${j + 1} 期末余额（元）`}
                numeric
                value={y.balance}
                onChange={(v) =>
                  set({
                    workingCapital: draft.workingCapital.map((w, k) =>
                      k === i
                        ? {
                            ...w,
                            years: w.years.map((y, k) =>
                              k === j ? { ...y, balance: v || null } : y,
                            ),
                          }
                        : w,
                    ),
                  })
                }
              />
              <Text
                label={`营运资金 ${i + 1} 年度 ${j + 1} 来源`}
                value={y.source}
                onChange={(v) =>
                  set({
                    workingCapital: draft.workingCapital.map((w, k) =>
                      k === i
                        ? {
                            ...w,
                            years: w.years.map((y, k) => (k === j ? { ...y, source: v } : y)),
                          }
                        : w,
                    ),
                  })
                }
              />
              <Button
                className="text-button"
                onClick={() =>
                  set({
                    workingCapital: draft.workingCapital.map((w, k) =>
                      k === i ? { ...w, years: w.years.filter((_, k) => k !== j) } : w,
                    ),
                  })
                }
              >
                移除资金 {i + 1} 年度 {j + 1}
              </Button>
            </div>
          ))}
          <div className={styles.actions}>
            <Button
              className="text-button"
              onClick={() =>
                set({
                  workingCapital: draft.workingCapital.map((w, k) =>
                    k === i
                      ? { ...w, years: [...w.years, { year: 0, balance: null, source: '' }] }
                      : w,
                  ),
                })
              }
            >
              添加资金 {i + 1} 年度
            </Button>
            <Button
              className="text-button"
              onClick={() =>
                set({ workingCapital: draft.workingCapital.filter((_, j) => j !== i) })
              }
            >
              移除营运资金 {i + 1}
            </Button>
          </div>
        </fieldset>
      ))}
      <Button
        className="button"
        onClick={() =>
          set({
            workingCapital: [
              ...draft.workingCapital,
              { owner: 'station', openingBalance: null, source: '', years: [] },
            ],
          })
        }
      >
        添加营运资金账户
      </Button>
      <h4>特殊年度替代</h4>
      <p className={styles.help}>
        替代某项资产某年一笔资本收付，保留原金额和修订依据，不叠加扣款。先保存资产取得稳定身份，再添加覆盖。初始投资替代也须与站网预算相符。
      </p>
      {draft.overrides.map((o, i) => (
        <fieldset className={styles.line} key={i}>
          <legend>覆盖 {i + 1}</legend>
          <div className={styles.fields}>
            <Select
              label={`覆盖 ${i + 1} 资产`}
              value={o.assetId}
              options={{
                ...Object.fromEntries(draft.assets.filter((a) => a.id).map((a) => [a.id, a.name])),
                ...(!draft.assets.some((a) => a.id === o.assetId) && o.assetId
                  ? { [o.assetId]: `失效资产 ${o.assetId}` }
                  : {}),
              }}
              onChange={(v) =>
                set({
                  overrides: draft.overrides.map((o, j) => (j === i ? { ...o, assetId: v } : o)),
                })
              }
            />
            <Text
              label={`覆盖 ${i + 1} 年份`}
              numeric
              value={o.year || null}
              onChange={(v) =>
                set({
                  overrides: draft.overrides.map((o, j) =>
                    j === i ? { ...o, year: Number(v) } : o,
                  ),
                })
              }
            />
            <Select
              label={`覆盖 ${i + 1} 收付项目`}
              value={o.kind}
              options={assetEventNames}
              onChange={(v) =>
                set({
                  overrides: draft.overrides.map((o, j) =>
                    j === i ? { ...o, kind: v as typeof o.kind } : o,
                  ),
                })
              }
            />
            <Text
              label={`覆盖 ${i + 1} 金额（元）`}
              numeric
              value={o.amount}
              onChange={(v) =>
                set({
                  overrides: draft.overrides.map((o, j) =>
                    j === i ? { ...o, amount: v || null } : o,
                  ),
                })
              }
            />
            <Text
              label={`覆盖 ${i + 1} 原因`}
              value={o.reason}
              onChange={(v) =>
                set({
                  overrides: draft.overrides.map((o, j) => (j === i ? { ...o, reason: v } : o)),
                })
              }
            />
            <Text
              label={`覆盖 ${i + 1} 来源`}
              value={o.source}
              onChange={(v) =>
                set({
                  overrides: draft.overrides.map((o, j) => (j === i ? { ...o, source: v } : o)),
                })
              }
            />
          </div>
          <Button
            className="text-button"
            onClick={() => set({ overrides: draft.overrides.filter((_, j) => j !== i) })}
          >
            移除覆盖 {i + 1}
          </Button>
        </fieldset>
      ))}
      <Button
        className="button"
        disabled={!draft.assets.some((a) => a.id)}
        onClick={() =>
          set({
            overrides: [
              ...draft.overrides,
              { assetId: '', year: 0, kind: 'replacement', amount: null, reason: '', source: '' },
            ],
          })
        }
      >
        添加年度替代
      </Button>
      <details className={styles.paste}>
        <summary>批量粘贴资产或营运资金</summary>
        <Select
          label="粘贴资料类型"
          value={pasteKind}
          options={{ assets: '追加分类资产', working: '按归属替代营运资金' }}
          onChange={(v) => {
            setPasteKind(v as typeof pasteKind);
            setPreview(null);
            setError('');
          }}
        />
        {pasteKind === 'assets' ? (
          <p>
            13列：名称、分类(vehicle/battery/station/connection/other)、归属(station/transport/external)、取得方式(new/existing)、金额、投运年、来源、范围说明、站址身份、预算归集(station/connection)、残值年、残值、残值来源。新资产采用追加；更换及覆盖在表单维护。
          </p>
        ) : (
          <p>
            6列：归属(station/transport/external)、期初余额、期初来源、年份、期末余额、年度来源。仅替代预览涉及归属的余额计划，其余账户和资产保留。
          </p>
        )}
        <textarea
          aria-label="资产资金粘贴内容"
          rows={5}
          value={paste}
          onChange={(e) => {
            setPaste(e.target.value);
            setPreview(null);
          }}
        />
        <Button
          className="button"
          onClick={() => {
            try {
              setPreview(parsePreview(paste, pasteKind, context));
              setError('');
            } catch (e) {
              setPreview(null);
              setError((e as Error).message);
            }
          }}
        >
          预览资产资金粘贴
        </Button>
        {preview && (
          <section aria-label="资产资金粘贴预览">
            <CashflowTable
              label="资产资金预览明细"
              columns={
                preview.kind === 'assets'
                  ? [
                      '名称',
                      '分类',
                      '归属',
                      '取得',
                      '金额',
                      '投运年',
                      '来源',
                      '范围',
                      '站址',
                      '预算归集',
                      '残值年',
                      '残值',
                      '残值来源',
                    ]
                  : ['归属', '期初余额', '期初来源', '年份', '期末余额', '来源']
              }
              rows={preview.rows}
            />
            <Button
              className="button"
              onClick={() => {
                if (preview.kind === 'assets')
                  set({ assets: [...draft.assets, ...preview.assets] });
                else
                  set({
                    workingCapital: [
                      ...draft.workingCapital.filter(
                        (w) => !preview.accounts.some((a) => a.owner === w.owner),
                      ),
                      ...preview.accounts,
                    ],
                  });
                setPreview(null);
              }}
            >
              采用资产资金预览
            </Button>
          </section>
        )}
      </details>
      <div className={styles.actions}>
        <Button className="button primary" onClick={onSave}>
          保存资产与资金
        </Button>
        <Button className="button" onClick={onCancel}>
          取消资产编辑
        </Button>
      </div>
    </fieldset>
  );
}
