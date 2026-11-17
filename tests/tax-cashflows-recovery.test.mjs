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
import { taxFixture } from './helpers/tax-cashflows-fixture.mjs';
const run = promisify(execFile);
test(
  'schema8 preserves actual finance evidence and tax history survives production kill, restart and online backup restore',
  { timeout: 240000 },
  async (t) => {
    const build = prepareNextCommand('build');
    await run(build.file, build.args, {
      cwd: build.cwd,
      env: { ...build.env, NEXT_TELEMETRY_DISABLED: '1' },
      maxBuffer: 5000000,
    });
    const m = await taxFixture(t, { mode: 'start' });
    let app = m.app;
    t.after(() => app.stop());
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    await app.stop();
    const db = new Database(join(app.directory, 'test.sqlite'));
    db.exec('DROP TABLE tax_cashflow_results; PRAGMA user_version = 8;');
    db.close();
    const env = { AMAP_JS_KEY: '', AMAP_WEB_SERVICE_KEY: '' };
    app = await startApplication(env, m.app.directory, { mode: 'start' });
    assert.deepEqual((await request(m.path)).body, m.scenario);
    assert.deepEqual(
      (await request(`${m.path}/operating-cashflows/${m.operating.id}`)).body,
      m.operating,
    );
    assert.deepEqual((await request(`${m.path}/asset-cashflows/${m.assets.id}`)).body, m.assets);
    assert.deepEqual((await request(`${m.path}/tax-cashflows`)).body.results, []);
    const saved = await request(`${m.path}/tax-cashflows`, 'PUT', {
      expectedRevision: m.scenario.revision,
      input: m.input,
    });
    assert.equal(saved.status, 200);
    const calculated = await request(`${m.path}/tax-cashflows`, 'POST', {
      expectedRevision: saved.body.revision,
      operatingResultId: m.operating.id,
      assetResultId: m.assets.id,
    });
    assert.equal(calculated.status, 201);
    assert.equal(calculated.body.complete, true);
    assert.deepEqual(
      calculated.body.years.map((y) => y.projectCashflowCents),
      [-98000, 116000, 147000],
    );
    const backupDirectory = await mkdtemp(join(tmpdir(), 'haulpath-tax-restore-'));
    t.after(() => rm(backupDirectory, { recursive: true, force: true }));
    const backup = join(backupDirectory, 'snapshot.sqlite');
    await run('sqlite3', [
      '-noinit',
      '-readonly',
      join(app.directory, 'test.sqlite'),
      `.backup '${backup}'`,
    ]);
    await app.stop('SIGKILL');
    app = await startApplication(env, m.app.directory, { mode: 'start' });
    assert.deepEqual(
      (await request(`${m.path}/tax-cashflows/${calculated.body.id}`)).body,
      calculated.body,
    );
    assert.deepEqual((await request(m.path)).body, saved.body);
    await app.stop();
    const restored = join(backupDirectory, 'restored');
    await mkdir(restored);
    await copyFile(backup, join(restored, 'test.sqlite'));
    app = await startApplication(env, restored, { mode: 'start' });
    assert.deepEqual(
      (await request(`${m.path}/tax-cashflows/${calculated.body.id}`)).body,
      calculated.body,
    );
    assert.deepEqual(
      (await request(`${m.path}/operating-cashflows/${m.operating.id}`)).body,
      m.operating,
    );
    assert.deepEqual((await request(`${m.path}/asset-cashflows/${m.assets.id}`)).body, m.assets);
    assert.deepEqual(
      (await request(`${m.path}/annual-transport/${m.source.taskId}`)).body,
      m.source,
    );
    assert.deepEqual((await request(m.path)).body, saved.body);
  },
);
