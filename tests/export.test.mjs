import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import ExcelJS from 'exceljs';
import { startApplication, jsonRequest } from './helpers/application.mjs';

async function downloadWorkbook(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(response.headers.get('content-disposition'), /^attachment;.*\.xlsx/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  return workbook;
}

function sheetRows(sheet) {
  const headers = sheet.getRow(2).values.slice(1);
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 2) rows.push(Object.fromEntries(headers.map((header, index) => [header, row.getCell(index + 1).value])));
  });
  return rows;
}

test('an unplanned route downloads as two Chinese sheets with blank current results', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const project = (await request('/api/projects', 'POST', { name: '长三角项目' })).body;
    const route = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '待完善线路' })).body;
    const workbook = await downloadWorkbook(application.baseUrl, `/api/projects/${project.id}/export?routeId=${route.id}`);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['线路总览', '区间明细']);
    for (const sheet of workbook.worksheets) assert.equal(sheet.getCell('A1').value, '未校验重卡限高、限重及货车限行');
    assert.deepEqual(sheetRows(workbook.getWorksheet('线路总览')), [{
      项目名称: '长三角项目', 线路编号: route.id, 线路名称: '待完善线路', 起点: null, 终点: null,
      有序点位: null, '总里程（km）': null, 规划偏好: '高德推荐', 计算时间: null, 状态: '未规划',
    }]);
    assert.deepEqual(sheetRows(workbook.getWorksheet('区间明细')), []);
    assert.equal((await request(`/api/routes/${route.id}?projectId=${project.id}`)).body.snapshot, null);
  } finally { await application.stop(); await application.cleanup(); }
});

test('project exports include only owned routes and distinguish repeated names by stable identifiers', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const project = (await request('/api/projects', 'POST', { name: '项目名称/带符号' })).body;
    const other = (await request('/api/projects', 'POST', { name: '另一个项目' })).body;
    const point = { id: 'a', name: '上海仓', longitude: 121.47, latitude: 31.23, originalLongitude: 121.47, originalLatitude: 31.23, coordinateSystem: 'GCJ-02', source: 'manual' };
    const points = [point, { ...point, id: 'b', name: '途经客户', longitude: 120.15 }, { ...point, id: 'c', name: '南京终点', longitude: 118.79 }];
    const first = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '同名线路', points, strategy: 36 })).body;
    const second = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '同名线路' })).body;
    const foreign = (await request(`/api/projects/${other.id}/routes`, 'POST', { name: '同名线路' })).body;
    const path = `/api/projects/${project.id}/export`;
    const overview = sheetRows((await downloadWorkbook(application.baseUrl, path)).getWorksheet('线路总览'));
    assert.deepEqual(overview.map((row) => row.线路编号), [first.id, second.id]);
    assert.equal(overview[0].有序点位, '上海仓 → 途经客户 → 南京终点');
    assert.equal(overview[0].起点, '上海仓');
    assert.equal(overview[0].终点, '南京终点');
    assert.equal(overview[0].规划偏好, '少收费');
    assert.equal(sheetRows((await downloadWorkbook(application.baseUrl, `${path}?routeId=${second.id}`)).getWorksheet('线路总览')).length, 1);
    assert.equal((await request(`${path}?routeId=${foreign.id}`)).status, 404);
    assert.equal((await request(`${path}?routeId=missing`)).status, 404);
    assert.equal((await request(`${path}?routeId=`)).status, 400);
    assert.equal((await request('/api/projects/missing/export')).status, 404);
    const empty = (await request('/api/projects', 'POST', { name: '空项目' })).body;
    const emptyWorkbook = await downloadWorkbook(application.baseUrl, `/api/projects/${empty.id}/export`);
    assert.equal(emptyWorkbook.worksheets.length, 2);
    assert.deepEqual(sheetRows(emptyWorkbook.getWorksheet('线路总览')), []);
  } finally { await application.stop(); await application.cleanup(); }
});

test('planned exports reuse complete results with numeric kilometer cells and Shanghai timestamps after renaming', async () => {
  let calls = 0;
  const upstream = createServer((_request, response) => {
    const distance = ++calls === 1 ? '1001' : '2002';
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', route: { paths: [
      { distance, steps: [{ polyline: '121.47,31.23;120.15,30.27' }] },
      { distance: '9999999', steps: [{ polyline: '0,0;1,1' }] },
    ] } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let application;
  try {
    application = await startApplication({ HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AMAP_WEB_SERVICE_KEY: 'test-export-key' });
    const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
    const project = (await request('/api/projects', 'POST', { name: '有效导出项目' })).body;
    const coordinates = await request('/api/coordinates', 'POST', { points: [
      { name: '上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '杭州客户', longitude: 120.15, latitude: 30.27, source: 'manual' },
      { name: '上海回程', longitude: 121.47, latitude: 31.23, source: 'manual' },
    ] });
    assert.equal(coordinates.status, 200);
    const route = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '测算前线路名', points: coordinates.body, strategy: 34 })).body;
    const plannedResponse = await fetch(`${application.baseUrl}/api/routes/${route.id}/plan?projectId=${project.id}`, { method: 'POST' });
    assert.equal(plannedResponse.status, 200);
    const planned = { body: await plannedResponse.json() };
    assert.equal(planned.body.snapshot.totalDistanceMeters, 3003);
    assert.equal(calls, 2);
    const renamed = await request(`/api/routes/${route.id}?projectId=${project.id}`, 'PATCH', { name: '重命名后的线路' });
    assert.equal(renamed.status, 200);
    const workbook = await downloadWorkbook(application.baseUrl, `/api/projects/${project.id}/export?routeId=${route.id}`);
    const overviewSheet = workbook.getWorksheet('线路总览');
    const detailsSheet = workbook.getWorksheet('区间明细');
    const overview = sheetRows(overviewSheet);
    assert.equal(overview.length, 1);
    assert.equal(overview[0].线路名称, '重命名后的线路');
    assert.equal(overview[0].线路编号, route.id);
    assert.equal(overview[0].有序点位, '上海仓 → 杭州客户 → 上海回程');
    assert.equal(overview[0].规划偏好, '高速优先');
    assert.equal(overview[0].状态, '已规划');
    assert.equal(overview[0]['总里程（km）'], 3.003);
    assert.equal(overviewSheet.getCell('G3').type, ExcelJS.ValueType.Number);
    assert.equal(overviewSheet.getCell('G3').numFmt, '0.000');
    assert.match(overview[0].计算时间, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(Date.parse(`${overview[0].计算时间.replace(' ', 'T')}Z`), Math.floor(Date.parse(planned.body.snapshot.calculatedAt) / 1000) * 1000 + 28_800_000);
    assert.deepEqual(sheetRows(detailsSheet), [
      { 项目名称: '有效导出项目', 线路编号: route.id, 线路名称: '重命名后的线路', 区间序号: 1, 区间起点: '上海仓', 区间终点: '杭州客户', '区间里程（km）': 1.001, '累计里程（km）': 1.001 },
      { 项目名称: '有效导出项目', 线路编号: route.id, 线路名称: '重命名后的线路', 区间序号: 2, 区间起点: '杭州客户', 区间终点: '上海回程', '区间里程（km）': 2.002, '累计里程（km）': 3.003 },
    ]);
    for (const address of ['G3', 'H3', 'G4', 'H4']) {
      assert.equal(detailsSheet.getCell(address).type, ExcelJS.ValueType.Number);
      assert.equal(detailsSheet.getCell(address).numFmt, '0.000');
    }
    assert.equal(calls, 2, 'export must reuse the stored result without requesting new driving calculations');
    assert.deepEqual((await request(`/api/routes/${route.id}?projectId=${project.id}`)).body.snapshot, planned.body.snapshot);
  } finally {
    await application?.stop(); await application?.cleanup();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('mixed project exports keep valid results after failure and omit stale or unplanned details even for repeated route names', async () => {
  let calls = 0;
  let fail = false;
  const upstream = createServer((_request, response) => {
    calls++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(fail ? { status: '0', infocode: '10003' }
      : { status: '1', route: { paths: [{ distance: '1001', steps: [{ polyline: '121.47,31.23;120.15,30.27' }] }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let application;
  try {
    application = await startApplication({ HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AMAP_WEB_SERVICE_KEY: 'test-export-key' });
    const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
    const project = (await request('/api/projects', 'POST', { name: '混合状态项目' })).body;
    const points = (await request('/api/coordinates', 'POST', { points: [
      { name: '上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '杭州客户', longitude: 120.15, latitude: 30.27, source: 'manual' },
    ] })).body;
    const create = async () => (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '同名线路', points })).body;
    const valid = await create();
    const stale = await create();
    const draft = await create();
    const plan = (route) => request(`/api/routes/${route.id}/plan?projectId=${project.id}`, 'POST');
    const validResult = await plan(valid);
    const staleResult = await plan(stale);
    assert.equal(validResult.status, 200);
    assert.equal(staleResult.status, 200);
    fail = true;
    assert.equal((await plan(valid)).status, 502);
    const afterValidFailure = (await request(`/api/routes/${valid.id}?projectId=${project.id}`)).body;
    assert.equal(afterValidFailure.planning.status, 'failed');
    assert.deepEqual(afterValidFailure.snapshot, validResult.body.snapshot);
    const currentPoints = [points[0], { ...points[1], name: '调整后终点' }];
    const edited = await request(`/api/routes/${stale.id}?projectId=${project.id}`, 'PATCH', { points: currentPoints, strategy: 36 });
    assert.equal(edited.status, 200);
    assert.equal((await plan(stale)).status, 502);
    const afterStaleFailure = (await request(`/api/routes/${stale.id}?projectId=${project.id}`)).body;
    assert.equal(afterStaleFailure.planning.status, 'failed');
    assert.deepEqual(afterStaleFailure.snapshot, staleResult.body.snapshot);
    assert.equal(calls, 4);
    const workbook = await downloadWorkbook(application.baseUrl, `/api/projects/${project.id}/export`);
    const overview = sheetRows(workbook.getWorksheet('线路总览'));
    assert.deepEqual(overview.map((row) => [row.线路编号, row.线路名称, row.状态]), [
      [valid.id, '同名线路', '已规划'], [stale.id, '同名线路', '待重算'], [draft.id, '同名线路', '未规划'],
    ]);
    assert.equal(overview[0]['总里程（km）'], 1.001);
    assert.equal(typeof overview[0].计算时间, 'string');
    for (const row of overview.slice(1)) {
      assert.equal(row['总里程（km）'], null);
      assert.equal(row.计算时间, null);
    }
    assert.equal(overview[1].有序点位, '上海仓 → 调整后终点');
    assert.equal(overview[1].规划偏好, '少收费');
    const details = sheetRows(workbook.getWorksheet('区间明细'));
    assert.equal(details.length, 1);
    assert.equal(details[0].线路编号, valid.id);
    assert.equal(details[0]['区间里程（km）'], 1.001);
    const staleWorkbook = await downloadWorkbook(application.baseUrl, `/api/projects/${project.id}/export?routeId=${stale.id}`);
    assert.equal(sheetRows(staleWorkbook.getWorksheet('线路总览'))[0].状态, '待重算');
    assert.deepEqual(sheetRows(staleWorkbook.getWorksheet('区间明细')), []);
    assert.equal(calls, 4, 'viewing and exporting either state must not trigger new planning');
  } finally {
    await application?.stop(); await application?.cleanup();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
