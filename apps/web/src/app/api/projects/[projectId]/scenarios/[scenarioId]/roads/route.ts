import { after } from 'next/server';
import { api, readJson } from '@/server/http';
import { scenarioFields } from '@/server/scenario-validation';
import { runRoadTask } from '@/server/directed-road-planning';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string; scenarioId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(_request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    return Response.json(storage.directedRoads.getView(projectId, scenarioId));
  });
}

export function POST(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    const body = await readJson(request);
    scenarioFields(body, ['expectedRevision']);
    const task = storage.directedRoads.begin(projectId, scenarioId, body.expectedRevision);
    after(() => runRoadTask(projectId, scenarioId, task.taskId));
    return Response.json(storage.directedRoads.getView(projectId, scenarioId), { status: 202 });
  });
}
