import type { Worker } from 'node:worker_threads';
import type { DailyTransportWorkerMessage } from '../workers/daily-transport-protocol';
import { HttpError } from './http';
import { storage } from './storage';
import { createDailyTransportWorker } from './daily-transport-worker';

type TransportRunner = {
  tail: Promise<void>;
  tasks: Map<string, Promise<void>>;
  workers: Map<string, Worker>;
};
const runnerGlobal = globalThis as typeof globalThis & {
  haulpathTransportRunner?: TransportRunner;
};
const runner = () =>
  (runnerGlobal.haulpathTransportRunner ??= {
    tail: Promise.resolve(),
    tasks: new Map(),
    workers: new Map(),
  });

export function abortDailyTransportTask(taskId: string): void {
  void runner().workers.get(taskId)?.terminate();
}
export function runDailyTransportTask(
  projectId: string,
  scenarioId: string,
  taskId: string,
): Promise<void> {
  const state = runner();
  const existing = state.tasks.get(taskId);
  if (existing) return existing;
  const promise = execute(projectId, scenarioId, taskId).finally(() => state.tasks.delete(taskId));
  state.tasks.set(taskId, promise);
  return promise;
}
function fail(
  projectId: string,
  scenarioId: string,
  taskId: string,
  timeout: boolean,
  message: string,
) {
  try {
    storage.dailyTransport.fail(projectId, scenarioId, taskId, timeout, message);
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 404))
      console.error(
        'Transport task could not be saved',
        error instanceof Error ? error.message : 'unknown error',
      );
  }
}
async function execute(projectId: string, scenarioId: string, taskId: string): Promise<void> {
  const state = runner();
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  let worker: Worker | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await previous;
    const task = storage.dailyTransport.start(projectId, scenarioId, taskId);
    if (!task) return;
    worker = await createDailyTransportWorker({
      taskId,
      projectId,
      scenarioId,
      inputVersion: task.inputVersion,
      snapshot: task.snapshot,
      config: task.config,
    });
    state.workers.set(taskId, worker);
    const runningWorker = worker;
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        if (error) reject(error);
        else resolve();
      };
      deadline = setTimeout(
        () => {
          fail(projectId, scenarioId, taskId, true, '运输试算已达到时限，请重新试算');
          void runningWorker.terminate();
          finish();
        },
        Math.max(1, task.config.maxRuntimeMs - (Date.now() - Date.parse(task.startedAt!))),
      );
      monitor = setInterval(() => {
        try {
          if (storage.dailyTransport.getTask(projectId, scenarioId, taskId).status !== 'running') {
            void runningWorker.terminate();
            finish();
          }
        } catch (error) {
          void runningWorker.terminate();
          finish(error instanceof Error ? error : new Error('任务不存在'));
        }
      }, 250);
      runningWorker.on('message', (message: DailyTransportWorkerMessage) => {
        if (finished) return;
        if (
          message.taskId !== taskId ||
          message.projectId !== projectId ||
          message.scenarioId !== scenarioId ||
          message.inputVersion !== task.inputVersion
        ) {
          finish(new Error('Worker 消息归属不匹配'));
          return;
        }
        try {
          if (message.type === 'progress') {
            if (!storage.dailyTransport.progress(projectId, scenarioId, taskId, message.progress)) {
              void runningWorker.terminate();
              finish();
            }
          } else if (message.type === 'result') {
            storage.dailyTransport.complete(projectId, scenarioId, taskId, message.result);
            finish();
          } else if (message.type === 'error') finish(new Error(message.error));
        } catch (error) {
          finish(error instanceof Error ? error : new Error('无法保存运输试算'));
        }
      });
      runningWorker.once('error', (error) => finish(error));
      runningWorker.once('exit', (code) => {
        if (finished) return;
        try {
          const status = storage.dailyTransport.getTask(projectId, scenarioId, taskId).status;
          finish(status === 'running' ? new Error(`运输 Worker 提前退出（${code}）`) : undefined);
        } catch (error) {
          finish(error instanceof Error ? error : new Error('任务不存在'));
        }
      });
    });
  } catch (error) {
    fail(
      projectId,
      scenarioId,
      taskId,
      false,
      error instanceof Error ? error.message : '运输试算未能完成，请重试',
    );
  } finally {
    if (monitor) clearInterval(monitor);
    if (deadline) clearTimeout(deadline);
    if (worker) await worker.terminate();
    state.workers.delete(taskId);
    release();
  }
}
