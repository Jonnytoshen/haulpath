import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PlanningSnapshot, Point, Project, Route } from '@/lib/domain';
import { HttpError } from './http';

import { nameOf, pointOf, pointsOf, strategyOf } from './validation';

class Storage {
  private db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 1) throw new Error('本机数据库版本比当前应用更新，请使用匹配的应用版本');
    if (version === 0) this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS routes_project ON routes(project_id);
        CREATE TABLE IF NOT EXISTS points (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS points_project ON points(project_id);`);
      this.db.pragma('user_version = 1');
    })();
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
    return this.db.prepare('SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY created_at, id').all() as Project[];
  }
  getProject(id: string): Project {
    const project = this.db.prepare('SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?').get(id) as Project | undefined;
    if (!project) throw new HttpError(404, '项目不存在');
    return project;
  }
  createProject(input: { name?: unknown }): Project {
    const time = new Date().toISOString();
    const project = { id: randomUUID(), name: nameOf(input.name), createdAt: time, updatedAt: time };
    this.db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)').run(project.id, project.name, time, time);
    return project;
  }
  updateProject(id: string, input: {name?: unknown}): Project {
    this.getProject(id);
    this.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(nameOf(input.name), new Date().toISOString(), id);
    return this.getProject(id);
  }
  deleteProject(id: string): void {
    this.getProject(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
  listRoutes(projectId: string): Route[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT payload FROM routes WHERE project_id = ? ORDER BY rowid').all(projectId) as {payload: string}[]).map((row) => JSON.parse(row.payload) as Route);
  }
  getRoute(routeId: string, projectId: string): Route {
    this.getProject(projectId);
    const row = this.db.prepare('SELECT payload FROM routes WHERE id = ? AND project_id = ?').get(routeId, projectId) as {payload: string} | undefined;
    if (!row) throw new HttpError(404, '该项目下的线路不存在');
    return JSON.parse(row.payload) as Route;
  }
  createRoute(projectId: string, input: {name?: unknown; points?: unknown; strategy?: unknown}): Route {
    this.getProject(projectId);
    const time = new Date().toISOString();
    const route: Route = { id: randomUUID(), projectId, name: nameOf(input.name), points: input.points === undefined ? [] : pointsOf(input.points), strategy: input.strategy === undefined ? 32 : strategyOf(input.strategy), inputVersion: 1, snapshot: null, planning: null, createdAt: time, updatedAt: time };
    this.db.prepare('INSERT INTO routes VALUES (?, ?, ?)').run(route.id, projectId, JSON.stringify(route));
    return route;
  }
  updateRoute(routeId: string, projectId: string, input: {name?: unknown; points?: unknown; strategy?: unknown; expectedVersion?: unknown}): Route {
    return this.db.transaction(() => {
      const route = this.getRoute(routeId, projectId);
      if (input.expectedVersion !== undefined) {
        if (!Number.isInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) throw new HttpError(400, '线路输入版本无效');
        if (input.expectedVersion !== route.inputVersion) throw new HttpError(409, '线路已被更新，请重新加载后编辑');
      }
      if (input.name !== undefined) route.name = nameOf(input.name);
      const points = input.points === undefined ? route.points : pointsOf(input.points);
      const strategy = input.strategy === undefined ? route.strategy : strategyOf(input.strategy);
      const inputChanged = strategy !== route.strategy || JSON.stringify(points) !== JSON.stringify(route.points);
      if (inputChanged) {
        route.inputVersion++;
        route.planning = null;
      }
      route.points = points;
      route.strategy = strategy;
      route.updatedAt = new Date().toISOString();
      this.writeRoute(route);
      return route;
    })();
  }
  deleteRoute(routeId: string, projectId: string): void {
    this.getRoute(routeId, projectId);
    this.db.prepare('DELETE FROM routes WHERE id = ? AND project_id = ?').run(routeId, projectId);
  }
  listPoints(projectId: string): Point[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT payload FROM points WHERE project_id = ? ORDER BY rowid').all(projectId) as {payload: string}[]).map((row) => JSON.parse(row.payload) as Point);
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
      const row = this.db.prepare('SELECT payload FROM points WHERE id = ? AND project_id = ?').get(pointId, projectId) as {payload:string} | undefined;
      if (!row) throw new HttpError(404, '该项目下的点位不存在');
      const point = pointOf({ ...JSON.parse(row.payload), ...input, id: pointId });
      this.db.prepare('UPDATE points SET payload = ? WHERE id = ? AND project_id = ?').run(JSON.stringify(point), pointId, projectId);
      return point;
    })();
  }
  deletePoint(projectId: string, pointId: string): void {
    this.getProject(projectId);
    const deleted = this.db.prepare('DELETE FROM points WHERE id = ? AND project_id = ?').run(pointId, projectId);
    if (!deleted.changes) throw new HttpError(404, '该项目下的点位不存在');
  }
  beginPlanning(routeId: string, projectId: string): Route {
    return this.db.transaction(() => {
      const route = this.getRoute(routeId, projectId);
      if (route.points.length < 2) throw new HttpError(400, '规划至少需要两个有效点位');
      for (let index = 1; index < route.points.length; index++) {
        const from = route.points[index - 1];
        const to = route.points[index];
        if (from.longitude === to.longitude && from.latitude === to.latitude) throw new HttpError(400, `第${index}与第${index + 1}个点位坐标相同，请调整后规划`);
      }
      route.planning = { taskId: randomUUID(), inputVersion: route.inputVersion, status: 'running', completed: 0, total: route.points.length - 1 };
      route.updatedAt = new Date().toISOString();
      this.writeRoute(route);
      return route;
    })();
  }
  updatePlanning(routeId: string, projectId: string, taskId: string, inputVersion: number, completed: number): boolean {
    return this.mutatePlanning(routeId, projectId, taskId, inputVersion, (route) => {
      if (!Number.isInteger(completed) || completed < route.planning!.completed || completed > route.planning!.total) throw new HttpError(400, '区间进度无效');
      route.planning!.completed = completed;
    });
  }
  completePlanning(routeId: string, projectId: string, taskId: string, inputVersion: number, snapshot: PlanningSnapshot): boolean {
    if (snapshot.inputVersion !== inputVersion) return false;
    return this.mutatePlanning(routeId, projectId, taskId, inputVersion, (route) => {
      route.snapshot = snapshot;
      route.planning = null;
    });
  }
  failPlanning(routeId: string, projectId: string, taskId: string, inputVersion: number, error: string): boolean {
    return this.mutatePlanning(routeId, projectId, taskId, inputVersion, (route) => {
      route.planning!.status = 'failed';
      route.planning!.error = error;
    });
  }
  private mutatePlanning(routeId: string, projectId: string, taskId: string, inputVersion: number, mutate: (route: Route) => void): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT payload FROM routes WHERE id = ? AND project_id = ?').get(routeId, projectId) as {payload: string} | undefined;
      if (!row) return false;
      const route = JSON.parse(row.payload) as Route;
      if (route.inputVersion !== inputVersion || route.planning?.inputVersion !== inputVersion || route.planning?.taskId !== taskId || route.planning.status !== 'running') return false;
      mutate(route);
      route.updatedAt = new Date().toISOString();
      this.writeRoute(route);
      return true;
    })();
  }
  private writeRoute(route: Route): void {
    this.db.prepare('UPDATE routes SET payload = ? WHERE id = ? AND project_id = ?').run(JSON.stringify(route), route.id, route.projectId);
  }
}

const globalStorage = globalThis as typeof globalThis & { zhongtuStorage?: { path: string; storage: Storage } };
export function getStorage(): Storage {
  const path = resolve(/* turbopackIgnore: true */ process.env.ZHONGTU_DB_PATH || 'data/zhongtu.sqlite');
  if (globalStorage.zhongtuStorage?.path !== path) globalStorage.zhongtuStorage = { path, storage: new Storage(path) };
  return globalStorage.zhongtuStorage.storage;
}
export const storage = new Proxy({} as Storage, { get(_target, property) {
  const repository = getStorage();
  const value = Reflect.get(repository, property);
  return typeof value === 'function' ? value.bind(repository) : value;
} });
