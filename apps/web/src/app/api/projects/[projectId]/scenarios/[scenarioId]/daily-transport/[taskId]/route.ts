import { api } from '@/server/http';
import { storage } from '@/server/storage';
type Context = { params: Promise<{ projectId: string; scenarioId: string; taskId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId, taskId } = await context.params;
    if (new URL(request.url).searchParams.get('summary') === '1')
      return Response.json(storage.dailyTransport.getSummary(projectId, scenarioId, taskId));
    return Response.json(storage.dailyTransport.getTask(projectId, scenarioId, taskId));
  });
}
