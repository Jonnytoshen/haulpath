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

const active = (task: DailyTransportTask) => ['queued', 'running'].includes(task.status);
function summary({ snapshot, result, ...task }: DailyTransportTask): DailyTransportTaskSummary {
  void snapshot;
  void result;
  return task;
}

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

/** Tasks and accepted results share the scenario's transaction/ownership boundary. */
export class DailyTransportStorage {
  constructor(
    private db: Database.Database,
    private scenario: (projectId: string, scenarioId: string) => PlanningScenario,
    private roads: DirectedRoadStorage,
  ) {
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT payload FROM daily_transport_tasks').all() as {
        payload: string;
      }[];
      for (const row of rows) {
        const task = JSON.parse(row.payload) as DailyTransportTask;
        if (active(task))
          this.finish(task, 'interrupted', '上次运输试算因服务中断而停止，请重新试算');
      }
    })();
  }
  private write(task: DailyTransportTask): void {
    this.db
      .prepare(
        `INSERT INTO daily_transport_tasks (id, project_id, scenario_id, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(task.taskId, task.projectId, task.scenarioId, JSON.stringify(task));
  }
  private finish(task: DailyTransportTask, status: RoadTaskStatus, error: string | null): void {
    task.status = status;
    task.error = error;
    task.finishedAt = new Date().toISOString();
    this.write(task);
  }
  private settle(task: DailyTransportTask, scenario: PlanningScenario): DailyTransportTask {
    if (!active(task)) return task;
    if (task.inputVersion !== scenario.inputVersion || scenario.status !== 'draft')
      this.finish(task, 'superseded', '方案输入已变化或版本已冻结，本次运输试算已停止');
    else if (task.startedAt && Date.now() - Date.parse(task.startedAt) >= task.config.maxRuntimeMs)
      this.finish(task, 'timed-out', '运输试算已达到时限，请重新试算');
    return task;
  }
  private list(scenario: PlanningScenario): DailyTransportTask[] {
    const rows = this.db
      .prepare(
        'SELECT payload FROM daily_transport_tasks WHERE project_id = ? AND scenario_id = ? ORDER BY rowid DESC',
      )
      .all(scenario.projectId, scenario.id) as { payload: string }[];
    return rows.map((row) => this.settle(JSON.parse(row.payload) as DailyTransportTask, scenario));
  }
  getTask(projectId: string, scenarioId: string, taskId: string): DailyTransportTask {
    const scenario = this.scenario(projectId, scenarioId);
    const row = this.db
      .prepare(
        'SELECT payload FROM daily_transport_tasks WHERE id = ? AND project_id = ? AND scenario_id = ?',
      )
      .get(taskId, projectId, scenarioId) as { payload: string } | undefined;
    if (!row) throw new HttpError(404, '该规划方案下的运输试算任务不存在');
    return this.settle(JSON.parse(row.payload) as DailyTransportTask, scenario);
  }
  getView(projectId: string, scenarioId: string): DailyTransportView {
    const scenario = this.scenario(projectId, scenarioId);
    const roads = this.roads.getView(projectId, scenarioId);
    const tasks = this.list(scenario);
    const gaps = dailyTransportReadiness({
      context: scenario.context,
      roads: roads.roads,
      revision: scenario.revision,
    });
    gaps.push(...stationNetworkReadiness(scenario.context, 'transport'));
    if (!roads.currentReady) gaps.unshift('当前输入版本的有向道路尚未完成显式准备');
    return {
      projectId,
      scenarioId,
      inputVersion: scenario.inputVersion,
      gaps,
      task: tasks[0] ?? null,
      tasks: tasks.map(summary),
      resultTask: tasks.find((task) => task.status === 'completed' && task.result !== null) ?? null,
    };
  }
  begin(
    projectId: string,
    scenarioId: string,
    expectedRevision: unknown,
    config: DailyTransportConfig,
  ): DailyTransportTask {
    return this.db.transaction(() => {
      const scenario = this.scenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      if (scenarioRevision(expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后试算');
      const view = this.getView(projectId, scenarioId);
      if (view.gaps.length) throw new HttpError(400, view.gaps.join('；'));
      const existing = this.list(scenario).find(active);
      if (existing) return existing;
      const roads = this.roads.getView(projectId, scenarioId).roads;
      const task: DailyTransportTask = {
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
        snapshot: {
          context: structuredClone(scenario.context),
          roads: structuredClone(roads),
          revision: scenario.revision,
        },
        result: null,
      };
      this.write(task);
      return task;
    })();
  }
  start(projectId: string, scenarioId: string, taskId: string): DailyTransportTask | null {
    return this.db.transaction(() => {
      const task = this.getTask(projectId, scenarioId, taskId);
      if (task.status !== 'queued') return null;
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      this.write(task);
      return task;
    })();
  }
  progress(
    projectId: string,
    scenarioId: string,
    taskId: string,
    progress: DailyTransportProgress,
  ): boolean {
    return this.db.transaction(() => {
      const task = this.getTask(projectId, scenarioId, taskId);
      if (task.status !== 'running') return false;
      task.progress = progress;
      this.write(task);
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
      const task = this.getTask(projectId, scenarioId, taskId);
      if (task.status !== 'running') return false;
      if (
        !result.validation.valid ||
        result.validation.issues.length ||
        result.algorithmVersion !== task.algorithmVersion ||
        result.seed !== task.config.seed
      )
        throw new Error('运输试算独立校验未通过或算法依据不匹配');
      task.result = result;
      task.progress = {
        completedTrips: result.trips.length,
        completedTonnes: result.totalCompletedTonnes,
        totalTonnes: task.progress.totalTonnes,
      };
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
    const task = this.getTask(projectId, scenarioId, taskId);
    if (active(task)) this.finish(task, timeout ? 'timed-out' : 'failed', error);
  }
  stop(projectId: string, scenarioId: string, taskId: string): void {
    const task = this.getTask(projectId, scenarioId, taskId);
    if (active(task)) this.finish(task, 'stopped', '已停止运输试算，已有完整结果继续保留');
  }
}
