import { api } from '@/server/http';
import { abortDailyTransportTask } from '@/server/daily-transport-planning';
import { storage } from '@/server/storage';
type Context = { params: Promise<{ projectId: string; scenarioId: string; taskId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(_request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId, taskId } = await context.params;
    storage.dailyTransport.stop(projectId, scenarioId, taskId);
    abortDailyTransportTask(taskId);
    return Response.json(storage.dailyTransport.getView(projectId, scenarioId));
  });
}
