import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  PlanningScenario,
  PreparedRoad,
  RoadPreparationTask,
  RoadPreparationView,
  RoadRequirement,
  RoadTaskStatus,
  RoadTaskSummary,
} from '@haulpath/domain';
import { reusableCycleRoads, roadRequirements } from '@haulpath/domain';
import { HttpError } from './http';
import { assertScenarioEditable, scenarioRevision } from './scenario-validation';

export const ROAD_TASK_TIMEOUT_MS = 30 * 60 * 1000;

function active(task: RoadPreparationTask): boolean {
  return task.status === 'running' || task.status === 'queued';
}

function summary(task: RoadPreparationTask): RoadTaskSummary {
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    scenarioId: task.scenarioId,
    inputVersion: task.inputVersion,
    status: task.status,
    completed: task.completed,
    total: task.total,
    reused: task.reused,
    error: task.error,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

/** The same SQLite connection owns scenario reads, task transitions and cache publication. */
export class DirectedRoadStorage {
  constructor(
    private db: Database.Database,
    private scenario: (projectId: string, scenarioId: string) => PlanningScenario,
  ) {
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT payload FROM road_preparation_tasks').all() as {
        payload: string;
      }[];
      for (const row of rows) {
        const task = JSON.parse(row.payload) as RoadPreparationTask;
        if (active(task))
          this.finish(task, 'interrupted', '上次道路准备因服务中断而停止，请重新准备');
      }
    })();
  }

  private write(task: RoadPreparationTask): void {
    this.db
      .prepare(
        `INSERT INTO road_preparation_tasks (id, project_id, scenario_id, payload) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(task.taskId, task.projectId, task.scenarioId, JSON.stringify(task));
  }

  private finish(task: RoadPreparationTask, status: RoadTaskStatus, error: string | null): void {
    task.status = status;
    task.error = error;
    task.finishedAt = new Date().toISOString();
    this.write(task);
  }

  private settle(task: RoadPreparationTask, scenario: PlanningScenario): RoadPreparationTask {
    if (!active(task)) return task;
    if (scenario.inputVersion !== task.inputVersion || scenario.status !== 'draft')
      this.finish(task, 'superseded', '方案输入已变化或版本已冻结，本次道路准备已停止');
    else if (Date.now() - Date.parse(task.createdAt) >= ROAD_TASK_TIMEOUT_MS)
      this.finish(task, 'timed-out', '道路准备已达到30分钟时限，请复用已有资料重新准备');
    return task;
  }

  private list(scenario: PlanningScenario): RoadPreparationTask[] {
    const rows = this.db
      .prepare(
        'SELECT payload FROM road_preparation_tasks WHERE project_id = ? AND scenario_id = ? ORDER BY rowid DESC',
      )
      .all(scenario.projectId, scenario.id) as { payload: string }[];
    return rows.map((row) => this.settle(JSON.parse(row.payload) as RoadPreparationTask, scenario));
  }

  getTask(projectId: string, scenarioId: string, taskId: string): RoadPreparationTask {
    const scenario = this.scenario(projectId, scenarioId);
    const row = this.db
      .prepare(
        'SELECT payload FROM road_preparation_tasks WHERE id = ? AND project_id = ? AND scenario_id = ?',
      )
      .get(taskId, projectId, scenarioId) as { payload: string } | undefined;
    if (!row) throw new HttpError(404, '该规划方案下的道路准备任务不存在');
    return this.settle(JSON.parse(row.payload) as RoadPreparationTask, scenario);
  }

  private cached(projectId: string, requirement: RoadRequirement): PreparedRoad | null {
    const row = this.db
      .prepare('SELECT payload FROM directed_roads WHERE project_id = ? AND road_key = ?')
      .get(projectId, requirement.key) as { payload: string } | undefined;
    if (!row) return null;
    // Cache identities are geographic; names and local object ids come from the current snapshot.
    return {
      ...(JSON.parse(row.payload) as PreparedRoad),
      from: requirement.from,
      to: requirement.to,
    };
  }

  private saveRoad(projectId: string, road: PreparedRoad): void {
    this.db
      .prepare(
        `INSERT INTO directed_roads (project_id, road_key, payload) VALUES (?, ?, ?)
        ON CONFLICT(project_id, road_key) DO UPDATE SET payload = excluded.payload`,
      )
      .run(projectId, road.key, JSON.stringify(road));
  }

  private available(
    scenario: PlanningScenario,
    requirements: RoadRequirement[],
    tasks = this.list(scenario),
  ): PreparedRoad[] {
    const completed = tasks.find(
      (task) => task.inputVersion === scenario.inputVersion && task.status === 'completed',
    );
    const adopted = new Map(completed?.roads.map((road) => [road.key, road]) ?? []);
    const imported = new Map(reusableCycleRoads(scenario.context).map((road) => [road.key, road]));
    return requirements.flatMap((requirement) => {
      // A completed version keeps its adopted roads. For a new input version, explicitly
      // imported cycle snapshots take precedence over geographic reuse from other scenarios.
      const road =
        adopted.get(requirement.key) ??
        imported.get(requirement.key) ??
        this.cached(scenario.projectId, requirement);
      if (road) return [{ ...road, from: requirement.from, to: requirement.to }];
      if (
        requirement.from.longitude === requirement.to.longitude &&
        requirement.from.latitude === requirement.to.latitude
      )
        return [
          {
            key: requirement.key,
            from: requirement.from,
            to: requirement.to,
            strategy: requirement.strategy,
            distanceMeters: 0,
            polyline: [],
            source: 'same-location' as const,
            preparedAt: scenario.updatedAt,
          },
        ];
      return [];
    });
  }

  getView(projectId: string, scenarioId: string): RoadPreparationView {
    const scenario = this.scenario(projectId, scenarioId);
    const requirements = roadRequirements(scenario.context);
    const tasks = this.list(scenario);
    const roads = this.available(scenario, requirements, tasks);
    const task = tasks[0] ?? null;
    return {
      projectId,
      scenarioId,
      inputVersion: scenario.inputVersion,
      settings: scenario.context.roadSettings ?? { continuationStrategy: 32 },
      requirements,
      roads,
      task,
      tasks: tasks.map(summary),
      currentReady:
        requirements.length > 0 &&
        roads.length === requirements.length &&
        tasks.some(
          (item) => item.inputVersion === scenario.inputVersion && item.status === 'completed',
        ),
      completed: roads.length,
      total: requirements.length,
    };
  }

  begin(projectId: string, scenarioId: string, expectedRevision: unknown): RoadPreparationTask {
    return this.db.transaction(() => {
      const scenario = this.scenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      if (scenarioRevision(expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后准备道路');
      const requirements = roadRequirements(scenario.context);
      if (!requirements.length) throw new HttpError(400, '请先建立至少包含两个点位的运输循环');
      const tasks = this.list(scenario);
      const running = tasks.find(active);
      if (running) return running;
      const roads = this.available(scenario, requirements, tasks);
      const task: RoadPreparationTask = {
        taskId: randomUUID(),
        projectId,
        scenarioId,
        inputVersion: scenario.inputVersion,
        status: 'queued',
        completed: roads.length,
        total: requirements.length,
        reused: roads.length,
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        snapshot: {
          context: structuredClone(scenario.context),
          revision: scenario.revision,
          requirements,
        },
        roads,
      };
      for (const road of roads) this.saveRoad(projectId, road);
      this.write(task);
      return task;
    })();
  }

  start(projectId: string, scenarioId: string, taskId: string): RoadPreparationTask | null {
    return this.db.transaction(() => {
      const task = this.getTask(projectId, scenarioId, taskId);
      if (task.status !== 'queued') return null;
      // Earlier queued work may have prepared matching project roads since this snapshot was created.
      const available = this.available(
        this.scenario(projectId, scenarioId),
        task.snapshot.requirements,
      );
      const prepared = new Set(task.roads.map((road) => road.key));
      for (const road of available) {
        if (prepared.has(road.key)) continue;
        task.roads.push(road);
        task.reused++;
      }
      task.completed = task.roads.length;
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      this.write(task);
      return task;
    })();
  }

  publish(projectId: string, scenarioId: string, taskId: string, road: PreparedRoad): boolean {
    return this.db.transaction(() => {
      const task = this.getTask(projectId, scenarioId, taskId);
      if (task.status !== 'running') return false;
      if (!task.snapshot.requirements.some((requirement) => requirement.key === road.key))
        throw new Error('Road does not belong to task snapshot');
      if (!task.roads.some((candidate) => candidate.key === road.key)) task.roads.push(road);
      task.completed = task.roads.length;
      this.saveRoad(projectId, road);
      this.write(task);
      return true;
    })();
  }

  complete(projectId: string, scenarioId: string, taskId: string): void {
    const task = this.getTask(projectId, scenarioId, taskId);
    if (task.status !== 'running') return;
    if (task.completed !== task.total) throw new Error('Cannot complete a partial road matrix');
    this.finish(task, 'completed', null);
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
    if (active(task)) this.finish(task, 'stopped', '已停止道路准备，已准备资料继续保留');
  }
}
