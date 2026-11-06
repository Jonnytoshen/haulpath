import { parentPort, workerData } from 'node:worker_threads';
import { generateDailyTransport, generateVehicleEnergy } from '@haulpath/domain';
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
  const generate =
    data.config.stage === 'vehicle-energy' ? generateVehicleEnergy : generateDailyTransport;
  const result = generate(
    data.snapshot,
    (progress) => {
      const now = Date.now();
      if (now - lastProgressAt < 100) return;
      lastProgressAt = now;
      send({ ...identity, type: 'progress', progress });
    },
    data.config,
  );
  send({ ...identity, type: 'result', result });
} catch (error) {
  send({
    ...identity,
    type: 'error',
    error: error instanceof Error ? error.message : '运输试算未能完成',
  });
} finally {
  parentPort?.close();
}
