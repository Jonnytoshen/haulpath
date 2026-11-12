import { api, readJson, HttpError } from '@/server/http';
import { storage } from '@/server/storage';
import { after } from 'next/server';
import { runDailyTransportTask } from '@/server/daily-transport-planning';
import { scenarioFields } from '@/server/scenario-validation';
type Context = { params: Promise<{ projectId: string; scenarioId: string; taskId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId, taskId } = await context.params;
    const source = storage.dailyTransport.getSummary(projectId, scenarioId, taskId);
    if (source.config.stage !== 'annual-transport') throw new HttpError(404, '年度任务不存在');
    const body = await readJson(request);
    scenarioFields(body, ['expectedRevision', 'maxRuntimeMs']);
    const task = storage.dailyTransport.continue(
      projectId,
      scenarioId,
      taskId,
      body.expectedRevision,
      body.maxRuntimeMs,
    );
    after(() => runDailyTransportTask(projectId, scenarioId, task.taskId));
    return Response.json(storage.dailyTransport.getView(projectId, scenarioId, true), {
      status: 202,
    });
  });
}
