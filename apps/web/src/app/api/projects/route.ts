import { api, readJson } from '@/server/http';
import { storage } from '@/server/storage';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() { return api(() => Response.json(storage.listProjects())); }
export function POST(request: Request) { return api(async () => Response.json(storage.createProject(await readJson(request)), { status: 201 })); }
