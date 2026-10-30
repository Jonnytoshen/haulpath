export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api(handler: () => Response | Promise<Response>): Promise<Response> {
  try { return await handler(); }
  catch (error) {
    if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
    console.error('Application request failed', error instanceof Error ? error.message : 'unknown error');
    return Response.json({ error: '本机服务处理失败，请重试或检查服务日志' }, { status: 500 });
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await request.json(); }
  catch { throw new HttpError(400, '请求必须包含有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求内容必须为对象');
  return value as Record<string, unknown>;
}

export function projectIdFrom(request: Request): string {
  const id = new URL(request.url).searchParams.get('projectId');
  if (!id) throw new HttpError(400, '缺少项目标识');
  return id;
}
