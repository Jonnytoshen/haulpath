import { randomUUID } from 'node:crypto';
import {
  emptyStationNetwork,
  type CandidateSite,
  type PlanningScenarioContext,
  type Point,
} from '@haulpath/domain';
import { HttpError } from './http';
import { pointOf } from './validation';

/** Input locations only: no inferred land, road access, power association or confirmation. */
export function generateCandidateSites(context: PlanningScenarioContext) {
  const network = context.stationNetwork ?? emptyStationNetwork();
  const usedOrigins = new Set(
    network.sites.flatMap(
      (site) => site.generationBasis?.origins.map((origin) => origin.key) ?? [],
    ),
  );
  const existingSites = structuredClone(network.sites);
  const locations = new Map<string, CandidateSite>();
  function suggest(point: Point, key: string, label: string) {
    if (usedOrigins.has(key)) return;
    const location = JSON.stringify([point.longitude, point.latitude]);
    // Exact locations are collapsed only for proposing suggestions, never for engineering associations.
    const existing = existingSites.find(
      (site) => site.longitude === point.longitude && site.latitude === point.latitude,
    );
    if (existing) {
      // A newly adopted co-located source must remain recognized after a later manual move.
      existing.generationBasis?.origins.push({ key, label });
      return;
    }
    const previous = locations.get(location);
    if (previous) {
      previous.generationBasis!.origins.push({ key, label });
      return;
    }
    locations.set(location, {
      ...pointOf({ ...point, id: randomUUID() }),
      name: `${point.name} · 初步候选`,
      source: 'generated',
      generationBasis: { algorithm: 'input-locations-v1', origins: [{ key, label }] },
      siteNotes: '',
      siteConfirmed: false,
      connection: null,
    });
  }
  for (const cycle of context.transportCycles ?? [])
    for (const position of cycle.positions)
      suggest(
        position.point,
        `cycle:${cycle.id}:${position.id}`,
        `运输循环「${cycle.name}」业务位置「${position.point.name}」`,
      );
  for (const source of network.powerSources)
    suggest(source.point, `power:${source.id}`, `方案电源快照「${source.point.name}」`);
  const sites = [...existingSites, ...locations.values()];
  if (sites.length > 1000)
    throw new HttpError(400, '生成后超过1000个候选，请先缩减候选或输入范围；本次未保存');
  return { ...network, sites };
}
