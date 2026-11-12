import { after } from 'next/server';
import { dailyTransportConfig } from '@/server/daily-transport-storage';
import { runDailyTransportTask } from '@/server/daily-transport-planning';
import { scenarioFields } from '@/server/scenario-validation';
import { api, readJson, HttpError } from '@/server/http';
import { storage } from '@/server/storage';
type Context = { params: Promise<{ projectId: string; scenarioId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function PUT(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    return Response.json(
      storage.replaceAnnualTransport(projectId, scenarioId, await readJson(request)),
    );
  });
}

export function GET(_request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    return Response.json(storage.dailyTransport.getView(projectId, scenarioId, true));
  });
}
export function POST(request: Request, context: Context) {
  return api(async () => {
    const { projectId, scenarioId } = await context.params;
    const body = await readJson(request);
    scenarioFields(body, ['expectedRevision', 'config']);
    const config = dailyTransportConfig(body.config);
    if (config.stage !== undefined && config.stage !== 'annual-transport')
      throw new HttpError(400, '年度分析阶段无效');
    const task = storage.dailyTransport.begin(projectId, scenarioId, body.expectedRevision, {
      ...config,
      stage: 'annual-transport',
    });
    after(() => runDailyTransportTask(projectId, scenarioId, task.taskId));
    return Response.json(storage.dailyTransport.getView(projectId, scenarioId, true), {
      status: 202,
    });
  });
}
