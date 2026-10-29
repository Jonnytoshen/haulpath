import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createDockerApplication, docker, nativePlatform } from './helpers/application.mjs';
import { jsonRequest } from '../helpers/application.mjs';
import { amapEnvironment, injectAmap } from './helpers/amap.mjs';

// Deployment coverage uses existing public behavior; a direct green is not a manufactured bug-fix red phase.
test('a target-platform image plans and exports persisted project data and accepts new runtime credentials', { timeout: 1200000 }, async (context) => {
  const app = await createDockerApplication({ environment: amapEnvironment });
  try {
    const builtImage = JSON.parse((await docker(['image', 'inspect', app.image])).stdout)[0];
    assert.equal(builtImage.Architecture, app.platform.split('/')[1]);
    context.diagnostic(`${app.platform}：${app.platform === await nativePlatform() ? '原生' : '非原生'}运行，实际镜像架构 ${builtImage.Architecture}`);
    let upstream = await injectAmap(app);
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    const projectResponse = await request('/api/projects', 'POST', { name: '双架构容器项目' });
    assert.equal(projectResponse.status, 201);
    const project = projectResponse.body;
    const coordinates = await request('/api/coordinates', 'POST', { points: [
      { name: '上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '苏州客户', longitude: 120.58, latitude: 31.3, source: 'manual' },
      { name: '南京客户', longitude: 118.79, latitude: 32.06, source: 'manual' },
    ] });
    assert.equal(coordinates.status, 200);
    const library = (await request(`/api/projects/${project.id}/points`, 'POST', { points: coordinates.body })).body;
    const route = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '容器三站线路', points: library, strategy: 43 })).body;
    const routePath = `/api/routes/${route.id}?projectId=${project.id}`;
    const plan = await request(`/api/routes/${route.id}/plan?projectId=${project.id}`, 'POST');
    assert.equal(plan.status, 200);
    assert.equal(plan.body.snapshot.totalDistanceMeters, 4690);
    assert.deepEqual((await upstream.state()).driving.map(({ strategy }) => strategy), ['43', '43']);
    const response = await fetch(`${app.baseUrl}/api/projects/${project.id}/export`);
    assert.equal(response.status, 200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual(book.worksheets.map(({ name }) => name), ['线路总览', '区间明细']);
    assert.equal(book.getWorksheet('线路总览').getCell('G3').value, 4.69);
    assert.equal(book.getWorksheet('线路总览').getCell('G3').numFmt, '0.000');
    assert.equal(book.getWorksheet('区间明细').getCell('H4').value, 4.69);

    const id = await app.containerId();
    const previousImage = JSON.parse((await docker(['inspect', id])).stdout)[0].Image;
    await app.compose(['down']);
    const nextEnvironment = { ...amapEnvironment, AMAP_JS_KEY: 'changed-docker-js-key', AMAP_WEB_SERVICE_KEY: 'changed-docker-private-web-key' };
    await app.recreate(nextEnvironment);
    upstream = await injectAmap(app);
    assert.equal(JSON.parse((await docker(['inspect', await app.containerId()])).stdout)[0].Image, previousImage);
    assert.deepEqual((await request('/api/projects')).body, [project]);
    assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, library);
    assert.deepEqual((await request(routePath)).body.snapshot, plan.body.snapshot);
    const inherited = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '容器重建后继承偏好' });
    assert.equal(inherited.body.strategy, 43);
    const configResponse = await fetch(`${app.baseUrl}/api/config`);
    const configText = await configResponse.text();
    assert.equal(JSON.parse(configText).mapKey, nextEnvironment.AMAP_JS_KEY);
    assert.doesNotMatch(configText, /changed-docker-private-web-key|docker-test-security-code/);
    const proxy = await fetch(`${app.baseUrl}/_AMapService/v3/assistant/inputtips?keywords=container`);
    assert.equal(proxy.status, 200);
    assert.equal((await proxy.json()).tips[0].name, '容器同源代理地点');
    assert.equal((await upstream.state()).proxies[0].key, nextEnvironment.AMAP_JS_KEY);
    assert.equal((await upstream.state()).driving.length, 0, 'reopening persisted data does not recalculate a route');
  } finally { await app.cleanup(); }
});
