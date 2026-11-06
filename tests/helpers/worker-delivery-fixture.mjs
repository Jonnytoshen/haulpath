/** Hand-worked delivery example: 25 t, 10 t vehicle, 50 min complete cycles => 3 trips, 150 min. */
export function workerDeliveryData() {
  const a = { id: 'a', name: '港区', longitude: 121.47, latitude: 31.23 };
  const b = { id: 'b', name: '堆场', longitude: 121.6, latitude: 31.23 };
  const key = (from, to) =>
    JSON.stringify([
      from.longitude,
      from.latitude,
      to.longitude,
      to.latitude,
      32,
      `${from.longitude.toFixed(6)},${from.latitude.toFixed(6)}`,
      `${to.longitude.toFixed(6)},${to.latitude.toFixed(6)}`,
    ]);
  const roads = [
    [a, b],
    [b, a],
  ].map(([from, to]) => ({
    key: key(from, to),
    from,
    to,
    strategy: 32,
    distanceMeters: 10000,
    polyline: [
      [from.longitude, from.latitude],
      [to.longitude, to.latitude],
    ],
    source: 'amap',
    preparedAt: '2026-11-05T00:00:00.000Z',
  }));
  return {
    taskId: 'delivery',
    projectId: 'project',
    scenarioId: 'scenario',
    inputVersion: 1,
    snapshot: {
      revision: 1,
      roads,
      context: {
        schemaVersion: 1,
        transportCycles: [
          {
            id: 'cycle',
            name: '港区往返',
            strategy: 32,
            confirmed: true,
            positions: [
              { id: 'start', point: a },
              { id: 'unload', point: b },
              { id: 'end', point: a },
            ],
          },
        ],
        transportDemands: [
          {
            id: 'demand',
            cycleId: 'cycle',
            loadingPositionId: 'start',
            unloadingPositionId: 'unload',
            dailyTonnes: 25,
          },
        ],
        operations: {
          battery: null,
          measuredSegments: [],
          vehicleGroups: [
            {
              id: 'group',
              name: '十吨车',
              count: 1,
              vehicleIds: ['vehicle'],
              baseCycleId: 'cycle',
              baseStartPositionId: 'start',
              baseStartBasis: { longitude: a.longitude, latitude: a.latitude },
              payloadTonnes: 10,
              speedKph: 30,
              emptyKwhPerKm: null,
              fullKwhPerKm: null,
              safetySocPercent: null,
              shifts: [{ startMinute: 480, endMinute: 660 }],
              loadingMinutes: 5,
              unloadingMinutes: 5,
              source: '独立手算',
            },
          ],
        },
      },
    },
    config: { seed: 1, maxRuntimeMs: 300000 },
  };
}
