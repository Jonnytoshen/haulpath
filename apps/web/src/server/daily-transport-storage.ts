import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  DailyTransportConfig,
  DailyTransportProgress,
  DailyTransportResult,
  DailyTransportTask,
  DailyTransportTaskSummary,
  DailyTransportView,
  PlanningScenario,
  RoadPreparationView,
  RoadTaskStatus,
} from '@haulpath/domain';
import {
  DAILY_TRANSPORT_ALGORITHM_VERSION,
  dailyTransportReadiness,
  stationNetworkReadiness,
} from '@haulpath/domain';
import type { DirectedRoadStorage } from './directed-road-storage';
import { HttpError } from './http';
import { assertScenarioEditable, scenarioRevision } from './scenario-validation';

const active = (task: DailyTransportTaskSummary) =>
  task.status === 'queued' || task.status === 'running';
type SummaryRow = { summary: string };
type DetailRow = { snapshot: string; result: string | null };

export function dailyTransportConfig(value: unknown): DailyTransportConfig {
  if (value === undefined) return { seed: 1, maxRuntimeMs: 600000 };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, '运输试算配置须为对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['seed', 'maxRuntimeMs'].includes(key)))
    throw new HttpError(400, '运输试算配置包含未知字段');
  const seed = input.seed ?? 1;
  const maxRuntimeMs = input.maxRuntimeMs ?? 600000;
  if (!Number.isSafeInteger(seed) || (seed as number) < 0)
    throw new HttpError(400, '随机种子须为非负安全整数');
  if (
    !Number.isInteger(maxRuntimeMs) ||
    (maxRuntimeMs as number) < 300000 ||
    (maxRuntimeMs as number) > 7200000
  )
    throw new HttpError(400, '运输试算时限须为5至120分钟');
  return { seed: seed as number, maxRuntimeMs: maxRuntimeMs as number };
}

/** Polling and progress only touch task summaries. Historical input/result blobs are immutable. */
export class DailyTransportStorage {
  constructor(
    private db: Database.Database,
    private scenario: (projectId: string, scenarioId: string) => PlanningScenario,
    private roads: DirectedRoadStorage,
  ) {
    this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT summary FROM daily_transport_tasks
        WHERE json_extract(summary, '$.status') IN ('queued', 'running')`,
        )
        .all() as SummaryRow[];
      for (const row of rows)
        this.finish(
          JSON.parse(row.summary),
          'interrupted',
          '上次运输试算因服务中断而停止，请重新试算',
        );
    })();
  }
  private writeSummary(task: DailyTransportTaskSummary): void {
    this.db
      .prepare('UPDATE daily_transport_tasks SET summary = ? WHERE id = ?')
      .run(JSON.stringify(task), task.taskId);
  }
  private finish(
    task: DailyTransportTaskSummary,
    status: RoadTaskStatus,
    error: string | null,
  ): void {
    task.status = status;
    task.error = error;
    task.finishedAt = new Date().toISOString();
    this.writeSummary(task);
  }
  private settle(
    task: DailyTransportTaskSummary,
    scenario: PlanningScenario,
  ): DailyTransportTaskSummary {
    if (!active(task)) return task;
    if (task.inputVersion !== scenario.inputVersion || scenario.status !== 'draft')
      this.finish(task, 'superseded', '方案输入已变化或版本已冻结，本次运输试算已停止');
    else if (task.startedAt && Date.now() - Date.parse(task.startedAt) >= task.config.maxRuntimeMs)
      this.finish(task, 'timed-out', '运输试算已达到时限，请重新试算');
    return task;
  }
  private list(scenario: PlanningScenario): DailyTransportTaskSummary[] {
    const rows = this.db
      .prepare(
        'SELECT summary FROM daily_transport_tasks WHERE project_id = ? AND scenario_id = ? ORDER BY rowid DESC',
      )
      .all(scenario.projectId, scenario.id) as SummaryRow[];
    return rows.map((row) => this.settle(JSON.parse(row.summary), scenario));
  }
  getSummary(projectId: string, scenarioId: string, taskId: string): DailyTransportTaskSummary {
    const scenario = this.scenario(projectId, scenarioId);
    const row = this.db
      .prepare(
        'SELECT summary FROM daily_transport_tasks WHERE id = ? AND project_id = ? AND scenario_id = ?',
      )
      .get(taskId, projectId, scenarioId) as SummaryRow | undefined;
    if (!row) throw new HttpError(404, '该规划方案下的运输试算任务不存在');
    return this.settle(JSON.parse(row.summary), scenario);
  }
  private details(task: DailyTransportTaskSummary): DailyTransportTask {
    const row = this.db
      .prepare('SELECT snapshot, result FROM daily_transport_task_details WHERE task_id = ?')
      .get(task.taskId) as DetailRow;
    return {
      ...task,
      snapshot: JSON.parse(row.snapshot),
      result: row.result === null ? null : JSON.parse(row.result),
    };
  }
  getTask(projectId: string, scenarioId: string, taskId: string): DailyTransportTask {
    return this.details(this.getSummary(projectId, scenarioId, taskId));
  }
  private gaps(scenario: PlanningScenario, roads: RoadPreparationView): string[] {
    const gaps = dailyTransportReadiness({
      context: scenario.context,
      roads: roads.roads,
      revision: scenario.revision,
    });
    gaps.push(...stationNetworkReadiness(scenario.context, 'transport'));
    if (!roads.currentReady) gaps.unshift('当前输入版本的有向道路尚未完成显式准备');
    return gaps;
  }
  getView(projectId: string, scenarioId: string): DailyTransportView {
    const scenario = this.scenario(projectId, scenarioId);
    const tasks = this.list(scenario);
    const resultTask = tasks.find((task) => task.status === 'completed');
    return {
      projectId,
      scenarioId,
      inputVersion: scenario.inputVersion,
      gaps: this.gaps(scenario, this.roads.getView(projectId, scenarioId)),
      task: tasks[0] ?? null,
      tasks,
      resultTask: resultTask ? this.details(resultTask) : null,
    };
  }
  begin(
    projectId: string,
    scenarioId: string,
    expectedRevision: unknown,
    config: DailyTransportConfig,
  ): DailyTransportTaskSummary {
    return this.db.transaction(() => {
      const scenario = this.scenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      if (scenarioRevision(expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后试算');
      const roads = this.roads.getView(projectId, scenarioId);
      const gaps = this.gaps(scenario, roads);
      if (gaps.length) throw new HttpError(400, gaps.join('；'));
      const existing = this.list(scenario).find(active);
      if (existing) return existing;
      const task: DailyTransportTaskSummary = {
        taskId: randomUUID(),
        projectId,
        scenarioId,
        inputVersion: scenario.inputVersion,
        status: 'queued',
        algorithmVersion: DAILY_TRANSPORT_ALGORITHM_VERSION,
        config,
        progress: {
          completedTrips: 0,
          completedTonnes: 0,
          totalTonnes: (scenario.context.transportDemands ?? []).reduce(
            (sum, demand) => sum + demand.dailyTonnes,
            0,
          ),
        },
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      };
      this.db
        .prepare(
          'INSERT INTO daily_transport_tasks (id, project_id, scenario_id, summary) VALUES (?, ?, ?, ?)',
        )
        .run(task.taskId, projectId, scenarioId, JSON.stringify(task));
      this.db
        .prepare('INSERT INTO daily_transport_task_details (task_id, snapshot) VALUES (?, ?)')
        .run(
          task.taskId,
          JSON.stringify({
            context: scenario.context,
            roads: roads.roads,
            revision: scenario.revision,
          }),
        );
      return task;
    })();
  }
  start(projectId: string, scenarioId: string, taskId: string): DailyTransportTask | null {
    return this.db.transaction(() => {
      const task = this.getSummary(projectId, scenarioId, taskId);
      if (task.status !== 'queued') return null;
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      this.writeSummary(task);
      return this.details(task);
    })();
  }
  progress(
    projectId: string,
    scenarioId: string,
    taskId: string,
    progress: DailyTransportProgress,
  ): boolean {
    return this.db.transaction(() => {
      const task = this.getSummary(projectId, scenarioId, taskId);
      if (task.status !== 'running') return false;
      task.progress = progress;
      this.writeSummary(task);
      return true;
    })();
  }
  complete(
    projectId: string,
    scenarioId: string,
    taskId: string,
    result: DailyTransportResult,
  ): boolean {
    return this.db.transaction(() => {
      const task = this.getSummary(projectId, scenarioId, taskId);
      if (task.status !== 'running') return false;
      if (
        !result.validation.valid ||
        result.validation.issues.length ||
        result.algorithmVersion !== task.algorithmVersion ||
        result.seed !== task.config.seed
      )
        throw new Error('运输试算独立校验未通过或算法依据不匹配');
      task.progress = {
        completedTrips: result.trips.length,
        completedTonnes: result.totalCompletedTonnes,
        totalTonnes: task.progress.totalTonnes,
      };
      this.db
        .prepare('UPDATE daily_transport_task_details SET result = ? WHERE task_id = ?')
        .run(JSON.stringify(result), task.taskId);
      this.finish(task, 'completed', null);
      return true;
    })();
  }
  fail(
    projectId: string,
    scenarioId: string,
    taskId: string,
    timeout: boolean,
    error: string,
  ): void {
    const task = this.getSummary(projectId, scenarioId, taskId);
    if (active(task)) this.finish(task, timeout ? 'timed-out' : 'failed', error);
  }
  stop(projectId: string, scenarioId: string, taskId: string): void {
    const task = this.getSummary(projectId, scenarioId, taskId);
    if (active(task)) this.finish(task, 'stopped', '已停止运输试算，已有完整结果继续保留');
  }
}
