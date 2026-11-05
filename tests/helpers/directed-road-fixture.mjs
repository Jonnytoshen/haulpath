import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

export const roadPoint = (id, name, longitude, latitude = 31.23) => ({
  id,
  name,
  longitude,
  latitude,
  originalLongitude: longitude,
  originalLatitude: latitude,
  coordinateSystem: 'GCJ-02',
  source: 'manual',
});

export async function roadFixture(request, name = '有向道路验收') {
  const project = (await request('/api/projects', 'POST', { name })).body;
  let scenario = (
    await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '道路准备方案' })
  ).body;
  const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
  const route = (
    await request(`/api/projects/${project.id}/routes`, 'POST', {
      name: '港区往返',
      strategy: 34,
      points: [
        roadPoint('a', '港区', 121.47),
        roadPoint('b', '堆场', 121.6),
        roadPoint('a-return', '港区返回', 121.47),
      ],
    })
  ).body;
  const saved = await request(`${path}/cycles`, 'POST', {
    sourceRouteId: route.id,
    expectedRevision: scenario.revision,
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  scenario = saved.body;
  return { project, scenario, path, route };
}

export function roadResponse(url, response, distance = '1001') {
  response.setHeader('Content-Type', 'application/json');
  response.end(
    JSON.stringify({
      status: '1',
      route: {
        paths: [
          {
            distance,
            steps: [
              {
                polyline: `${url.searchParams.get('origin')};121.5,31.25;${url.searchParams.get('destination')}`,
              },
            ],
          },
          { distance: '999999', steps: [{ polyline: '0,0;1,1' }] },
        ],
      },
    }),
  );
}

export async function waitRoadTask(request, path, taskId, expectedStatus) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await request(`${path}/roads/${taskId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const task = response.body.task ?? response.body;
    if (!['queued', 'running'].includes(task.status)) {
      if (expectedStatus) assert.equal(task.status, expectedStatus, JSON.stringify(task));
      return task;
    }
    await setTimeout(100);
  }
  assert.fail('道路任务未在等待期限内结束');
}
