import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  PowerConnectionPoint,
  PowerConnectionPointSet,
  PlanningScenario,
  ScenarioComparison,
  PlanningSnapshot,
  Point,
  Project,
  Route,
  Strategy,
  StationNetwork,
  TransportCycle,
} from '@haulpath/domain';
import { scenarioInputDifferences } from '@haulpath/domain';
import { HttpError } from './http';

import { nameOf, pointOf, pointsOf, strategyOf } from './validation';
import {
  assertScenarioEditable,
  scenarioContext,
  scenarioFields,
  scenarioRevision,
} from './scenario-validation';
import { cyclePositions, confirmCycle } from './transport-cycle-validation';
import { transportDemandsOf } from './transport-demand-validation';
import { fleetOperationsOf } from './fleet-operations-validation';
import { powerResourceRevision } from './power-connection-points-validation';
import { DirectedRoadStorage } from './directed-road-storage';
import { DailyTransportStorage } from './daily-transport-storage';

function readScenario(payload: string): PlanningScenario {
  const scenario = JSON.parse(payload) as PlanningScenario;
  return {
    ...scenario,
    lineageId: scenario.lineageId ?? scenario.id,
    copiedFrom: scenario.copiedFrom ?? null,
    frozenAt: scenario.frozenAt ?? null,
  };
}

function cycleSourceInputs(source: TransportCycle['source']) {
  return {
    ...source,
    importedAt: null,
    snapshot: source.snapshot ? { ...source.snapshot, calculatedAt: null } : null,
  };
}

class Storage {
  private db: Database.Database;
  readonly directedRoads: DirectedRoadStorage;
  readonly dailyTransport: DailyTransportStorage;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 6) throw new Error('本机数据库版本比当前应用更新，请使用匹配的应用版本');
    if (version === 0)
      this.db.transaction(() => {
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS routes_project ON routes(project_id);
        CREATE TABLE IF NOT EXISTS points (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS points_project ON points(project_id);`);
        this.db.pragma('user_version = 1');
      })();
    if (version < 2)
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE projects ADD COLUMN last_strategy INTEGER NOT NULL DEFAULT 32');
        this.db.pragma('user_version = 2');
      })();
    if (version < 3)
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE planning_scenarios (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          payload TEXT NOT NULL
        );
        CREATE INDEX planning_scenarios_project ON planning_scenarios(project_id);`);
        this.db.pragma('user_version = 3');
      })();
    if (version < 4)
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE project_power_connection_points (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          payload TEXT NOT NULL
        );`);
        this.db.pragma('user_version = 4');
      })();
    if (version < 5)
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE road_preparation_tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          scenario_id TEXT NOT NULL REFERENCES planning_scenarios(id) ON DELETE CASCADE,
          payload TEXT NOT NULL
        );
        CREATE INDEX road_preparation_tasks_scenario ON road_preparation_tasks(project_id, scenario_id);
        CREATE TABLE directed_roads (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          road_key TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (project_id, road_key)
        );`);
        this.db.pragma('user_version = 5');
      })();
    if (version < 6)
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE daily_transport_tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          scenario_id TEXT NOT NULL REFERENCES planning_scenarios(id) ON DELETE CASCADE,
          payload TEXT NOT NULL
        ); CREATE INDEX daily_transport_tasks_scenario ON daily_transport_tasks(project_id, scenario_id);`);
        this.db.pragma('user_version = 6');
      })();
    this.directedRoads = new DirectedRoadStorage(this.db, (projectId, scenarioId) =>
      this.getScenario(projectId, scenarioId),
    );
    this.dailyTransport = new DailyTransportStorage(
      this.db,
      (projectId, scenarioId) => this.getScenario(projectId, scenarioId),
      this.directedRoads,
    );
    // The process-global storage instance survives route reloads; only an initial open recovers abandoned work.
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT payload FROM routes').all() as { payload: string }[];
      for (const row of rows) {
        const route = JSON.parse(row.payload) as Route;
        if (route.planning?.status !== 'running') continue;
        route.planning.status = 'failed';
        route.planning.error = '上次规划因服务中断而停止，请重新规划';
        route.updatedAt = new Date().toISOString();
        this.writeRoute(route);
      }
    })();
  }
  listProjects(): Project[] {
    return this.db
      .prepare(
        'SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY created_at, id',
      )
      .all() as Project[];
  }
  getProject(id: string): Project {
    const project = this.db
      .prepare(
        'SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?',
      )
      .get(id) as Project | undefined;
    if (!project) throw new HttpError(404, '项目不存在');
    return project;
  }
  createProject(input: { name?: unknown }): Project {
    const time = new Date().toISOString();
    const project = {
      id: randomUUID(),
      name: nameOf(input.name),
      createdAt: time,
      updatedAt: time,
    };
    this.db
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(project.id, project.name, time, time);
    return project;
  }
  updateProject(id: string, input: { name?: unknown }): Project {
    this.getProject(id);
    this.db
      .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
      .run(nameOf(input.name), new Date().toISOString(), id);
    return this.getProject(id);
  }
  deleteProject(id: string): void {
    this.getProject(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
  getPowerConnectionPoints(projectId: string): PowerConnectionPointSet {
    this.getProject(projectId);
    const row = this.db
      .prepare('SELECT payload FROM project_power_connection_points WHERE project_id = ?')
      .get(projectId) as { payload: string } | undefined;
    return row
      ? (JSON.parse(row.payload) as PowerConnectionPointSet)
      : { projectId, revision: 1, points: [] };
  }
  replacePowerConnectionPoints(
    projectId: string,
    expectedRevision: number,
    points: PowerConnectionPoint[],
  ): PowerConnectionPointSet {
    return this.db.transaction(() => {
      const current = this.getPowerConnectionPoints(projectId);
      if (powerResourceRevision(expectedRevision) !== current.revision)
        throw new HttpError(409, '电源接入点已被更新，请重新加载后编辑');
      // The asynchronous coordinate boundary has finished; recheck the exact project revision here.
      if (points.some((point) => point.projectId !== projectId))
        throw new HttpError(400, '电源接入点不属于当前项目');
      if (isDeepStrictEqual(points, current.points)) return current;
      const updated = { projectId, revision: current.revision + 1, points };
      this.db
        .prepare(
          `INSERT INTO project_power_connection_points (project_id, payload) VALUES (?, ?)
          ON CONFLICT(project_id) DO UPDATE SET payload = excluded.payload`,
        )
        .run(projectId, JSON.stringify(updated));
      return updated;
    })();
  }
  listScenarios(projectId: string): PlanningScenario[] {
    this.getProject(projectId);
    return (
      this.db
        .prepare('SELECT payload FROM planning_scenarios WHERE project_id = ? ORDER BY rowid')
        .all(projectId) as { payload: string }[]
    ).map((row) => readScenario(row.payload));
  }
  getScenario(projectId: string, scenarioId: string): PlanningScenario {
    this.getProject(projectId);
    const row = this.db
      .prepare('SELECT payload FROM planning_scenarios WHERE id = ? AND project_id = ?')
      .get(scenarioId, projectId) as { payload: string } | undefined;
    if (!row) throw new HttpError(404, '该项目下的规划方案不存在');
    return readScenario(row.payload);
  }
  compareScenarios(projectId: string, leftId: string, rightId: string): ScenarioComparison {
    return this.db.transaction(() => {
      const left = this.getScenario(projectId, leftId);
      const right = this.getScenario(projectId, rightId);
      return { left, right, differences: scenarioInputDifferences(left.context, right.context) };
    })();
  }
  createScenario(projectId: string, input: Record<string, unknown>): PlanningScenario {
    return this.db.transaction(() => {
      this.getProject(projectId);
      scenarioFields(input, ['name']);
      const time = new Date().toISOString();
      const id = randomUUID();
      const scenario: PlanningScenario = {
        id,
        projectId,
        name: nameOf(input.name),
        status: 'draft',
        lineageId: id,
        copiedFrom: null,
        frozenAt: null,
        inputVersion: 1,
        revision: 1,
        context: { schemaVersion: 1, resources: {}, annual: [], results: [] },
        createdAt: time,
        updatedAt: time,
      };
      this.db
        .prepare('INSERT INTO planning_scenarios VALUES (?, ?, ?)')
        .run(scenario.id, projectId, JSON.stringify(scenario));
      return scenario;
    })();
  }
  freezeScenario(
    projectId: string,
    scenarioId: string,
    input: Record<string, unknown>,
  ): PlanningScenario {
    return this.db.transaction(() => {
      const scenario = this.getScenario(projectId, scenarioId);
      scenarioFields(input, ['expectedRevision']);
      if (scenarioRevision(input.expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后冻结');
      assertScenarioEditable(scenario);
      scenario.status = 'frozen';
      scenario.frozenAt = new Date().toISOString();
      scenario.updatedAt = scenario.frozenAt;
      scenario.revision++;
      this.db
        .prepare('UPDATE planning_scenarios SET payload = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(scenario), scenarioId, projectId);
      return scenario;
    })();
  }
  copyScenario(
    projectId: string,
    scenarioId: string,
    input: Record<string, unknown>,
  ): PlanningScenario {
    return this.db.transaction(() => {
      const source = this.getScenario(projectId, scenarioId);
      scenarioFields(input, ['expectedRevision', 'name']);
      if (scenarioRevision(input.expectedRevision) !== source.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后复制');
      const time = new Date().toISOString();
      const context = scenarioContext(structuredClone(source.context));
      context.results = [];
      const copied: PlanningScenario = {
        id: randomUUID(),
        projectId,
        name: nameOf(input.name),
        status: 'draft',
        lineageId: source.lineageId,
        copiedFrom: {
          scenarioId: source.id,
          name: source.name,
          inputVersion: source.inputVersion,
          revision: source.revision,
        },
        frozenAt: null,
        inputVersion: 1,
        revision: 1,
        context,
        createdAt: time,
        updatedAt: time,
      };
      this.db
        .prepare('INSERT INTO planning_scenarios VALUES (?, ?, ?)')
        .run(copied.id, projectId, JSON.stringify(copied));
      return copied;
    })();
  }
  updateScenario(
    projectId: string,
    scenarioId: string,
    input: Record<string, unknown>,
  ): PlanningScenario {
    return this.db.transaction(() => {
      const scenario = this.getScenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      scenarioFields(input, ['name', 'context', 'expectedRevision']);
      if (scenarioRevision(input.expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后编辑');
      const name = input.name === undefined ? scenario.name : nameOf(input.name);
      const context =
        input.context === undefined ? scenario.context : scenarioContext(input.context);
      if (!isDeepStrictEqual(context.transportCycles, scenario.context.transportCycles))
        throw new HttpError(400, '运输循环须通过专用接口维护，不能直接覆盖');
      if (!isDeepStrictEqual(context.transportDemands, scenario.context.transportDemands))
        throw new HttpError(400, '运输需求须通过专用接口维护，不能直接覆盖');
      if (!isDeepStrictEqual(context.operations, scenario.context.operations))
        throw new HttpError(400, '车辆与运营资料须通过专用接口维护，不能直接覆盖');
      if (!isDeepStrictEqual(context.stationNetwork, scenario.context.stationNetwork))
        throw new HttpError(400, '站网资料须通过专用接口维护，不能直接覆盖');
      if (!isDeepStrictEqual(context.roadSettings, scenario.context.roadSettings))
        throw new HttpError(400, '道路准备偏好须通过专用接口维护，不能直接覆盖');
      const inputChanged = !isDeepStrictEqual(context, scenario.context);
      if (name === scenario.name && !inputChanged) return scenario;
      if (inputChanged) scenario.inputVersion++;
      scenario.name = name;
      scenario.context = context;
      scenario.revision++;
      scenario.updatedAt = new Date().toISOString();
      this.db
        .prepare('UPDATE planning_scenarios SET payload = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(scenario), scenarioId, projectId);
      return scenario;
    })();
  }
  replaceRoadSettings(
    projectId: string,
    scenarioId: string,
    input: Record<string, unknown>,
  ): PlanningScenario {
    return this.db.transaction(() => {
      const scenario = this.getScenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      scenarioFields(input, ['expectedRevision', 'continuationStrategy']);
      if (scenarioRevision(input.expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后编辑');
      const continuationStrategy = strategyOf(input.continuationStrategy);
      if (continuationStrategy === (scenario.context.roadSettings?.continuationStrategy ?? 32))
        return scenario;
      scenario.context.roadSettings = { continuationStrategy };
      scenario.inputVersion++;
      scenario.revision++;
      scenario.updatedAt = new Date().toISOString();
      this.db
        .prepare('UPDATE planning_scenarios SET payload = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(scenario), scenarioId, projectId);
      return scenario;
    })();
  }
  deleteScenario(projectId: string, scenarioId: string, expectedRevision: unknown): void {
    this.db.transaction(() => {
      const scenario = this.getScenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      if (scenarioRevision(expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后删除');
      this.db
        .prepare('DELETE FROM planning_scenarios WHERE id = ? AND project_id = ?')
        .run(scenarioId, projectId);
    })();
  }
  createTransportCycle(
    projectId: string,
    scenarioId: string,
    input: Record<string, unknown>,
  ): PlanningScenario {
    return this.db.transaction(() => {
      const scenario = this.getScenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      scenarioFields(input, ['sourceRouteId', 'expectedRevision']);
      if (scenarioRevision(input.expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后编辑');
      if (typeof input.sourceRouteId !== 'string' || !input.sourceRouteId)
        throw new HttpError(400, '请选择来源线路');
      const route = this.getRoute(input.sourceRouteId, projectId);
      const cycle: TransportCycle = {
        id: randomUUID(),
        name: route.name,
        strategy: route.strategy,
        positions: route.points.map((point) => ({
          id: randomUUID(),
          point,
          sourcePointId: point.id,
        })),
        source: {
          routeId: route.id,
          name: route.name,
          inputVersion: route.inputVersion,
          points: route.points,
          strategy: route.strategy,
          snapshot: route.snapshot,
          importedAt: new Date().toISOString(),
        },
        roads: [],
        confirmed: false,
        confirmedAt: null,
      };
      if (route.snapshot?.inputVersion === route.inputVersion) {
        cycle.roads = route.snapshot.legs.map((leg, index) => ({
          fromPositionId: cycle.positions[index].id,
          toPositionId: cycle.positions[index + 1].id,
          strategy: route.snapshot!.strategy,
          leg,
        }));
      }
      scenario.context.transportCycles = [...(scenario.context.transportCycles ?? []), cycle];
      scenario.inputVersion++;
      scenario.revision++;
      scenario.updatedAt = new Date().toISOString();
      this.db
        .prepare('UPDATE planning_scenarios SET payload = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(scenario), scenarioId, projectId);
      return scenario;
    })();
  }
  refreshTransportCycleSource(
    projectId: string,
    scenarioId: string,
    cycleId: string,
    input: Record<string, unknown>,
  ): PlanningScenario {
    return this.db.transaction(() => {
      const scenario = this.getScenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      scenarioFields(input, ['expectedRevision']);
      if (scenarioRevision(input.expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后引入资料');
      const cycle = scenario.context.transportCycles?.find((candidate) => candidate.id === cycleId);
      if (!cycle) throw new HttpError(404, '该规划方案下的运输循环不存在');
      const route = this.getRoute(cycle.source.routeId, projectId);
      const latestSource: TransportCycle['source'] = {
        routeId: route.id,
        name: route.name,
        inputVersion: route.inputVersion,
        points: route.points,
        strategy: route.strategy,
        snapshot: route.snapshot,
        importedAt: cycle.source.importedAt,
      };
      // An unchanged source must never discard independent edits in the scenario.
      if (isDeepStrictEqual(cycleSourceInputs(latestSource), cycleSourceInputs(cycle.source)))
        return scenario;
      const positionsBySource = new Map<string, string[]>();
      for (const position of cycle.positions) {
        if (position.sourcePointId === null) continue;
        const occurrences = positionsBySource.get(position.sourcePointId) ?? [];
        occurrences.push(position.id);
        positionsBySource.set(position.sourcePointId, occurrences);
      }
      cycle.name = route.name;
      cycle.strategy = route.strategy;
      cycle.positions = route.points.map((point) => ({
        id: positionsBySource.get(point.id)?.shift() ?? randomUUID(),
        point,
        sourcePointId: point.id,
      }));
      cycle.source = { ...latestSource, importedAt: new Date().toISOString() };
      cycle.roads = [];
      if (route.snapshot?.inputVersion === route.inputVersion) {
        cycle.roads = route.snapshot.legs.map((leg, index) => ({
          fromPositionId: cycle.positions[index].id,
          toPositionId: cycle.positions[index + 1].id,
          strategy: route.snapshot!.strategy,
          leg,
        }));
      }
      cycle.confirmed = false;
      cycle.confirmedAt = null;
      // Demands, measured segments and base-start evidence retain their identities for explicit repair.
      scenario.inputVersion++;
      scenario.revision++;
      scenario.updatedAt = new Date().toISOString();
      this.db
        .prepare('UPDATE planning_scenarios SET payload = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(scenario), scenarioId, projectId);
      return scenario;
    })();
  }
  updateTransportCycle(
    projectId: string,
    scenarioId: string,
    cycleId: string,
    input: Record<string, unknown>,
  ): PlanningScenario {
    return this.db.transaction(() => {
      const scenario = this.getScenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      const cycle = scenario.context.transportCycles?.find((candidate) => candidate.id === cycleId);
      if (!cycle) throw new HttpError(404, '该规划方案下的运输循环不存在');
      scenarioFields(input, ['name', 'strategy', 'positions', 'confirmed', 'expectedRevision']);
      if (scenarioRevision(input.expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后编辑');
      if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean')
        throw new HttpError(400, '循环确认状态无效');
      const before = JSON.stringify(cycle);
      const positions =
        input.positions === undefined ? cycle.positions : cyclePositions(input.positions, cycle);
      const strategy = input.strategy === undefined ? cycle.strategy : strategyOf(input.strategy);
      const businessChanged =
        strategy !== cycle.strategy || !isDeepStrictEqual(positions, cycle.positions);
      cycle.name = input.name === undefined ? cycle.name : nameOf(input.name);
      cycle.positions = positions;
      cycle.strategy = strategy;
      if (businessChanged || input.confirmed === false) {
        cycle.confirmed = false;
        cycle.confirmedAt = null;
      }
      if (input.confirmed === true) {
        confirmCycle(cycle);
        cycle.confirmed = true;
        cycle.confirmedAt ??= new Date().toISOString();
      }
      if (before === JSON.stringify(cycle)) return scenario;
      scenario.inputVersion++;
      scenario.revision++;
      scenario.updatedAt = new Date().toISOString();
      this.db
        .prepare('UPDATE planning_scenarios SET payload = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(scenario), scenarioId, projectId);
      return scenario;
    })();
  }
  deleteTransportCycle(
    projectId: string,
    scenarioId: string,
    cycleId: string,
    expectedRevision: unknown,
  ): PlanningScenario {
    return this.db.transaction(() => {
      const scenario = this.getScenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      const cycles = scenario.context.transportCycles ?? [];
      if (!cycles.some((cycle) => cycle.id === cycleId))
        throw new HttpError(404, '该规划方案下的运输循环不存在');
      if (scenarioRevision(expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后删除');
      scenario.context.transportCycles = cycles.filter((cycle) => cycle.id !== cycleId);
      scenario.inputVersion++;
      scenario.revision++;
      scenario.updatedAt = new Date().toISOString();
      this.db
        .prepare('UPDATE planning_scenarios SET payload = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(scenario), scenarioId, projectId);
      return scenario;
    })();
  }
  replaceTransportDemands(
    projectId: string,
    scenarioId: string,
    input: Record<string, unknown>,
  ): PlanningScenario {
    return this.db.transaction(() => {
      const scenario = this.getScenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      scenarioFields(input, ['expectedRevision', 'demands']);
      if (scenarioRevision(input.expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后编辑');
      const demands = transportDemandsOf(input.demands, scenario);
      if (isDeepStrictEqual(demands, scenario.context.transportDemands ?? [])) return scenario;
      scenario.context.transportDemands = demands;
      scenario.inputVersion++;
      scenario.revision++;
      scenario.updatedAt = new Date().toISOString();
      this.db
        .prepare('UPDATE planning_scenarios SET payload = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(scenario), scenarioId, projectId);
      return scenario;
    })();
  }
  replaceFleetOperations(
    projectId: string,
    scenarioId: string,
    input: Record<string, unknown>,
  ): PlanningScenario {
    return this.db.transaction(() => {
      const scenario = this.getScenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      scenarioFields(input, ['expectedRevision', 'operations']);
      if (scenarioRevision(input.expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后编辑');
      const operations = fleetOperationsOf(input.operations, scenario);
      if (isDeepStrictEqual(operations, scenario.context.operations)) return scenario;
      scenario.context.operations = operations;
      scenario.inputVersion++;
      scenario.revision++;
      scenario.updatedAt = new Date().toISOString();
      this.db
        .prepare('UPDATE planning_scenarios SET payload = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(scenario), scenarioId, projectId);
      return scenario;
    })();
  }
  replaceStationNetwork(
    projectId: string,
    scenarioId: string,
    expectedRevision: number,
    network: StationNetwork,
    importedPowerRevision: number | null,
  ): PlanningScenario {
    return this.db.transaction(() => {
      const scenario = this.getScenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      if (expectedRevision !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后编辑');
      if (
        importedPowerRevision !== null &&
        this.getPowerConnectionPoints(projectId).revision !== importedPowerRevision
      )
        throw new HttpError(409, '项目电源接入点已被更新，请重新引入');
      if (isDeepStrictEqual(network, scenario.context.stationNetwork)) return scenario;
      scenario.context.stationNetwork = network;
      scenario.inputVersion++;
      scenario.revision++;
      scenario.updatedAt = new Date().toISOString();
      this.db
        .prepare('UPDATE planning_scenarios SET payload = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(scenario), scenarioId, projectId);
      return scenario;
    })();
  }
  listRoutes(projectId: string): Route[] {
    this.getProject(projectId);
    return (
      this.db
        .prepare('SELECT payload FROM routes WHERE project_id = ? ORDER BY rowid')
        .all(projectId) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as Route);
  }
  getRoute(routeId: string, projectId: string): Route {
    this.getProject(projectId);
    const row = this.db
      .prepare('SELECT payload FROM routes WHERE id = ? AND project_id = ?')
      .get(routeId, projectId) as { payload: string } | undefined;
    if (!row) throw new HttpError(404, '该项目下的线路不存在');
    return JSON.parse(row.payload) as Route;
  }
  createRoute(
    projectId: string,
    input: { name?: unknown; points?: unknown; strategy?: unknown },
  ): Route {
    return this.db.transaction(() => {
      this.getProject(projectId);
      const time = new Date().toISOString();
      const strategy =
        input.strategy === undefined
          ? (
              this.db
                .prepare('SELECT last_strategy AS strategy FROM projects WHERE id = ?')
                .get(projectId) as { strategy: Strategy }
            ).strategy
          : strategyOf(input.strategy);
      const route: Route = {
        id: randomUUID(),
        projectId,
        name: nameOf(input.name),
        points: input.points === undefined ? [] : pointsOf(input.points),
        strategy,
        inputVersion: 1,
        snapshot: null,
        planning: null,
        createdAt: time,
        updatedAt: time,
      };
      this.db
        .prepare('INSERT INTO routes VALUES (?, ?, ?)')
        .run(route.id, projectId, JSON.stringify(route));
      if (input.strategy !== undefined) this.rememberStrategy(projectId, strategy);
      return route;
    })();
  }
  updateRoute(
    routeId: string,
    projectId: string,
    input: { name?: unknown; points?: unknown; strategy?: unknown; expectedVersion?: unknown },
  ): Route {
    return this.db.transaction(() => {
      const route = this.getRoute(routeId, projectId);
      if (input.expectedVersion !== undefined) {
        if (!Number.isInteger(input.expectedVersion) || (input.expectedVersion as number) < 1)
          throw new HttpError(400, '线路输入版本无效');
        if (input.expectedVersion !== route.inputVersion)
          throw new HttpError(409, '线路已被更新，请重新加载后编辑');
      }
      if (input.name !== undefined) route.name = nameOf(input.name);
      const points = input.points === undefined ? route.points : pointsOf(input.points);
      const strategy = input.strategy === undefined ? route.strategy : strategyOf(input.strategy);
      const inputChanged =
        strategy !== route.strategy || JSON.stringify(points) !== JSON.stringify(route.points);
      if (inputChanged) {
        route.inputVersion++;
        route.planning = null;
      }
      route.points = points;
      route.strategy = strategy;
      route.updatedAt = new Date().toISOString();
      this.writeRoute(route);
      if (input.strategy !== undefined) this.rememberStrategy(projectId, strategy);
      return route;
    })();
  }
  deleteRoute(routeId: string, projectId: string): void {
    this.getRoute(routeId, projectId);
    this.db.prepare('DELETE FROM routes WHERE id = ? AND project_id = ?').run(routeId, projectId);
  }
  listPoints(projectId: string): Point[] {
    this.getProject(projectId);
    return (
      this.db
        .prepare('SELECT payload FROM points WHERE project_id = ? ORDER BY rowid')
        .all(projectId) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as Point);
  }
  addPoints(projectId: string, input: Point[]): Point[] {
    return this.db.transaction(() => {
      this.getProject(projectId);
      const points = pointsOf(input).map((point) => ({ ...point, id: randomUUID() }));
      const insert = this.db.prepare('INSERT INTO points VALUES (?, ?, ?)');
      for (const point of points) insert.run(point.id, projectId, JSON.stringify(point));
      return points;
    })();
  }
  updatePoint(projectId: string, pointId: string, input: Partial<Point>): Point {
    return this.db.transaction(() => {
      this.getProject(projectId);
      const row = this.db
        .prepare('SELECT payload FROM points WHERE id = ? AND project_id = ?')
        .get(pointId, projectId) as { payload: string } | undefined;
      if (!row) throw new HttpError(404, '该项目下的点位不存在');
      const point = pointOf({ ...JSON.parse(row.payload), ...input, id: pointId });
      this.db
        .prepare('UPDATE points SET payload = ? WHERE id = ? AND project_id = ?')
        .run(JSON.stringify(point), pointId, projectId);
      return point;
    })();
  }
  deletePoint(projectId: string, pointId: string): void {
    this.getProject(projectId);
    const deleted = this.db
      .prepare('DELETE FROM points WHERE id = ? AND project_id = ?')
      .run(pointId, projectId);
    if (!deleted.changes) throw new HttpError(404, '该项目下的点位不存在');
  }
  beginPlanning(routeId: string, projectId: string): Route {
    return this.db.transaction(() => {
      const route = this.getRoute(routeId, projectId);
      if (route.points.length < 2) throw new HttpError(400, '规划至少需要两个有效点位');
      for (let index = 1; index < route.points.length; index++) {
        const from = route.points[index - 1];
        const to = route.points[index];
        if (from.longitude === to.longitude && from.latitude === to.latitude)
          throw new HttpError(400, `第${index}与第${index + 1}个点位坐标相同，请调整后规划`);
      }
      route.planning = {
        taskId: randomUUID(),
        inputVersion: route.inputVersion,
        status: 'running',
        completed: 0,
        total: route.points.length - 1,
      };
      route.updatedAt = new Date().toISOString();
      this.writeRoute(route);
      return route;
    })();
  }
  updatePlanning(
    routeId: string,
    projectId: string,
    taskId: string,
    inputVersion: number,
    completed: number,
  ): boolean {
    return this.mutatePlanning(routeId, projectId, taskId, inputVersion, (route) => {
      if (
        !Number.isInteger(completed) ||
        completed < route.planning!.completed ||
        completed > route.planning!.total
      )
        throw new HttpError(400, '区间进度无效');
      route.planning!.completed = completed;
    });
  }
  completePlanning(
    routeId: string,
    projectId: string,
    taskId: string,
    inputVersion: number,
    snapshot: PlanningSnapshot,
  ): boolean {
    if (snapshot.inputVersion !== inputVersion) return false;
    return this.mutatePlanning(routeId, projectId, taskId, inputVersion, (route) => {
      route.snapshot = snapshot;
      route.planning = null;
    });
  }
  failPlanning(
    routeId: string,
    projectId: string,
    taskId: string,
    inputVersion: number,
    error: string,
  ): boolean {
    return this.mutatePlanning(routeId, projectId, taskId, inputVersion, (route) => {
      route.planning!.status = 'failed';
      route.planning!.error = error;
    });
  }
  private mutatePlanning(
    routeId: string,
    projectId: string,
    taskId: string,
    inputVersion: number,
    mutate: (route: Route) => void,
  ): boolean {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT payload FROM routes WHERE id = ? AND project_id = ?')
        .get(routeId, projectId) as { payload: string } | undefined;
      if (!row) return false;
      const route = JSON.parse(row.payload) as Route;
      if (
        route.inputVersion !== inputVersion ||
        route.planning?.inputVersion !== inputVersion ||
        route.planning?.taskId !== taskId ||
        route.planning.status !== 'running'
      )
        return false;
      mutate(route);
      route.updatedAt = new Date().toISOString();
      this.writeRoute(route);
      return true;
    })();
  }
  private writeRoute(route: Route): void {
    this.db
      .prepare('UPDATE routes SET payload = ? WHERE id = ? AND project_id = ?')
      .run(JSON.stringify(route), route.id, route.projectId);
  }
  private rememberStrategy(projectId: string, strategy: Strategy): void {
    this.db.prepare('UPDATE projects SET last_strategy = ? WHERE id = ?').run(strategy, projectId);
  }
}

const globalStorage = globalThis as typeof globalThis & {
  haulpathStorage?: { path: string; storage: Storage };
};
export function getStorage(): Storage {
  const path = resolve(
    /* turbopackIgnore: true */ process.env.HAULPATH_DB_PATH || 'data/haulpath.sqlite',
  );
  if (globalStorage.haulpathStorage?.path !== path)
    globalStorage.haulpathStorage = { path, storage: new Storage(path) };
  return globalStorage.haulpathStorage.storage;
}
export const storage = new Proxy({} as Storage, {
  get(_target, property) {
    const repository = getStorage();
    const value = Reflect.get(repository, property);
    return typeof value === 'function' ? value.bind(repository) : value;
  },
});
