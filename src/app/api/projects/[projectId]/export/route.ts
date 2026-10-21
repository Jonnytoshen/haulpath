import { exportWorkbook } from '@/server/export';
import { api, HttpError } from '@/server/http';
import { storage } from '@/server/storage';

type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request, context: Context) {
  return api(async () => {
    const { projectId } = await context.params;
    const project = storage.getProject(projectId);
    const parameters = new URL(request.url).searchParams;
    const routeId = parameters.get('routeId');
    if (routeId === '') throw new HttpError(400, '线路标识不能为空');
    const routes = routeId === null ? storage.listRoutes(projectId) : [storage.getRoute(routeId, projectId)];
    const content = await exportWorkbook(project, routes);
    const filename = `${project.name}${routeId ? `-${routes[0].name}` : ''}.xlsx`;
    return new Response(content, { headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="zhongtu.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    } });
  });
}
