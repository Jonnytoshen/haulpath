import { api, HttpError } from '@/server/http';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request, context: Context) {
  return api(async () => {
    const { projectId } = await context.params;
    const query = new URL(request.url).searchParams;
    const left = query.get('left');
    const right = query.get('right');
    if (!left || !right) throw new HttpError(400, '请选择要比较的两个方案版本');
    return Response.json(storage.compareScenarios(projectId, left, right));
  });
}
