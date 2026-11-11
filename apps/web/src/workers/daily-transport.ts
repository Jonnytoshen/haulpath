import { parentPort, workerData } from 'node:worker_threads';
import {
  generateDailyStationTurnover,
  generateDailySharedPower,
  generateDailyTransport,
  searchDailyTransport,
  generateVehicleEnergy,
} from '@haulpath/domain';
import type {
  DailyTransportWorkerData,
  DailyTransportWorkerMessage,
} from './daily-transport-protocol';

const data = workerData as DailyTransportWorkerData;
const identity = {
  taskId: data.taskId,
  projectId: data.projectId,
  scenarioId: data.scenarioId,
  inputVersion: data.inputVersion,
};
function send(message: DailyTransportWorkerMessage): void {
  parentPort?.postMessage(message);
}
let lastProgressAt = -Infinity;
try {
  const generators = {
    transport: generateDailyTransport,
    'vehicle-energy': generateVehicleEnergy,
    'station-turnover': generateDailyStationTurnover,
    'shared-power': generateDailySharedPower,
  };
  const progress = (progress: import('@haulpath/domain').DailyTransportProgress) => {
    const now = Date.now();
    if (now - lastProgressAt < 100) return;
    lastProgressAt = now;
    send({ ...identity, type: 'progress', progress });
  };
  if (data.config.stage === 'repeatable-day' && data.search) {
    let lastSearchAt = -Infinity;
    searchDailyTransport(
      data.snapshot,
      data.config,
      data.taskId,
      data.search,
      progress,
      (search, result) => {
        if (result) send({ ...identity, type: 'candidate', search, result });
        else if (Date.now() - lastSearchAt >= 100 || search.phase === 'finished') {
          lastSearchAt = Date.now();
          send({ ...identity, type: 'search', search });
        }
      },
    );
    send({ ...identity, type: 'finished' });
  } else {
    const generate = generators[(data.config.stage as keyof typeof generators) ?? 'transport'];
    const result = generate(data.snapshot, progress, data.config);
    send({ ...identity, type: 'result', result });
  }
} catch (error) {
  send({
    ...identity,
    type: 'error',
    error: error instanceof Error ? error.message : '运输试算未能完成',
  });
} finally {
  parentPort?.close();
}
