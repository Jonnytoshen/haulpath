import type { CoordinateSystem, Point, PointSource } from './index';

/** A project resource describing supply evidence, independently of any candidate station site. */
export interface PowerConnectionPoint extends Point {
  projectId: string;
  availableCapacityKw: number | null;
  capacitySource: string;
  connectionNotes: string;
}

/** Coordinates in this write contract always mean the user's original declared coordinates. */
export interface PowerConnectionPointInput {
  id?: string;
  name: string;
  longitude: number;
  latitude: number;
  coordinateSystem: CoordinateSystem;
  source?: PointSource;
  availableCapacityKw: number | null;
  capacitySource: string;
  connectionNotes: string;
}

export interface PowerConnectionPointSet {
  projectId: string;
  revision: number;
  points: PowerConnectionPoint[];
}

/** Completeness of supply evidence is not confirmation that a station can connect. */
export function powerConnectionPointReadiness(
  point: Pick<PowerConnectionPoint, 'availableCapacityKw' | 'capacitySource'>,
): string[] {
  const gaps: string[] = [];
  if (point.availableCapacityKw === null) gaps.push('缺少可用容量');
  else if (point.availableCapacityKw === 0) gaps.push('可用容量为 0，当前不可供电');
  if (!point.capacitySource.trim()) gaps.push('缺少容量来源');
  return gaps;
}
