import { api, HttpError } from '@/server/http';
import { storage } from '@/server/storage';
type Context = { params: Promise<{ projectId: string; scenarioId: string; taskId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId, taskId } = await context.params;
    const summary = storage.dailyTransport.getSummary(projectId, scenarioId, taskId);
    if (summary.config.stage !== 'annual-transport') throw new HttpError(404, '年度任务不存在');
    return Response.json(
      new URL(request.url).searchParams.get('summary') === '1'
        ? summary
        : storage.dailyTransport.getTask(projectId, scenarioId, taskId),
    );
  });
}
