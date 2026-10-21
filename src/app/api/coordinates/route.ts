import { api, readJson } from '@/server/http';
import { normalizeCoordinates } from '@/server/coordinates';

export const runtime = 'nodejs';
export function POST(request: Request) {
  return api(async () => Response.json(await normalizeCoordinates((await readJson(request)).points)));
}
