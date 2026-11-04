import { api } from '@/server/http';
import { abortRoadTask } from '@/server/directed-road-planning';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string; scenarioId: string; taskId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(_request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId, taskId } = await context.params;
    storage.directedRoads.stop(projectId, scenarioId, taskId);
    abortRoadTask(taskId);
    return Response.json(storage.directedRoads.getView(projectId, scenarioId));
  });
}
