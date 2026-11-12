import { api, HttpError, readJson } from '@/server/http';
import {
  assertScenarioEditable,
  scenarioFields,
  scenarioRevision,
} from '@/server/scenario-validation';
import { stationNetworkOf } from '@/server/station-network-validation';
import { generateCandidateSites } from '@/server/candidate-generation';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string; scenarioId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function PUT(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    const body = await readJson(request);
    scenarioFields(body, ['expectedRevision', 'network']);
    const revision = scenarioRevision(body.expectedRevision);
    const scenario = storage.getScenario(projectId, scenarioId);
    assertScenarioEditable(scenario);
    if (revision !== scenario.revision)
      throw new HttpError(409, '规划方案已被更新，请重新加载后编辑');
    const powers = storage.getPowerConnectionPoints(projectId);
    const network = await stationNetworkOf(body.network, scenario, powers);
    // stationNetworkOf has validated these rows. Import actions must be rechecked even
    // when a locally edited snapshot still carries the current source revision.
    const sourceInputs = (
      body.network as {
        powerSources: { id?: string; refreshSource?: boolean }[];
      }
    ).powerSources;
    const importsSource = sourceInputs.some(
      (source) => source.id === undefined || source.refreshSource === true,
    );
    return Response.json(
      storage.replaceStationNetwork(
        projectId,
        scenarioId,
        revision,
        network,
        importsSource ? powers.revision : null,
      ),
    );
  });
}

/** Explicit generation saves suggestions against the current immutable input basis. */
export function POST(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    const body = await readJson(request);
    scenarioFields(body, ['expectedRevision']);
    const revision = scenarioRevision(body.expectedRevision);
    const scenario = storage.getScenario(projectId, scenarioId);
    assertScenarioEditable(scenario);
    if (revision !== scenario.revision)
      throw new HttpError(409, '规划方案已被更新，请重新加载后生成');
    const network = generateCandidateSites(scenario.context);
    if (!scenario.context.stationNetwork && !network.sites.length) return Response.json(scenario);
    return Response.json(
      storage.replaceStationNetwork(projectId, scenarioId, revision, network, null),
    );
  });
}
