'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PlanningScenario, ScenarioComparison } from '@haulpath/domain';
import { Dialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { request } from '@/lib/client-request';
import ScenarioInputValue, { scenarioInputNames } from './scenario-input-value';
import styles from './scenario-version-comparison.module.css';

const state = (scenario: PlanningScenario) =>
  `${scenario.status === 'frozen' ? '已冻结' : '草案'} · 输入版本 ${scenario.inputVersion}`;

export default function ScenarioVersionComparison({
  scenarios,
  selectedId,
  projectId,
  onClose,
}: {
  scenarios: PlanningScenario[];
  selectedId?: string;
  projectId: string;
  onClose: () => void;
}) {
  const initialLeft = selectedId ?? scenarios[0]?.id ?? '';
  const [left, setLeft] = useState(initialLeft);
  const [right, setRight] = useState(scenarios.find((item) => item.id !== initialLeft)?.id ?? '');
  const [result, setResult] = useState<ScenarioComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  function changeSide(side: 'left' | 'right', value: string) {
    controller.current?.abort();
    setBusy(false);
    setResult(null);
    setError('');
    if (side === 'left') setLeft(value);
    else setRight(value);
  }
  async function compare(event: FormEvent) {
    event.preventDefault();
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const value = await request<ScenarioComparison>(
        `/api/projects/${encodeURIComponent(projectId)}/scenarios/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`,
        'GET',
        undefined,
        current.signal,
      );
      if (!current.signal.aborted) setResult(value);
    } catch (failure) {
      if (!current.signal.aborted)
        setError(failure instanceof Error ? failure.message : '比较失败，请重试。');
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  }
  const sections = result
    ? [...new Set(result.differences.map((difference) => difference.section))]
    : [];
  const leftNames = result ? scenarioInputNames(result.left.context) : {};
  const rightNames = result ? scenarioInputNames(result.right.context) : {};
  return (
    <Dialog
      title="比较输入版本"
      description="选择本项目的两个方案版本，核对来源、顺序与参数差异。"
      wide
      error={error}
      onClose={onClose}
    >
      <p className="helper">
        比较当前保存的输入。草案后续可继续变化；冻结版本保留决策依据。尚无运营或财务计算结果。
      </p>
      <form onSubmit={(event) => void compare(event)}>
        <div className={styles.controls}>
          {(['left', 'right'] as const).map((side) => (
            <label className="field" key={side}>
              {side === 'left' ? '左侧版本' : '右侧版本'}
              <NativeSelect
                aria-label={side === 'left' ? '左侧版本' : '右侧版本'}
                value={side === 'left' ? left : right}
                onChange={(event) => changeSide(side, event.target.value)}
              >
                {scenarios.map((scenario) => (
                  <option key={scenario.id} value={scenario.id}>
                    {scenario.name} · {state(scenario)}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <Button
            className="button primary"
            type="submit"
            disabled={busy || !left || !right || left === right}
          >
            {busy ? '正在比较…' : '查看输入差异'}
          </Button>
        </div>
        {left === right && <p className="helper">请选择两个不同版本。</p>}
      </form>
      {busy && (
        <p className={styles.summary} role="status">
          正在读取两份版本的输入…
        </p>
      )}
      {result && (
        <div aria-label="输入差异结果">
          <div className={styles.versions}>
            {[result.left, result.right].map((scenario, index) => (
              <div key={scenario.id}>
                <strong>
                  {index === 0 ? '左侧' : '右侧'}：{scenario.name}
                </strong>
                <span>
                  {state(scenario)} · 修订 {scenario.revision}
                </span>
              </div>
            ))}
          </div>
          <p className={styles.summary} role="status">
            {result.differences.length
              ? `${result.differences.length} 项输入差异`
              : '两份版本的输入相同'}
          </p>
          <div className={styles.sections}>
            {sections.map((section) => (
              <section className={styles.section} key={section}>
                <h3>{section}</h3>
                {result.differences
                  .filter((difference) => difference.section === section)
                  .map((difference) => (
                    <div className={styles.difference} key={difference.path}>
                      <h4>
                        {difference.kind === 'added'
                          ? '新增'
                          : difference.kind === 'removed'
                            ? '移除'
                            : '变更'}{' '}
                        · {difference.label}
                      </h4>
                      <div className={styles.pair}>
                        <div>
                          <span className={styles.side}>左侧 · {result.left.name}</span>
                          <ScenarioInputValue
                            value={difference.left}
                            names={leftNames}
                            field={difference.path.split('.').at(-1)}
                            path={difference.path}
                          />
                        </div>
                        <div>
                          <span className={styles.side}>右侧 · {result.right.name}</span>
                          <ScenarioInputValue
                            value={difference.right}
                            names={rightNames}
                            field={difference.path.split('.').at(-1)}
                            path={difference.path}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
              </section>
            ))}
          </div>
        </div>
      )}
      <div className="dialog-actions">
        <Button className="button" onClick={onClose}>
          关闭比较
        </Button>
      </div>
    </Dialog>
  );
}
