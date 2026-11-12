import { api, HttpError } from '@/server/http';
import { storage } from '@/server/storage';
import { abortDailyTransportTask } from '@/server/daily-transport-planning';
type Context = { params: Promise<{ projectId: string; scenarioId: string; taskId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId, taskId } = await context.params;
    const source = storage.dailyTransport.getSummary(projectId, scenarioId, taskId);
    if (source.config.stage !== 'annual-transport') throw new HttpError(404, '年度任务不存在');
    storage.dailyTransport.stop(projectId, scenarioId, taskId);
    abortDailyTransportTask(taskId);
    return Response.json(storage.dailyTransport.getView(projectId, scenarioId, true));
  });
}
