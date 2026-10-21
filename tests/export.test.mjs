import { test } from 'node:test';
import assert from 'node:assert/strict';
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
