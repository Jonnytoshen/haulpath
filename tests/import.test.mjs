import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import ExcelJS from 'exceljs';
import { startApplication, jsonRequest } from './helpers/application.mjs';

let application;
let upstream;
let handleUpstream;
const upstreamRequests = [];
before(async () => {
  upstream = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    upstreamRequests.push(url);
    handleUpstream(url, response);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  application = await startApplication({ HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AMAP_WEB_SERVICE_KEY: 'test-import-key' });
});
after(async () => {
  await application?.stop(); await application?.cleanup();
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
});
const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);

async function upload(projectId, action, file, fields = {}) {
  const form = new FormData();
  form.set('file', file);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const response = await fetch(`${application.baseUrl}/api/projects/${projectId}/import/${action}`, { method: 'POST', body: form });
  const content = await response.text();
  return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(content) : content };
}

test('Excel inspection and preview preserve chosen sheet, column mapping and original error row numbers without saving', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'Excel导入项目' })).body;
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('说明').addRow(['不作为点位导入']);
  const points = workbook.addWorksheet('仓点清单');
  points.addRows([
    ['辅助列', 'Y坐标', '地点', 'X坐标'], ['第一行', 31.23, '上海仓', 121.47], [],
    ['名称缺失', 32.06, '', 118.79], ['坐标错误', 91, '错误点', '不是数字'], ['经度缺失', 30.27, '杭州仓'],
  ]);
  const file = new File([await workbook.xlsx.writeBuffer()], '任意列名.xlsx');
  const inspected = await upload(project.id, 'inspect', file);
  assert.equal(inspected.status, 200);
  assert.deepEqual(inspected.body.sheets, [
    { name: '说明', headers: ['不作为点位导入'] },
    { name: '仓点清单', headers: ['辅助列', 'Y坐标', '地点', 'X坐标'] },
  ]);
  const previewed = await upload(project.id, 'preview', file, { sheet: '仓点清单', nameColumn: '2', longitudeColumn: '3', latitudeColumn: '1' });
  assert.equal(previewed.status, 200);
  assert.equal(previewed.body.validCount, 1);
  assert.equal(previewed.body.invalidCount, 3);
  assert.deepEqual(previewed.body.rows.map((row) => row.rowNumber), [2, 4, 5, 6]);
  assert.equal(previewed.body.rows[0].name, '上海仓');
  assert.equal(previewed.body.rows[0].originalLongitude, 121.47);
  assert.equal(previewed.body.rows[0].originalLatitude, 31.23);
  assert.deepEqual(previewed.body.rows[0].errors, []);
  assert.match(previewed.body.rows[1].errors.join(' '), /名称/);
  assert.match(previewed.body.rows[2].errors.join(' '), /经度.*数值/);
  assert.match(previewed.body.rows[2].errors.join(' '), /纬度.*范围/);
  assert.match(previewed.body.rows[3].errors.join(' '), /经度.*缺失/);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
});

test('UTF-8 CSV confirmation saves only explicitly selected valid rows into the current project library', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'CSV导入项目' })).body;
  const other = (await request('/api/projects', 'POST', { name: '其他项目' })).body;
  const file = new File(['\uFEFF任意名称,经度值,纬度值\r\n"上海,一号仓",121.471234567,31.231234567\r\n\r\n错误,,30\r\n杭州仓,120.15,30.27\r\n'], '坐标.csv');
  const mapping = { sheet: 'CSV', nameColumn: '0', longitudeColumn: '1', latitudeColumn: '2' };
  const inspected = await upload(project.id, 'inspect', file);
  assert.equal(inspected.status, 200);
  assert.deepEqual(inspected.body.sheets, [{ name: 'CSV', headers: ['任意名称', '经度值', '纬度值'] }]);
  const previewed = await upload(project.id, 'preview', file, mapping);
  assert.equal(previewed.status, 200);
  assert.equal(previewed.body.validCount, 2);
  assert.equal(previewed.body.invalidCount, 1);
  assert.deepEqual(previewed.body.rows.map((row) => row.rowNumber), [2, 4, 5]);
  assert.equal(previewed.body.rows[0].name, '上海,一号仓');
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
  const confirmed = await upload(project.id, 'confirm', file, { ...mapping, selectedRows: '[5]' });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.importedCount, 1);
  assert.equal(confirmed.body.points[0].name, '杭州仓');
  assert.equal(confirmed.body.points[0].longitude, 120.15);
  assert.equal(confirmed.body.points[0].latitude, 30.27);
  assert.equal(confirmed.body.points[0].originalLongitude, 120.15);
  assert.equal(confirmed.body.points[0].originalLatitude, 30.27);
  assert.equal(confirmed.body.points[0].coordinateSystem, 'GCJ-02');
  assert.equal(confirmed.body.points[0].source, 'import');
  const saved = await request(`/api/projects/${project.id}/points`);
  assert.deepEqual(saved.body, confirmed.body.points);
  assert.deepEqual((await request(`/api/projects/${other.id}/points`)).body, []);
  for (const selectedRows of ['[]', '[2,4]', '[3]', '[999]', '[2,2]', 'null', '["2"]', 'not-json']) {
    const rejected = await upload(project.id, 'confirm', file, { ...mapping, selectedRows });
    assert.equal(rejected.status, 400, selectedRows);
    assert.equal(typeof rejected.body.error, 'string');
  }
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, saved.body);
});

test('the standard template downloads as a usable Excel workbook for the same import flow', async () => {
  const response = await fetch(`${application.baseUrl}/api/import-template`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(response.headers.get('content-disposition'), /^attachment;.*\.xlsx/);
  const data = await response.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  assert.deepEqual(workbook.getWorksheet(1).getRow(1).values.slice(1), ['名称', '经度', '纬度']);
  const project = (await request('/api/projects', 'POST', { name: '模板项目' })).body;
  const inspected = await upload(project.id, 'inspect', new File([data], '点位模板.xlsx'));
  assert.equal(inspected.status, 200);
  assert.deepEqual(inspected.body.sheets[0].headers, ['名称', '经度', '纬度']);
});

test('WGS84 preview stays read-only and a later conversion batch failure never partially imports points', async () => {
  const project = (await request('/api/projects', 'POST', { name: 'GPS导入项目' })).body;
  const rows = Array.from({ length: 41 }, (_, index) => [`GPS ${index}`, '121.471234567', '31.231234567'].join(','));
  const file = new File([['名称,经度,纬度', ...rows].join('\n')], 'GPS.csv');
  const mapping = { sheet: 'CSV', nameColumn: '0', longitudeColumn: '1', latitudeColumn: '2', coordinateSystem: 'WGS84' };
  const selectedRows = JSON.stringify(Array.from({ length: 41 }, (_, index) => 42 - index));
  const beforeCount = upstreamRequests.length;
  const preview = await upload(project.id, 'preview', file, mapping);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.validCount, 41);
  assert.equal(upstreamRequests.length, beforeCount);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
  let batch = 0;
  handleUpstream = (url, response) => {
    assert.equal(url.pathname, '/v3/assistant/coordinate/convert');
    assert.equal(url.searchParams.get('coordsys'), 'gps');
    const locations = url.searchParams.get('locations').split('|');
    assert.ok(locations.length <= 40);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(++batch === 2 ? { status: '0', infocode: '10001' }
      : { status: '1', locations: locations.map(() => '121.476,31.236').join(';') }));
  };
  const failed = await upload(project.id, 'confirm', file, { ...mapping, selectedRows });
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /密钥|权限/);
  assert.equal(batch, 2);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
  handleUpstream = (url, response) => {
    const locations = url.searchParams.get('locations').split('|');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', locations: locations.map(() => '121.476,31.236').join(';') }));
  };
  const success = await upload(project.id, 'confirm', file, { ...mapping, selectedRows });
  assert.equal(success.status, 201);
  assert.equal(success.body.importedCount, 41);
  assert.equal(success.body.points[0].name, 'GPS 0');
  assert.equal(success.body.points[40].name, 'GPS 40');
  assert.equal(success.body.points[0].longitude, 121.476);
  assert.equal(success.body.points[0].latitude, 31.236);
  assert.equal(success.body.points[0].originalLongitude, 121.471234567);
  assert.equal(success.body.points[0].originalLatitude, 31.231234567);
  assert.equal(success.body.points[0].coordinateSystem, 'WGS84');
  assert.equal(success.body.points[0].source, 'import');
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, success.body.points);
});

test('a nonempty Excel row with an uncached formula stays visible as an invalid row', async () => {
  const project = (await request('/api/projects', 'POST', { name: '公式表项目' })).body;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('公式');
  sheet.addRow(['名称', '经度', '纬度']);
  sheet.addRow([{ formula: 'SUM(1,1)' }]);
  const file = new File([await workbook.xlsx.writeBuffer()], '未计算公式.xlsx');
  const preview = await upload(project.id, 'preview', file, { sheet: '公式', nameColumn: '0', longitudeColumn: '1', latitudeColumn: '2' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.invalidCount, 1);
  assert.equal(preview.body.rows[0].rowNumber, 2);
  assert.match(preview.body.rows[0].errors.join(' '), /经度.*缺失/);
});

test('bad files, missing sheets and invalid mappings return clear errors without changing a project library', async () => {
  const project = (await request('/api/projects', 'POST', { name: '失败导入项目' })).body;
  for (const file of [
    new File(['名称,经度,纬度'], '旧文件.xls'), new File(['不是Excel'], '损坏.xlsx'),
    new File([new Uint8Array([0xff, 0xfe, 0xff])], '非UTF8.csv'),
    new File(['名称,经度,纬度\n"未闭合,121,31'], '损坏.csv'), new File([], '空文件.csv'),
  ]) {
    const rejected = await upload(project.id, 'inspect', file);
    assert.equal(rejected.status, 400, file.name);
    assert.equal(typeof rejected.body.error, 'string');
  }
  const file = new File(['名称,经度,纬度\n仓库,121,31'], '点位.csv');
  const mapping = { sheet: 'CSV', nameColumn: '0', longitudeColumn: '1', latitudeColumn: '2' };
  for (const override of [{ sheet: '不存在' }, { nameColumn: '-1' }, { nameColumn: '3' }, { nameColumn: '1' }, { latitudeColumn: 'not-number' }, { coordinateSystem: 'BD-09' }]) {
    const rejected = await upload(project.id, 'preview', file, { ...mapping, ...override });
    assert.equal(rejected.status, 400, JSON.stringify(override));
  }
  assert.equal((await upload('missing-project', 'inspect', file)).status, 404);
  assert.equal((await upload('missing-project', 'preview', file, mapping)).status, 404);
  assert.equal((await upload('missing-project', 'confirm', file, { ...mapping, selectedRows: '[2]' })).status, 404);
  assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
});
