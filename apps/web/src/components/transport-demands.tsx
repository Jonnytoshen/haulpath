'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  cycleDailyFlows,
  demandReadiness,
  transportDemandIssue,
  type PlanningScenario,
  type TransportCycle,
  type TransportDemandInput,
} from '@haulpath/domain';
import { Dialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { request } from '@/lib/client-request';
import styles from './transport-demands.module.css';

type DraftDemand = Omit<TransportDemandInput, 'dailyTonnes'> & { key: string; dailyTonnes: string };
type Editor = { revision: number; rows: DraftDemand[]; baseline: string };
type PasteRow = { line: number; source: string; demand: DraftDemand | null; error: string | null };
const tonnes = (value: number) =>
  value !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 1e12)
    ? String(value)
    : new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 17 }).format(value);
const messageOf = (failure: unknown) =>
  failure instanceof Error ? failure.message : '保存失败，请重试。';
const positionLabel = (cycle: TransportCycle | undefined, id: string) => {
  const index = cycle?.positions.findIndex((position) => position.id === id) ?? -1;
  return index >= 0 && cycle ? `${index + 1} · ${cycle.positions[index].point.name}` : '位置已删除';
};
const demandOf = ({
  id,
  cycleId,
  loadingPositionId,
  unloadingPositionId,
  dailyTonnes,
}: DraftDemand): TransportDemandInput => ({
  ...(id ? { id } : {}),
  cycleId,
  loadingPositionId,
  unloadingPositionId,
  dailyTonnes: Number(dailyTonnes),
});

function draftIssue(row: DraftDemand, cycles: TransportCycle[]): string | null {
  if (
    !row.dailyTonnes.trim() ||
    !Number.isFinite(Number(row.dailyTonnes)) ||
    Number(row.dailyTonnes) <= 0
  )
    return '日吨数必须为大于 0 的有限数值';
  return transportDemandIssue({ ...demandOf(row), id: row.id ?? row.key }, cycles);
}

export default function TransportDemands({
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
  const cycles = scenario.context.transportCycles ?? [];
  const demands = scenario.context.transportDemands ?? [];
  const [editor, setEditor] = useState<Editor | null>(null);
  const [cycleId, setCycleId] = useState('');
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<PasteRow[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const alive = useRef(true);
  const writing = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const invalid = demands.filter((demand) => transportDemandIssue(demand, cycles));
  const dirty =
    editor && (JSON.stringify(editor.rows) !== editor.baseline || paste.trim().length > 0);

  function openEditor() {
    const rows = demands.map((demand) => ({
      ...demand,
      key: demand.id,
      dailyTonnes: String(demand.dailyTonnes),
    }));
    setEditor({ revision: scenario.revision, rows, baseline: JSON.stringify(rows) });
    setCycleId(cycles[0]?.id ?? '');
    setPaste('');
    setPreview(null);
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
  function updateRow(key: string, changes: Partial<DraftDemand>) {
    if (!editor) return;
    setEditor({
      ...editor,
      rows: editor.rows.map((row) => (row.key === key ? { ...row, ...changes } : row)),
    });
    setError('');
  }
  function addDemand() {
    if (!editor) return;
    const cycle = cycles.find((item) => item.id === cycleId);
    setEditor({
      ...editor,
      rows: [
        ...editor.rows,
        {
          key: crypto.randomUUID(),
          cycleId,
          loadingPositionId: cycle?.positions[0]?.id ?? '',
          unloadingPositionId: cycle?.positions[1]?.id ?? '',
          dailyTonnes: '',
        },
      ],
    });
    setError('');
  }
  function previewPaste() {
    const cycle = cycles.find((item) => item.id === cycleId);
    if (!cycle) {
      setError('请先选择需求所属循环');
      return;
    }
    if (!paste.trim()) {
      setError('请先粘贴三列需求资料');
      return;
    }
    const lines = paste.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && !lines.at(-1)?.trim()) lines.pop();
    const parsed = lines.map((source, index): PasteRow => {
      const columns = source.split('\t').map((column) => column.trim());
      if (columns.length !== 3)
        return { line: index + 1, source, demand: null, error: '需要三列，以制表符分隔' };
      const [load, unload, amount] = columns;
      const loading = Number(load);
      const unloading = Number(unload);
      if (
        !/^\d+$/.test(load) ||
        !/^\d+$/.test(unload) ||
        !cycle.positions[loading - 1] ||
        !cycle.positions[unloading - 1]
      )
        return { line: index + 1, source, demand: null, error: '装卸位置须为当前循环内的位置序号' };
      const demand: DraftDemand = {
        key: crypto.randomUUID(),
        cycleId: cycle.id,
        loadingPositionId: cycle.positions[loading - 1].id,
        unloadingPositionId: cycle.positions[unloading - 1].id,
        dailyTonnes: amount,
      };
      return { line: index + 1, source, demand, error: draftIssue(demand, cycles) };
    });
    setPreview(parsed);
    setError('');
  }
  function appendPaste() {
    if (!editor || !preview || preview.some((row) => row.error)) return;
    setEditor({
      ...editor,
      rows: [...editor.rows, ...preview.flatMap((row) => (row.demand ? [row.demand] : []))],
    });
    setPaste('');
    setPreview(null);
    setNotice('粘贴内容已加入需求草稿，保存全部需求后生效');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || writing.current) return;
    const firstInvalid = editor.rows.findIndex((row) => draftIssue(row, cycles));
    if (firstInvalid >= 0) {
      setError(`第 ${firstInvalid + 1} 行：${draftIssue(editor.rows[firstInvalid], cycles)}`);
      return;
    }
    if (paste.trim()) {
      setError('粘贴内容尚未加入需求草稿，请先校验并加入，或清空粘贴框');
      return;
    }
    if (!Number.isFinite(editor.rows.reduce((sum, row) => sum + Number(row.dailyTonnes), 0))) {
      setError('日需求合计超出可计算数值范围，请调整吨数');
      return;
    }
    writing.current = true;
    setBusy(true);
    onWritingChange(true);
    setError('');
    try {
      const saved = await request<PlanningScenario>(
        `/api/projects/${encodeURIComponent(scenario.projectId)}/scenarios/${encodeURIComponent(scenario.id)}/demands`,
        'PUT',
        { expectedRevision: editor.revision, demands: editor.rows.map(demandOf) },
      );
      if (!alive.current) return;
      onChange(saved);
      setEditor(null);
      setNotice('运输需求已保存');
    } catch (failure) {
      if (alive.current)
        setError(
          `${messageOf(failure)} 本次填写已保留；如有修订冲突，请先复制需要保留的内容，关闭后刷新方案再核对保存。`,
        );
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section className={styles.section} aria-label="方案运输需求">
      <header className={styles.heading}>
        <div>
          <h3>运输需求</h3>
          <p>按装卸位置录入日吨数，核对固定业务顺序下的区间货流。</p>
        </div>
        <Button
          className="button"
          disabled={disabled || busy || (!cycles.length && !demands.length)}
          onClick={openEditor}
        >
          <Pencil aria-hidden="true" />
          维护运输需求
        </Button>
      </header>
      {notice && !editor && (
        <p className={styles.notice} role="status">
          <Check aria-hidden="true" />
          {notice}
        </p>
      )}
      {!cycles.length && !demands.length ? (
        <p className={styles.empty}>先从线路建立运输循环，再录入装卸需求。</p>
      ) : (
        <>
          <p className={styles.summary}>
            {demands.length} 条需求 · 日需求合计{' '}
            {tonnes(demands.reduce((sum, demand) => sum + demand.dailyTonnes, 0))} 吨
          </p>
          {invalid.length > 0 && (
            <p className={styles.warning} role="alert">
              {invalid.length}{' '}
              条需求存在无效引用或装卸倒序，已从区间日货流中排除。请维护需求，重新关联位置或删除。
            </p>
          )}
          {!demands.length ? (
            <p className={styles.empty}>
              还没有运输需求。可逐条填写，或粘贴表格中的装卸序号与日吨数。
            </p>
          ) : (
            <ol className={styles.demands} aria-label="已保存运输需求">
              {demands.map((demand, index) => {
                const cycle = cycles.find((item) => item.id === demand.cycleId);
                const gaps = demandReadiness(demand, cycles);
                return (
                  <li key={demand.id}>
                    <div>
                      <strong>
                        需求 {index + 1} · {cycle?.name ?? '循环已删除'}
                      </strong>
                      <span>
                        {positionLabel(cycle, demand.loadingPositionId)} →{' '}
                        {positionLabel(cycle, demand.unloadingPositionId)}
                      </span>
                      {gaps.length > 0 && (
                        <span className={styles.gap}>就绪缺口：{gaps.join('；')}</span>
                      )}
                    </div>
                    <span className={styles.number}>
                      {tonnes(demand.dailyTonnes)} <small>吨/日</small>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          <div className={styles.flows}>
            <h4>区间日货流</h4>
            <p className={styles.helper}>
              按装货位置起、卸货位置止的业务区间累计；下表列出参与相加的需求依据。无效需求不参与累计，循环未确认仍须核对业务顺序。
            </p>
            {cycles.map((cycle) => (
              <div className={styles.tableWrap} key={cycle.id}>
                <table>
                  <caption>{cycle.name} 区间日货流</caption>
                  <thead>
                    <tr>
                      <th scope="col">业务区间</th>
                      <th scope="col" className={styles.number}>
                        日货流（吨/日）
                      </th>
                      <th scope="col">需求依据</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cycleDailyFlows(cycle, demands).map((flow) => {
                      const basis = flow.demands.map((demand) => ({
                        id: demand.id,
                        text: `需求 ${demands.findIndex((item) => item.id === demand.id) + 1}（${tonnes(demand.dailyTonnes)} 吨/日）`,
                      }));
                      return (
                        <tr key={`${flow.fromPositionId}-${flow.toPositionId}`}>
                          <th scope="row">
                            {positionLabel(cycle, flow.fromPositionId)} →{' '}
                            {positionLabel(cycle, flow.toPositionId)}
                          </th>
                          <td className={styles.number}>{tonnes(flow.dailyTonnes)}</td>
                          <td>
                            {basis.length > 5 ? (
                              <details className={styles.evidence}>
                                <summary>{basis.length} 条需求</summary>
                                <ul>
                                  {basis.map((item) => (
                                    <li key={item.id}>{item.text}</li>
                                  ))}
                                </ul>
                              </details>
                            ) : basis.length ? (
                              basis.map((item) => item.text).join(' + ')
                            ) : (
                              '无需求经过'
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {cycle.positions.length < 2 && (
                  <p className={styles.helper}>循环尚无相邻业务区间。</p>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <p className={styles.boundary}>
        日需求与日货流不是单车载荷。同类货物可拆分到多次运输、可混装，末次可不足整车；实际车次的逐区间载重与完成量由后续运输计划校核。
      </p>
      {editor && (
        <Dialog title="维护运输需求" wide error={error} onClose={closeEditor}>
          <form onSubmit={save} noValidate>
            <p className={styles.helper}>
              所有修改先保留在本次草稿，保存时整批校验。位置序号按当前循环顺序显示，同名位置分别选择。
            </p>
            {discarding && (
              <div className={styles.discard} role="alert">
                <p>尚有未保存的需求，关闭将丢弃本次修改。</p>
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
              <div className={styles.addControls}>
                <label className="field">
                  需求所属循环
                  <NativeSelect
                    aria-label="需求所属循环"
                    value={cycleId}
                    onChange={(event) => {
                      setCycleId(event.target.value);
                      setPreview(null);
                    }}
                  >
                    <option value="">请选择循环</option>
                    {cycles.map((cycle) => (
                      <option value={cycle.id} key={cycle.id}>
                        {cycle.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <Button className="button" disabled={!cycleId} onClick={addDemand}>
                  <Plus aria-hidden="true" />
                  新增需求
                </Button>
              </div>
              <ol className={styles.editorRows} aria-label="运输需求草稿">
                {editor.rows.map((row, index) => {
                  const cycle = cycles.find((item) => item.id === row.cycleId);
                  const issue = draftIssue(row, cycles);
                  return (
                    <li key={row.key}>
                      <div className={styles.rowHeading}>
                        <h4>需求 {index + 1}</h4>
                        <Button
                          className="text-button danger-text"
                          aria-label={`删除需求 ${index + 1}`}
                          onClick={() => {
                            setEditor({
                              ...editor,
                              rows: editor.rows.filter((item) => item.key !== row.key),
                            });
                            setError('');
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                          删除
                        </Button>
                      </div>
                      <label className="field">
                        所属循环
                        <NativeSelect
                          aria-label={`需求 ${index + 1} 所属循环`}
                          value={row.cycleId}
                          onChange={(event) => {
                            const target = cycles.find((item) => item.id === event.target.value);
                            updateRow(row.key, {
                              cycleId: event.target.value,
                              loadingPositionId: target?.positions[0]?.id ?? '',
                              unloadingPositionId: target?.positions[1]?.id ?? '',
                            });
                          }}
                        >
                          {!cycle && <option value={row.cycleId}>循环已删除，请重新选择</option>}
                          {cycles.map((item) => (
                            <option value={item.id} key={item.id}>
                              {item.name}
                            </option>
                          ))}
                        </NativeSelect>
                      </label>
                      <div className={styles.rowFields}>
                        {(['loadingPositionId', 'unloadingPositionId'] as const).map((field) => (
                          <label className="field" key={field}>
                            {field === 'loadingPositionId' ? '装货位置' : '卸货位置'}
                            <NativeSelect
                              aria-label={`需求 ${index + 1} ${field === 'loadingPositionId' ? '装货位置' : '卸货位置'}`}
                              value={row[field]}
                              aria-invalid={!!issue}
                              onChange={(event) =>
                                updateRow(row.key, { [field]: event.target.value })
                              }
                            >
                              {!cycle?.positions.some((position) => position.id === row[field]) && (
                                <option value={row[field]}>位置已删除，请重新选择</option>
                              )}
                              {cycle?.positions.map((position, positionIndex) => (
                                <option value={position.id} key={position.id}>
                                  {positionIndex + 1} · {position.point.name}
                                </option>
                              ))}
                            </NativeSelect>
                          </label>
                        ))}
                        <label className="field">
                          日吨数（吨/日）
                          <Input
                            aria-label={`需求 ${index + 1} 日吨数`}
                            inputMode="decimal"
                            value={row.dailyTonnes}
                            aria-invalid={!!issue}
                            onChange={(event) =>
                              updateRow(row.key, { dailyTonnes: event.target.value })
                            }
                          />
                        </label>
                      </div>
                      {issue && (
                        <p className={styles.gap}>
                          第 {index + 1} 行：{issue}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
              <details className={styles.paste} open={paste.length > 0 || undefined}>
                <summary>批量粘贴需求</summary>
                <p className={styles.helper}>
                  选择上方循环，从表格复制三列：装货位置序号、卸货位置序号、日吨数。用制表符分隔，不含表头；每行一条需求。先校验预览，再加入草稿。
                </p>
                <label className="field">
                  批量需求
                  <textarea
                    aria-label="批量需求"
                    rows={4}
                    value={paste}
                    onChange={(event) => {
                      setPaste(event.target.value);
                      setPreview(null);
                    }}
                    placeholder={'1\t3\t12.5\n2\t4\t7.25'}
                  />
                </label>
                <Button className="button" disabled={!cycleId} onClick={previewPaste}>
                  校验粘贴内容
                </Button>
                {preview && (
                  <>
                    {preview.some((row) => row.error) && (
                      <div className={styles.warning} role="alert">
                        {preview
                          .filter((row) => row.error)
                          .map((row) => (
                            <p key={row.line}>
                              第 {row.line} 行：{row.error}
                            </p>
                          ))}
                        <p>请在粘贴框修正后重新校验，本批尚未加入任何需求。</p>
                      </div>
                    )}
                    <div className={styles.tableWrap}>
                      <table>
                        <caption>粘贴需求预览</caption>
                        <thead>
                          <tr>
                            <th>行号</th>
                            <th>粘贴内容</th>
                            <th>校验结果</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.map((row) => (
                            <tr key={row.line}>
                              <td className={styles.number}>{row.line}</td>
                              <td className={styles.source}>{row.source}</td>
                              <td>{row.error ?? '有效'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!preview.some((row) => row.error) && (
                      <Button className="button" onClick={appendPaste}>
                        加入需求草稿
                      </Button>
                    )}
                  </>
                )}
              </details>
              {notice && (
                <p className={styles.notice} role="status">
                  {notice}
                </p>
              )}
            </fieldset>
            <div className="dialog-actions">
              <Button className="button" disabled={busy} onClick={closeEditor}>
                取消
              </Button>
              <Button className="button primary" type="submit" disabled={busy || discarding}>
                {busy ? '保存中…' : '保存全部需求'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
