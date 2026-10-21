export type CoordinateSystem = 'GCJ-02' | 'WGS84';
export type Strategy = 32 | 34 | 36;
export type PointSource = 'manual' | 'map' | 'search' | 'import' | 'library';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Point {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  originalLongitude: number;
  originalLatitude: number;
  coordinateSystem: CoordinateSystem;
  source: PointSource;
  poiId?: string;
}

export interface Leg {
  index: number;
  from: Point;
  to: Point;
  distanceMeters: number;
  polyline: [number, number][];
}

export interface PlanningSnapshot {
  inputVersion: number;
  points: Point[];
  strategy: Strategy;
  legs: Leg[];
  totalDistanceMeters: number;
  calculatedAt: string;
}

export interface PlanningState {
  taskId: string;
  inputVersion: number;
  status: 'running' | 'failed';
  completed: number;
  total: number;
  error?: string;
}

export interface Route {
  id: string;
  projectId: string;
  name: string;
  points: Point[];
  strategy: Strategy;
  inputVersion: number;
  snapshot: PlanningSnapshot | null;
  planning: PlanningState | null;
  createdAt: string;
  updatedAt: string;
}

export const PLANNING_NOTICE = '未校验重卡限高、限重及货车限行';
export const strategyLabels: Record<Strategy, string> = { 32: '高德推荐', 34: '高速优先', 36: '少收费' };

export function routeStatus(route: Route): '已规划' | '待重算' | '未规划' {
  if (!route.snapshot) return '未规划';
  return route.snapshot.inputVersion === route.inputVersion ? '已规划' : '待重算';
}

export function formatKilometers(integerMeters: number): string {
  return (integerMeters / 1000).toFixed(3);
}
