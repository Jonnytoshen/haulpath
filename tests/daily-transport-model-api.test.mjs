import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { roadPoint, roadResponse, waitRoadTask } from './helpers/directed-road-fixture.mjs';
import {
  configureDailyTransportLayout,
  stationNetworkInputs,
  waitDailyTransportTask,
} from './helpers/daily-transport-fixture.mjs';

async function prepareRoads(request, path, scenario) {
  const response = await request(`${path}/roads`, 'POST', { expectedRevision: scenario.revision });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  await waitRoadTask(request, path, response.body.task.taskId, 'completed');
}

async function createModel(
  request,
  {
    names = [['A', 'B', 'C', 'A']],
    demandRows = [
      [0, 0, 2, 15],
      [0, 1, 2, 5],
    ],
    shifts = [{ startMinute: 0, endMinute: 200 }],
    count = 1,
    payloadTonnes = 10,
    speedKph = 60,
    loadingMinutes = 5,
    unloadingMinutes = 5,
    beforeLayoutSelection,
  } = {},
) {
  const project = (await request('/api/projects', 'POST', { name: '独立运输手算核对' })).body;
  let scenario = (
    await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '完整循环日计划' })
  ).body;
  const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
  const save = async (suffix, method, body) => {
    const response = await request(`${path}${suffix}`, method, {
      expectedRevision: scenario.revision,
      ...body,
    });
    assert.ok([200, 201].includes(response.status), JSON.stringify(response));
    scenario = response.body;
    return scenario;
  };
  for (const [routeIndex, positions] of names.entries()) {
    const route = (
      await request(`/api/projects/${project.id}/routes`, 'POST', {
        name: `业务循环${routeIndex + 1}`,
        points: positions.map((name, index) =>
          roadPoint(
            `point-${routeIndex}-${index}`,
            name,
            121.4 + routeIndex * 0.2 + positions.indexOf(name) * 0.01,
          ),
        ),
      })
    ).body;
    await save('/cycles', 'POST', { sourceRouteId: route.id });
    await save(`/cycles/${scenario.context.transportCycles.at(-1).id}`, 'PATCH', {
      confirmed: true,
    });
  }
  const cycles = scenario.context.transportCycles;
  await save('/demands', 'PUT', {
    demands: demandRows.map(([cycleIndex, loading, unloading, dailyTonnes]) => ({
      cycleId: cycles[cycleIndex].id,
      loadingPositionId: cycles[cycleIndex].positions[loading].id,
      unloadingPositionId: cycles[cycleIndex].positions[unloading].id,
      dailyTonnes,
    })),
  });
  await save('/operations', 'PUT', {
    operations: {
      battery: null,
      measuredSegments: [],
      vehicleGroups: [
        {
          name: '十吨车',
          count,
          baseCycleId: cycles[0].id,
          baseStartPositionId: cycles[0].positions[0].id,
          payloadTonnes,
          speedKph,
          emptyKwhPerKm: null,
          fullKwhPerKm: null,
          safetySocPercent: null,
          shifts,
          loadingMinutes,
          unloadingMinutes,
          source: '独立手算，每有作业位置计一次装卸',
        },
      ],
    },
  });
  scenario = await configureDailyTransportLayout(request, scenario, {
    beforeSelection: beforeLayoutSelection,
  });
  const prepare = () => prepareRoads(request, path, scenario);
  const run = async () => {
    await prepare();
    const response = await request(`${path}/daily-transport`, 'POST', {
      expectedRevision: scenario.revision,
    });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    return waitDailyTransportTask(request, path, response.body.task.taskId);
  };
  const operationsInput = () => ({
    battery: null,
    measuredSegments: scenario.context.operations.measuredSegments.map(({ basis, ...input }) => {
      assert.ok(basis);
      return input;
    }),
    vehicleGroups: scenario.context.operations.vehicleGroups.map(
      ({ vehicleIds, baseStartBasis, ...input }) => {
        assert.ok(vehicleIds);
        assert.ok(baseStartBasis);
        return input;
      },
    ),
  });
  return {
    path,
    cycles,
    save,
    run,
    prepare,
    operationsInput,
    get scenario() {
      return scenario;
    },
  };
}

test(
  'real Worker transportation plans match independently worked loads, time windows and directional transfers',
  { timeout: 240000 },
  async (t) => {
    let distance = '10000';
    const upstream = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      roadResponse(url, response, typeof distance === 'function' ? distance(url) : distance);
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    let app;
    try {
      app = await startApplication({
        HAULPATH_TEST_MODE: '1',
        AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
        AMAP_WEB_SERVICE_KEY: 'daily-model-test',
      });
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      await t.test(
        'only a selected layout with still-confirmed site and connection admits a transport trial',
        async () => {
          const model = await createModel(request, {
            beforeLayoutSelection: async (scenario, path) => {
              assert.deepEqual(scenario.context.stationNetwork.fixedLayout, []);
              assert.equal(scenario.context.stationNetwork.sites[0].connection.confirmed, true);
              await prepareRoads(request, path, scenario);
              const rejected = await request(`${path}/daily-transport`, 'POST', {
                expectedRevision: scenario.revision,
              });
              assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
              assert.match(JSON.stringify(rejected.body), /固定布局/);
            },
          });
          const task = await model.run();
          assert.equal(task.result.totalCompletedTonnes, 20);
          assert.equal(task.snapshot.context.operations.battery, null);
          assert.equal(task.snapshot.context.stationNetwork.fixedLayout.length, 1);
          const network = stationNetworkInputs(model.scenario.context.stationNetwork);
          network.sites[0].siteNotes = '场地条件更新，原确认失效';
          await model.save('/station-network', 'PUT', { network });
          assert.equal(model.scenario.context.stationNetwork.fixedLayout.length, 1);
          const [site] = model.scenario.context.stationNetwork.sites;
          assert.equal(site.siteConfirmed, false);
          assert.equal(site.connection.confirmed, false);
          await model.prepare();
          const rejected = await request(`${model.path}/daily-transport`, 'POST', {
            expectedRevision: model.scenario.revision,
          });
          assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
          assert.match(JSON.stringify(rejected.body), /场地.*确认|接电.*确认/);
        },
      );
      await t.test(
        'mixing and splitting preserve interval loads and count only the requested tonnes',
        async () => {
          const model = await createModel(request);
          const { result } = await model.run();
          // Three 10 km legs take 30 min. The two loops have 2 and 3 operations at 5 min each.
          assert.equal(result.totalCompletedTonnes, 20);
          assert.equal(result.totalMissingTonnes, 0);
          assert.equal(result.totalDistanceMeters, 60000);
          assert.equal(result.vehicles[0].workingMinutes, 85);
          assert.deepEqual(
            result.trips.map((trip) => trip.segments.map((segment) => segment.loadTonnes)),
            [
              [10, 10, 0],
              [5, 10, 0],
            ],
          );
          assert.deepEqual(
            result.demands.map((demand) => demand.completedTonnes),
            [15, 5],
          );
          assert.equal(result.validation.valid, true);
        },
      );
      await t.test(
        'a short window retains a complete loop and exposes the exact remaining demand',
        async () => {
          const model = await createModel(request, { shifts: [{ startMinute: 0, endMinute: 80 }] });
          const { result } = await model.run();
          assert.equal(result.trips.length, 1);
          assert.equal(result.vehicles[0].workingMinutes, 40);
          assert.equal(result.totalCompletedTonnes, 10);
          assert.equal(result.totalMissingTonnes, 10);
          assert.deepEqual(
            result.demands.map((demand) => demand.missingTonnes),
            [5, 5],
          );
          assert.ok(result.demands.every((demand) => demand.reason.includes('未证明无解')));
        },
      );
      await t.test(
        'valid measured times remain usable after the energy measurement payload basis changes',
        async () => {
          const model = await createModel(request);
          const operations = model.operationsInput();
          const group = operations.vehicleGroups[0];
          const cycle = model.cycles[0];
          group.speedKph = null;
          operations.measuredSegments = [7, 8, 9].map((durationMinutes, index) => ({
            vehicleGroupId: group.id,
            cycleId: cycle.id,
            fromPositionId: cycle.positions[index].id,
            toPositionId: cycle.positions[index + 1].id,
            durationMinutes,
            emptyKwh: 12,
            fullKwh: 20,
            source: '独立实测时长 7 / 8 / 9 分钟',
          }));
          await model.save('/operations', 'PUT', { operations });
          const changed = model.operationsInput();
          changed.vehicleGroups[0].payloadTonnes = 11;
          await model.save('/operations', 'PUT', { operations: changed });
          const task = await model.run();
          assert.equal(task.result.vehicles[0].workingMinutes, 73);
          assert.deepEqual(
            task.result.trips[0].segments.map((segment) => segment.durationMinutes),
            [7, 8, 9],
          );
          assert.ok(
            task.result.trips.every((trip) =>
              trip.segments.every(
                (segment) => segment.durationSource === 'measured' && segment.measuredSegmentId,
              ),
            ),
          );
          assert.equal(task.snapshot.context.operations.vehicleGroups[0].speedKph, null);
          assert.equal(
            task.snapshot.context.operations.measuredSegments[0].basis.payloadTonnes,
            10,
          );
          assert.equal(task.result.totalCompletedTonnes, 20);
        },
      );
      await t.test(
        'an unused loop with a stale measurement does not block a loop with complete measured times',
        async () => {
          const model = await createModel(request, {
            names: [
              ['A', 'B', 'A'],
              ['C', 'D', 'C'],
            ],
            demandRows: [[0, 0, 1, 10]],
            speedKph: null,
          });
          const operations = model.operationsInput();
          const [cycle, unusedCycle] = model.cycles;
          operations.measuredSegments = [7, 8].map((durationMinutes, index) => ({
            vehicleGroupId: operations.vehicleGroups[0].id,
            cycleId: cycle.id,
            fromPositionId: cycle.positions[index].id,
            toPositionId: cycle.positions[index + 1].id,
            durationMinutes,
            emptyKwh: null,
            fullKwh: null,
            source: '使用循环的 7 / 8 分钟实测',
          }));
          operations.measuredSegments.push({
            ...operations.measuredSegments[0],
            cycleId: unusedCycle.id,
            fromPositionId: unusedCycle.positions[0].id,
            toPositionId: unusedCycle.positions[1].id,
          });
          await model.save('/operations', 'PUT', { operations });
          await model.save(`/cycles/${unusedCycle.id}`, 'PATCH', { strategy: 34, confirmed: true });
          const { result, snapshot } = await model.run();
          assert.equal(snapshot.context.operations.measuredSegments[2].basis.strategy, 32);
          assert.equal(result.totalCompletedTonnes, 10);
          assert.deepEqual(
            result.trips.map((trip) => trip.cycleId),
            [cycle.id],
          );
          assert.equal(result.vehicles[0].workingMinutes, 25);
          assert.equal(result.validation.valid, true);
        },
      );
      await t.test(
        'multiple shifts include a cross-midnight window and never overlap vehicle events',
        async () => {
          const model = await createModel(request, {
            names: [['A', 'B', 'A']],
            demandRows: [[0, 0, 1, 25]],
            shifts: [
              { startMinute: 60, endMinute: 90 },
              { startMinute: 1410, endMinute: 1480 },
            ],
          });
          const { result } = await model.run();
          assert.deepEqual(
            result.trips.map((trip) => [trip.startMinute, trip.endMinute]),
            [
              [60, 90],
              [1410, 1440],
              [1440, 1470],
            ],
          );
          assert.equal(result.vehicles[0].workingMinutes, 90);
          assert.equal(result.totalCompletedTonnes, 25);
          const events = result.vehicles[0].events;
          assert.ok(
            events.every(
              (event, index) => index === 0 || event.startMinute >= events[index - 1].endMinute,
            ),
          );
          assert.equal(result.validation.valid, true);
        },
      );
      await t.test(
        'very short events at the shared boundary belong to the shift that contains the full trip',
        async () => {
          const model = await createModel(request, {
            names: [['A', 'B', 'A']],
            demandRows: [[0, 0, 1, 10]],
            shifts: [
              { startMinute: 480, endMinute: 481 },
              { startMinute: 481, endMinute: 661 },
            ],
            loadingMinutes: 0,
            unloadingMinutes: 0,
          });
          const operations = model.operationsInput();
          const cycle = model.cycles[0];
          operations.measuredSegments = [
            {
              vehicleGroupId: operations.vehicleGroups[0].id,
              cycleId: cycle.id,
              fromPositionId: cycle.positions[0].id,
              toPositionId: cycle.positions[1].id,
              durationMinutes: 5e-8,
              emptyKwh: null,
              fullKwh: null,
              source: '边界反例中的极短有向区间实测',
            },
          ];
          await model.save('/operations', 'PUT', { operations });
          const { result } = await model.run();
          assert.equal(result.trips.length, 1);
          assert.equal(result.trips[0].startMinute, 481);
          assert.equal(result.trips[0].segments[0].durationMinutes, 5e-8);
          assert.ok(result.trips[0].endMinute > 491);
          assert.equal(result.totalCompletedTonnes, 10);
          assert.equal(result.validation.valid, true);
        },
      );
      await t.test(
        'cross-cycle empty travel and directional return consume distance and reserve the return window',
        async () => {
          const options = {
            names: [
              ['A', 'B', 'A'],
              ['C', 'D', 'C'],
            ],
            demandRows: [
              [0, 0, 1, 10],
              [1, 0, 1, 10],
            ],
          };
          const model = await createModel(request, options);
          const { result } = await model.run();
          assert.equal(result.totalCompletedTonnes, 20);
          assert.equal(result.totalDistanceMeters, 60000);
          assert.equal(result.vehicles[0].workingMinutes, 80);
          const transfers = result.vehicles[0].events.filter((event) =>
            ['continuation', 'return'].includes(event.kind),
          );
          assert.deepEqual(
            transfers.map((event) => [
              event.kind,
              event.startMinute,
              event.endMinute,
              event.distanceMeters,
              event.loadTonnes,
            ]),
            [
              ['continuation', 30, 40, 10000, 0],
              ['return', 70, 80, 10000, 0],
            ],
          );
          assert.notEqual(transfers[0].roadKey, transfers[1].roadKey);
          assert.equal(result.vehicles[0].returnedToBase, true);
          const short = await createModel(request, {
            ...options,
            shifts: [{ startMinute: 0, endMinute: 75 }],
          });
          const limited = (await short.run()).result;
          assert.equal(limited.totalCompletedTonnes, 10);
          assert.equal(limited.totalMissingTonnes, 10);
          assert.equal(limited.totalDistanceMeters, 20000);
          assert.match(limited.demands[1].reason, /本次构造未安排完成/);
          const tooShort = await createModel(request, {
            ...options,
            shifts: [{ startMinute: 0, endMinute: 49 }],
          });
          const impossible = (await tooShort.run()).result;
          assert.equal(impossible.totalCompletedTonnes, 10);
          assert.match(impossible.demands[1].reason, /从基准直接往返的单趟安排放不进现有班次/);
        },
      );
      await t.test(
        'a chained trip that partially serves a demand takes precedence over a slow direct journey',
        async () => {
          distance = (url) =>
            url.searchParams.get('origin')?.startsWith('121.400000,') &&
            url.searchParams.get('destination')?.startsWith('121.800000,')
              ? '100000'
              : '10000';
          try {
            const model = await createModel(request, {
              names: [
                ['A', 'B', 'A'],
                ['C', 'D', 'C'],
                ['E', 'F', 'E'],
              ],
              demandRows: [
                [0, 0, 1, 10],
                [1, 0, 1, 10],
                [2, 0, 1, 15],
              ],
              shifts: [{ startMinute: 0, endMinute: 125 }],
            });
            const { result } = await model.run();
            // Direct to E would take 100 + 30 + 10 min. Serving A, C and E in
            // order instead takes 3 complete 30 min loops and 3 short 10 min transfers.
            assert.deepEqual(
              result.trips.map((trip) => trip.cycleId),
              model.cycles.map((cycle) => cycle.id),
            );
            assert.equal(result.vehicles[0].workingMinutes, 120);
            assert.equal(result.vehicles[0].returnedToBase, true);
            const served = result.demands.find((demand) => demand.cycleId === model.cycles[2].id);
            assert.equal(served.completedTonnes, 10);
            assert.equal(served.missingTonnes, 5);
            assert.match(served.reason, /本次构造未安排完成/);
          } finally {
            distance = '10000';
          }
        },
      );
      await t.test(
        'reducing the vehicle count leaves historical identities unavailable',
        async () => {
          const model = await createModel(request, { count: 3 });
          const historical = model.scenario.context.operations.vehicleGroups[0].vehicleIds;
          assert.equal(historical.length, 3);
          const operations = model.operationsInput();
          operations.vehicleGroups[0].count = 1;
          await model.save('/operations', 'PUT', { operations });
          const task = await model.run();
          assert.equal(task.snapshot.context.operations.vehicleGroups[0].vehicleIds.length, 3);
          assert.deepEqual(
            task.result.vehicles.map((vehicle) => vehicle.vehicleId),
            [historical[0]],
          );
          assert.ok(task.result.trips.every((trip) => trip.vehicleId === historical[0]));
        },
      );
      await t.test(
        'decimal tonnes never create an extra trip for a rounding residual',
        async () => {
          const model = await createModel(request, {
            names: [['A', 'B', 'A']],
            demandRows: [[0, 0, 1, 0.9]],
            payloadTonnes: 0.3,
          });
          const { result } = await model.run();
          assert.equal(result.trips.length, 3);
          assert.equal(result.vehicles[0].workingMinutes, 90);
          assert.equal(result.totalCompletedTonnes, 0.9);
          assert.equal(result.totalMissingTonnes, 0);
        },
      );
      await t.test(
        '3,000 decimal-load trips complete exactly the requested tonnage through the real Worker',
        async () => {
          const model = await createModel(request, {
            names: [['A', 'B', 'A']],
            demandRows: [[0, 0, 1, 134790]],
            count: 50,
            payloadTonnes: 44.93,
            speedKph: 120,
            loadingMinutes: 1,
            unloadingMinutes: 1,
            shifts: [{ startMinute: 0, endMinute: 720 }],
          });
          const { result } = await model.run();
          // A loop takes 5 + 5 minutes of driving and 2 minutes of handling.
          // 50 vehicles × 60 full loops × 44.93 tonnes yields exactly 134,790 tonnes.
          assert.equal(result.trips.length, 3000);
          assert.equal(result.totalCompletedTonnes, 134790);
          assert.equal(result.totalMissingTonnes, 0);
          assert.equal(result.totalDistanceMeters, 60000000);
          assert.equal(result.validation.valid, true);
          assert.ok(
            result.vehicles.every(
              (vehicle) => vehicle.tripIds.length === 60 && vehicle.workingMinutes === 720,
            ),
          );
        },
      );
      await t.test(
        'tiny positive demand and zero operation minutes remain explicit without rounding away completion',
        async () => {
          const model = await createModel(request, {
            names: [['A', 'B', 'A']],
            demandRows: [[0, 0, 1, 1e-12]],
            loadingMinutes: 0,
            unloadingMinutes: 0,
          });
          const { result } = await model.run();
          assert.equal(result.totalCompletedTonnes, 1e-12);
          assert.equal(result.totalMissingTonnes, 0);
          assert.equal(result.trips.length, 1);
          assert.equal(result.vehicles[0].workingMinutes, 20);
        },
      );
      await t.test(
        '100 demands and 50 supplied vehicles use the same real Worker and preserve total flow',
        async () => {
          const model = await createModel(request, {
            names: [['A', 'B', 'A']],
            demandRows: Array.from({ length: 100 }, () => [0, 0, 1, 5]),
            count: 50,
          });
          const { result } = await model.run();
          assert.equal(result.vehicles.length, 50);
          assert.equal(result.demands.length, 100);
          assert.equal(result.trips.length, 50);
          assert.equal(result.totalCompletedTonnes, 500);
          assert.equal(result.totalMissingTonnes, 0);
          assert.equal(result.totalDistanceMeters, 1000000);
          assert.equal(result.validation.valid, true);
        },
      );
      await t.test(
        'a zero-duration whole loop reports an input gap instead of generating unbounded zero-time trips',
        async () => {
          distance = '0';
          const model = await createModel(request, {
            names: [['A', 'B', 'A']],
            demandRows: [[0, 0, 1, 1000000000]],
            loadingMinutes: 0,
            unloadingMinutes: 0,
          });
          await model.prepare();
          const response = await request(`${model.path}/daily-transport`, 'POST', {
            expectedRevision: model.scenario.revision,
          });
          assert.equal(response.status, 400, JSON.stringify(response.body));
          assert.match(JSON.stringify(response.body), /全程及装卸耗时为零/);
          distance = '10000';
        },
      );
    } catch (error) {
      throw new Error(`${error.message}\n${app?.logs() ?? ''}`, { cause: error });
    } finally {
      await app?.stop();
      await app?.cleanup();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
  },
);
