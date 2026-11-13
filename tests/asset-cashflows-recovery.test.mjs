import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { prepareNextCommand } from '../scripts/next-command.mjs';
import { jsonRequest, startApplication } from './helpers/application.mjs';
import { assetInput, startAssetApplication } from './helpers/asset-cashflows-fixture.mjs';

const run = promisify(execFile);
test(
  'schema7 migration preserves operating history and production asset ledgers survive SIGKILL, restart and online backup restore',
  { timeout: 240000 },
  async (t) => {
    const build = prepareNextCommand('build');
    await run(build.file, build.args, {
      cwd: build.cwd,
      env: { ...build.env, NEXT_TELEMETRY_DISABLED: '1' },
      maxBuffer: 5000000,
    });
    const initial = await startAssetApplication(t, { mode: 'start' });
    let app = initial.app;
    t.after(() => app.stop());
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    // A genuine schema7 has all prior tables and no asset result table.
    await app.stop();
    const db = new Database(join(app.directory, 'test.sqlite'));
    db.exec('DROP TABLE asset_cashflow_results; PRAGMA user_version = 7;');
    db.prepare(
      'INSERT INTO operating_cashflow_results(id,project_id,scenario_id,payload) VALUES(?,?,?,?)',
    ).run(
      'prior-ledger',
      initial.project.id,
      initial.scenario.id,
      JSON.stringify({ id: 'prior-ledger', sourceTaskId: 'historical-source', inputVersion: 1 }),
    );
    db.close();
    const env = { AMAP_JS_KEY: '', AMAP_WEB_SERVICE_KEY: '' };
    app = await startApplication(env, initial.app.directory, { mode: 'start' });
    assert.deepEqual((await request(initial.path)).body, initial.scenario);
    assert.equal(
      (await request(`${initial.path}/operating-cashflows/prior-ledger`)).body.sourceTaskId,
      'historical-source',
    );
    assert.deepEqual((await request(`${initial.path}/asset-cashflows`)).body.results, []);
    const saved = await request(`${initial.path}/asset-cashflows`, 'PUT', {
      expectedRevision: initial.scenario.revision,
      input: assetInput(),
    });
    assert.equal(saved.status, 200);
    const result = await request(`${initial.path}/asset-cashflows`, 'POST', {
      expectedRevision: saved.body.revision,
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.complete, true);
    const backupDirectory = await mkdtemp(join(tmpdir(), 'haulpath-assets-restore-'));
    t.after(() => rm(backupDirectory, { recursive: true, force: true }));
    const backup = join(backupDirectory, 'snapshot.sqlite');
    await run('sqlite3', [
      '-noinit',
      '-readonly',
      join(app.directory, 'test.sqlite'),
      `.backup '${backup}'`,
    ]);
    await app.stop('SIGKILL');
    app = await startApplication(env, initial.app.directory, { mode: 'start' });
    assert.deepEqual(
      (await request(`${initial.path}/asset-cashflows/${result.body.id}`)).body,
      result.body,
    );
    assert.deepEqual((await request(initial.path)).body, saved.body);
    await app.stop();
    const restored = join(backupDirectory, 'restored');
    await mkdir(restored);
    await copyFile(backup, join(restored, 'test.sqlite'));
    app = await startApplication(env, restored, { mode: 'start' });
    assert.deepEqual(
      (await request(`${initial.path}/asset-cashflows/${result.body.id}`)).body,
      result.body,
    );
    assert.equal((await request(`${initial.path}/asset-cashflows`)).body.results.length, 1);
    assert.equal(
      (await request(`${initial.path}/operating-cashflows/prior-ledger`)).body.sourceTaskId,
      'historical-source',
    );
    assert.deepEqual(
      (await request(initial.path)).body.context.assetCashflows,
      saved.body.context.assetCashflows,
    );
  },
);
