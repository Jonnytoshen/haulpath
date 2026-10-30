export type CoordinateSystem = 'GCJ-02' | 'WGS84';
export const strategyGroups = [
  {
    label: '常用偏好',
    options: [
      { value: 32, label: '高德推荐', description: '采用高德地图 App 默认的推荐策略。' },
      { value: 33, label: '躲避拥堵', description: '优先避开拥堵路段。' },
      { value: 34, label: '高速优先', description: '优先选择高速道路。' },
      { value: 35, label: '不走高速', description: '按不走高速策略测算。' },
      { value: 36, label: '少收费', description: '偏向收费较少的路线，不等于不走收费路段。' },
      { value: 37, label: '大路优先', description: '优先选择大路。' },
      { value: 38, label: '速度最快', description: '按高德的速度最快策略测算。' },
    ],
  },
  {
    label: '组合偏好',
    options: [
      { value: 39, label: '躲避拥堵＋高速优先', description: '优先避开拥堵路段，并优先选择高速道路。' },
      { value: 40, label: '躲避拥堵＋不走高速', description: '结合躲避拥堵与不走高速策略测算。' },
      { value: 41, label: '躲避拥堵＋少收费', description: '结合躲避拥堵与少收费偏好测算。' },
      { value: 42, label: '少收费＋不走高速', description: '结合少收费与不走高速策略测算。' },
      { value: 43, label: '躲避拥堵＋少收费＋不走高速', description: '结合躲避拥堵、少收费与不走高速策略测算。' },
      { value: 44, label: '躲避拥堵＋大路优先', description: '优先避开拥堵路段，并优先选择大路。' },
      { value: 45, label: '躲避拥堵＋速度最快', description: '结合躲避拥堵与速度最快策略测算。' },
    ],
  },
  {
    label: '其他策略',
    options: [
      { value: 0, label: '速度优先', description: '只返回一条路线，不一定距离最短。' },
      { value: 1, label: '费用优先', description: '只返回一条不走收费路段、耗时最少的路线。' },
      { value: 2, label: '常规最快', description: '只返回一条路线，综合距离与耗时规划。' },
    ],
  },
] as const;

export type Strategy = (typeof strategyGroups)[number]['options'][number]['value'];
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
export const strategyLabels = Object.fromEntries(strategyGroups.flatMap((group) => group.options.map((option) => [option.value, option.label]))) as Record<Strategy, string>;

export function isStrategy(input: unknown): input is Strategy {
  return strategyGroups.some((group) => group.options.some((option) => option.value === input));
}

export function routeStatus(route: Route): '已规划' | '待重算' | '未规划' {
  if (!route.snapshot) return '未规划';
  return route.snapshot.inputVersion === route.inputVersion ? '已规划' : '待重算';
}

export function formatKilometers(integerMeters: number): string {
  return (integerMeters / 1000).toFixed(3);
}
