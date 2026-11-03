'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { PlanningScenario, Project } from '@haulpath/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/app-dialog';
import { request } from '@/lib/client-request';
import styles from './planning-scenario-workbench.module.css';
import TransportCycles from './transport-cycles';
import TransportDemands from './transport-demands';
import FleetOperations from './fleet-operations';

type NameEditor = { scenario: PlanningScenario | null; name: string };
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。';
const savedTime = (time: string) =>
  new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export default function PlanningScenarioWorkbench({ project }: { project: Project }) {
  const path = `/api/projects/${encodeURIComponent(project.id)}/scenarios`;
  const [scenarios, setScenarios] = useState<PlanningScenario[]>([]);
  const [selected, setSelected] = useState<PlanningScenario | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<NameEditor | null>(null);
  const [deleting, setDeleting] = useState<PlanningScenario | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const writing = useRef(false);

  const refresh = useCallback(async () => {
    if (writing.current) return;
    const read = ++generation.current;
    setReading(true);
    setError('');
    try {
      const items = await request<PlanningScenario[]>(path);
      if (!alive.current || read !== generation.current) return;
      setScenarios(items);
      setSelected((current) => items.find((item) => item.id === current?.id) ?? null);
      setLoaded(true);
    } catch (failure) {
      if (alive.current && read === generation.current) setError(messageOf(failure));
    } finally {
      if (alive.current && read === generation.current) setReading(false);
    }
  }, [path]);

  useEffect(() => {
    const lifecycle = generation;
    const read = ++lifecycle.current;
    alive.current = true;
    async function load() {
      try {
        const items = await request<PlanningScenario[]>(path);
        if (!alive.current || read !== lifecycle.current) return;
        setScenarios(items);
        setLoaded(true);
      } catch (failure) {
        if (alive.current && read === lifecycle.current) setError(messageOf(failure));
      } finally {
        if (alive.current && read === lifecycle.current) setReading(false);
      }
    }
    void load();
    return () => {
      alive.current = false;
      lifecycle.current++;
    };
  }, [path]);

  async function openScenario(scenario: PlanningScenario) {
    if (writing.current) return;
    const read = ++generation.current;
    setReading(true);
    setError('');
    setNotice('');
    try {
      const current = await request<PlanningScenario>(`${path}/${scenario.id}`);
      if (!alive.current || read !== generation.current) return;
      setSelected(current);
      setScenarios((items) => items.map((item) => (item.id === current.id ? current : item)));
    } catch (failure) {
      if (alive.current && read === generation.current) setError(messageOf(failure));
    } finally {
      if (alive.current && read === generation.current) setReading(false);
    }
  }

  async function saveName(event: FormEvent) {
    event.preventDefault();
    if (!editor || writing.current) return;
    writing.current = true;
    generation.current++;
    setBusy(true);
    setReading(false);
    setError('');
    setNotice('');
    try {
      const current = editor.scenario;
      const saved = await request<PlanningScenario>(
        current ? `${path}/${current.id}` : path,
        current ? 'PATCH' : 'POST',
        current ? { name: editor.name, expectedRevision: current.revision } : { name: editor.name },
      );
      if (!alive.current) return;
      setScenarios((items) =>
        current ? items.map((item) => (item.id === saved.id ? saved : item)) : [...items, saved],
      );
      setSelected(saved);
      setLoaded(true);
      setEditor(null);
      setNotice(current ? '方案名称已保存' : '规划方案草案已保存');
    } catch (failure) {
      if (alive.current) setError(messageOf(failure));
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function deleteScenario() {
    if (!deleting || writing.current) return;
    writing.current = true;
    generation.current++;
    setBusy(true);
    setReading(false);
    setError('');
    setNotice('');
    try {
      await request(`${path}/${deleting.id}?expectedRevision=${deleting.revision}`, 'DELETE');
      if (!alive.current) return;
      setScenarios((items) => items.filter((item) => item.id !== deleting.id));
      setSelected((current) => (current?.id === deleting.id ? null : current));
      setDeleting(null);
      setNotice('规划方案已删除');
    } catch (failure) {
      if (alive.current) setError(messageOf(failure));
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function closeDialog() {
    if (writing.current) return;
    setEditor(null);
    setDeleting(null);
    setError('');
  }

  return (
    <section
      id="planning-scenarios"
      className={styles.workbench}
      aria-label="项目规划方案"
      tabIndex={-1}
    >
      <header className={styles.heading}>
        <div>
          <h2>方案草案</h2>
          <p>围绕同一业务目标，保存独立的运输与选址规划资料。</p>
        </div>
        <div className={styles.actions}>
          <Button
            className="button"
            disabled={busy || reading}
            onClick={() => void refresh()}
            aria-label="刷新规划方案"
          >
            <RefreshCw aria-hidden="true" />
            刷新
          </Button>
          <Button
            className="button primary"
            disabled={busy || reading || !loaded}
            onClick={() => {
              setError('');
              setNotice('');
              setEditor({ scenario: null, name: '' });
            }}
          >
            <Plus aria-hidden="true" />
            新建规划方案
          </Button>
        </div>
      </header>
      {error && !editor && !deleting && (
        <div className={styles.feedback} role="alert">
          <span>读取或保存规划方案失败：{error}</span>
          <Button className="text-button" disabled={busy || reading} onClick={() => void refresh()}>
            重新读取方案
          </Button>
        </div>
      )}
      {notice && (
        <p className={styles.saved} role="status">
          <Check aria-hidden="true" />
          {notice}
        </p>
      )}
      <div className={`${styles.content} ${selected ? styles.hasSelection : ''}`}>
        <div className={`${styles.listPanel} ${selected ? styles.listWhenSelected : ''}`}>
          <div className={styles.listHeading}>
            <h3>本项目方案</h3>
            <span aria-live="polite">
              {reading ? '正在读取…' : loaded ? `${scenarios.length} 个草案` : '尚未读取'}
            </span>
          </div>
          {!loaded && reading ? (
            <p className={styles.empty} role="status">
              正在读取规划方案…
            </p>
          ) : !loaded ? (
            <p className={styles.empty}>尚未读取到方案，请重新读取。</p>
          ) : scenarios.length === 0 ? (
            <div className={styles.empty}>
              <h3>还没有规划方案</h3>
              <p>新建一个草案，为本项目保留独立的规划上下文。</p>
            </div>
          ) : (
            <ul className={styles.list} aria-label="规划方案列表">
              {scenarios.map((scenario) => (
                <li key={scenario.id}>
                  <Button
                    className={`${styles.row} ${selected?.id === scenario.id ? styles.selected : ''}`}
                    aria-label={`打开规划方案 ${scenario.name}`}
                    aria-pressed={selected?.id === scenario.id}
                    disabled={busy || reading}
                    onClick={() => void openScenario(scenario)}
                  >
                    <span className={styles.rowCopy}>
                      <strong>{scenario.name}</strong>
                      <span>草案 · 输入版本 {scenario.inputVersion}</span>
                    </span>
                    <ArrowRight aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selected ? (
          <section className={styles.detail} aria-label="当前规划方案">
            <Button
              className={`text-button ${styles.back}`}
              disabled={busy || reading}
              onClick={() => {
                setSelected(null);
                setNotice('');
              }}
            >
              <ArrowLeft aria-hidden="true" />
              返回方案列表
            </Button>
            <div className={styles.detailHeading}>
              <div>
                <p className={styles.project}>项目：{project.name}</p>
                <h2>{selected.name}</h2>
              </div>
              <span className={styles.draft}>草案</span>
            </div>
            <p className={styles.version}>输入版本 {selected.inputVersion}</p>
            <dl className={styles.facts}>
              <div>
                <dt>最近保存</dt>
                <dd>
                  <time dateTime={selected.updatedAt}>{savedTime(selected.updatedAt)}</time>
                </dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>
                  <time dateTime={selected.createdAt}>{savedTime(selected.createdAt)}</time>
                </dd>
              </div>
            </dl>
            <p className={styles.description}>
              草案已保存在本机。关闭页面或重启服务后，可从本项目重新打开。
            </p>
            <TransportCycles
              key={selected.id}
              scenario={selected}
              disabled={busy || reading}
              onChange={(saved) => {
                setSelected(saved);
                setScenarios((items) => items.map((item) => (item.id === saved.id ? saved : item)));
              }}
              onWritingChange={(value) => {
                writing.current = value;
                if (value) generation.current++;
                setBusy(value);
                setReading(false);
              }}
            />
            <TransportDemands
              key={`demands-${selected.id}`}
              scenario={selected}
              disabled={busy || reading}
              onChange={(saved) => {
                setSelected(saved);
                setScenarios((items) => items.map((item) => (item.id === saved.id ? saved : item)));
              }}
              onWritingChange={(value) => {
                writing.current = value;
                if (value) generation.current++;
                setBusy(value);
                setReading(false);
              }}
            />
            <FleetOperations
              key={`operations-${selected.id}`}
              scenario={selected}
              disabled={busy || reading}
              onChange={(saved) => {
                setSelected(saved);
                setScenarios((items) => items.map((item) => (item.id === saved.id ? saved : item)));
              }}
              onWritingChange={(value) => {
                writing.current = value;
                if (value) generation.current++;
                setBusy(value);
                setReading(false);
              }}
            />
            <div className={styles.detailActions}>
              <Button
                className="button"
                disabled={busy || reading}
                onClick={() => {
                  setError('');
                  setEditor({ scenario: selected, name: selected.name });
                }}
                aria-label="重命名规划方案"
              >
                <Pencil aria-hidden="true" />
                重命名
              </Button>
              <Button
                className="text-button danger-text"
                disabled={busy || reading}
                onClick={() => {
                  setError('');
                  setDeleting(selected);
                }}
                aria-label="删除规划方案"
              >
                <Trash2 aria-hidden="true" />
                删除草案
              </Button>
            </div>
          </section>
        ) : scenarios.length > 0 ? (
          <div className={styles.unselected}>
            <h3>选择一个草案继续</h3>
            <p>打开后核对方案名称、输入版本与保存时间。</p>
          </div>
        ) : null}
      </div>
      {editor && (
        <Dialog
          title={editor.scenario ? '重命名规划方案' : '新建规划方案'}
          error={error}
          onClose={closeDialog}
        >
          <form onSubmit={saveName}>
            <label className="field">
              方案名称
              <Input
                autoFocus
                required
                maxLength={200}
                value={editor.name}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                placeholder="例如：港区倒短换电规划"
              />
            </label>
            <p className="helper">所属项目：{project.name}</p>
            <div className="dialog-actions">
              <Button className="button" disabled={busy} onClick={closeDialog}>
                取消
              </Button>
              <Button
                type="submit"
                className="button primary"
                disabled={busy || !editor.name.trim()}
              >
                {busy ? '保存中…' : editor.scenario ? '保存名称' : '创建方案'}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {deleting && (
        <Dialog
          title="删除规划方案"
          description="确认永久删除规划方案草案，此操作无法撤销。"
          error={error}
          onClose={closeDialog}
        >
          <p className="delete-description">
            确定删除“{deleting.name}”？此草案的规划资料将一并删除，项目线路与点位库继续保留。
          </p>
          <div className="dialog-actions">
            <Button className="button" disabled={busy} onClick={closeDialog}>
              取消
            </Button>
            <Button className="button danger" disabled={busy} onClick={() => void deleteScenario()}>
              {busy ? '删除中…' : '确认删除方案'}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
