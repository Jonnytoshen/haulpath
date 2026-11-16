import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { prepareNextCommand } from '../scripts/next-command.mjs';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';
import { repeatableFixture } from './helpers/repeatable-day-fixture.mjs';
import { waitDailyTransportTask } from './helpers/daily-transport-fixture.mjs';
import { financeInput } from './helpers/operating-cashflows-fixture.mjs';

const run = promisify(execFile);
test(
  'schema6 annual evidence migrates and production operating cashflows survive SIGKILL and online backup restore',
  { timeout: 240000 },
  async (t) => {
    const build = prepareNextCommand('build');
    await run(build.file, build.args, {
      cwd: build.cwd,
      env: { ...build.env, NEXT_TELEMETRY_DISABLED: '1' },
      maxBuffer: 5000000,
    });
    const initial = await startVehicleEnergyApplication(t, { mode: 'start' });
    let app = initial.app;
    t.after(async () => {
      await app.stop();
    });
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    const model = await repeatableFixture(request);
    const demandId = model.scenario.context.transportDemands[0].id;
    await model.save('/annual-transport', 'PUT', {
      years: [{ year: 2030, operatingDays: 1, demands: [{ demandId, dailyTonnes: 10 }] }],
    });
    await model.prepare();
    const launched = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const source = await waitDailyTransportTask(request, model.path, launched.body.task.taskId);
    const heldScenario = (await request(model.path)).body;
    await app.stop();
    // Downgrade the fixture only: schema6 has the same physical tables, without the new finance table.
    const oldDatabase = new Database(join(app.directory, 'test.sqlite'));
    oldDatabase.exec('DROP TABLE asset_cashflow_results; DROP TABLE operating_cashflow_results');
    oldDatabase.pragma('user_version = 6');
    oldDatabase.close();
    const environment = { HAULPATH_TEST_MODE: '1', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '' };
    app = await startApplication(environment, initial.app.directory, { mode: 'start' });
    assert.deepEqual((await request(model.path)).body, heldScenario);
    assert.deepEqual(
      (await request(`${model.path}/annual-transport/${source.taskId}`)).body,
      source,
    );
    assert.deepEqual((await request(`${model.path}/operating-cashflows`)).body.results, []);
    const input = financeInput();
    input.years[0].electricity = [
      {
        powerSourceId: model.scenario.context.stationNetwork.powerSources[0].id,
        payer: 'station',
        windows: [{ startMinute: 0, endMinute: 1440, rate: '1', source: '恢复验收电价' }],
      },
    ];
    await model.save('/operating-cashflows', 'PUT', { input });
    const calculated = await request(`${model.path}/operating-cashflows`, 'POST', {
      expectedRevision: model.scenario.revision,
      sourceTaskId: source.taskId,
    });
    assert.equal(calculated.status, 201);
    assert.equal(calculated.body.complete, true);
    const backupDirectory = await mkdtemp(join(tmpdir(), 'haulpath-cashflow-restore-'));
    t.after(() => rm(backupDirectory, { recursive: true, force: true }));
    const backup = join(backupDirectory, 'snapshot.sqlite');
    await run('sqlite3', [
      '-noinit',
      '-readonly',
      join(app.directory, 'test.sqlite'),
      `.backup '${backup}'`,
    ]);
    await app.stop('SIGKILL');
    const restoreDirectory = join(backupDirectory, 'restored');
    await mkdir(restoreDirectory);
    await copyFile(backup, join(restoreDirectory, 'test.sqlite'));
    app = await startApplication(environment, restoreDirectory, { mode: 'start' });
    assert.deepEqual(
      (await request(`${model.path}/operating-cashflows/${calculated.body.id}`)).body,
      calculated.body,
    );
    assert.deepEqual(
      (await request(`${model.path}/annual-transport/${source.taskId}`)).body,
      source,
    );
    assert.deepEqual((await request(model.path)).body.context.operatingCashflows, input);
    assert.equal((await request(`${model.path}/operating-cashflows`)).body.results.length, 1);
  },
);
