import assert from 'node:assert/strict';
import { jsonRequest, startApplication } from './application.mjs';

export function assetInput() {
  const asset = (name, category, owner, acquisition, amount) => ({
    name,
    category,
    owner,
    acquisition,
    amount,
    source: '独立台账',
    serviceYear: acquisition === 'existing' ? 2025 : 2030,
    siteId: null,
    budgetBucket: null,
    notes: '已核对资产范围',
    replacements: [],
    residual: { year: 2032, amount: '0', source: '无回收价值' },
  });
  const battery = asset('周转电池', 'battery', 'station', 'new', '1000');
  battery.replacements = [
    { year: 2031, amount: '400', disposal: '50', source: '更换报价及旧件回收' },
  ];
  battery.residual = { year: 2032, amount: '80', source: '期末处置报价' };
  return {
    boundary: 'integrated',
    initialYear: 2030,
    years: [2030, 2031, 2032],
    scopeSource: '固定规模资产全部列出；旧车购置已发生；无其他资本收付',
    assets: [
      battery,
      asset('已有车辆', 'vehicle', 'transport', 'existing', '5000'),
      asset('外部设备', 'other', 'external', 'new', '900'),
    ],
    workingCapital: [
      {
        owner: 'station',
        openingBalance: '0',
        source: '期初无占用',
        years: [
          { year: 2030, balance: '100', source: '启动周转' },
          { year: 2031, balance: '120', source: '补充20' },
          { year: 2032, balance: '0', source: '显式全部回收120' },
        ],
      },
    ],
    overrides: [],
  };
}
export async function startAssetApplication(t, options = {}) {
  const app = await startApplication(
    { AMAP_JS_KEY: '', AMAP_WEB_SERVICE_KEY: '' },
    undefined,
    options,
  );
  t.after(async () => {
    await app.stop();
    await app.cleanup();
  });
  const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
  const project = (await request('/api/projects', 'POST', { name: '资产资金验收' })).body;
  const collection = `/api/projects/${project.id}/scenarios`;
  const scenario = (await request(collection, 'POST', { name: '独立资产方案' })).body;
  assert.ok(scenario.id);
  return { app, request, project, scenario, collection, path: `${collection}/${scenario.id}` };
}
