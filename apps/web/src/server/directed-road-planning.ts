import type { RoadRequirement } from '@haulpath/domain';
import { HttpError } from './http';
import { planLeg, withPlanningSlot } from './planning';
import { ROAD_TASK_TIMEOUT_MS } from './directed-road-storage';
import { storage } from './storage';

type RoadRunner = {
  tail: Promise<void>;
  controllers: Map<string, AbortController>;
  tasks: Map<string, Promise<void>>;
};
const runnerGlobal = globalThis as typeof globalThis & { haulpathRoadRunner?: RoadRunner };

function runner(): RoadRunner {
  const state = (runnerGlobal.haulpathRoadRunner ??= {
    tail: Promise.resolve(),
    controllers: new Map(),
    tasks: new Map(),
  });
  state.tasks ??= new Map();
  return state;
}

export function abortRoadTask(taskId: string): void {
  runner().controllers.get(taskId)?.abort(new DOMException('道路准备已停止', 'AbortError'));
}

/** Called by Next after(): the response carries the durable id before any upstream work starts. */
export function runRoadTask(projectId: string, scenarioId: string, taskId: string): Promise<void> {
  const state = runner();
  const existing = state.tasks.get(taskId);
  if (existing) return existing;
  const running = executeRoadTask(projectId, scenarioId, taskId).finally(() => {
    state.tasks.delete(taskId);
  });
  state.tasks.set(taskId, running);
  return running;
}

function failTask(
  projectId: string,
  scenarioId: string,
  taskId: string,
  timeout: boolean,
  message: string,
): void {
  try {
    storage.directedRoads.fail(projectId, scenarioId, taskId, timeout, message);
  } catch (failure) {
    // A deleted scenario/project also removes its task; no asynchronous callback may recreate it.
    if (!(failure instanceof HttpError && failure.status === 404))
      console.error(
        'Road task state could not be saved',
        failure instanceof Error ? failure.message : 'unknown error',
      );
  }
}

async function executeRoadTask(
  projectId: string,
  scenarioId: string,
  taskId: string,
): Promise<void> {
  const state = runner();
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  state.controllers.set(taskId, controller);
  let current: RoadRequirement | undefined;
  try {
    const queued = storage.directedRoads.getTask(projectId, scenarioId, taskId);
    if (queued.status !== 'queued') return;
    deadline = setTimeout(
      () => {
        const message = '道路准备已达到30分钟时限，请复用已有资料重新准备';
        controller.abort(new DOMException(message, 'TimeoutError'));
        failTask(projectId, scenarioId, taskId, true, message);
      },
      Math.max(1, ROAD_TASK_TIMEOUT_MS - (Date.now() - Date.parse(queued.createdAt))),
    );
    await previous;
    controller.signal.throwIfAborted();
    const task = storage.directedRoads.start(projectId, scenarioId, taskId);
    if (!task) return;
    const prepared = new Set(task.roads.map((road) => road.key));
    for (const requirement of task.snapshot.requirements) {
      if (prepared.has(requirement.key)) continue;
      current = requirement;
      const leg = await withPlanningSlot(async () => {
        if (storage.directedRoads.getTask(projectId, scenarioId, taskId).status !== 'running')
          throw new DOMException('方案版本已变化或任务已停止', 'AbortError');
        return planLeg(
          requirement.from,
          requirement.to,
          1,
          requirement.strategy,
          controller.signal,
        );
      }, controller.signal);
      if (
        !storage.directedRoads.publish(projectId, scenarioId, taskId, {
          key: requirement.key,
          from: requirement.from,
          to: requirement.to,
          strategy: requirement.strategy,
          distanceMeters: leg.distanceMeters,
          polyline: leg.polyline,
          source: 'amap',
          preparedAt: new Date().toISOString(),
        })
      )
        return;
    }
    storage.directedRoads.complete(projectId, scenarioId, taskId);
  } catch (error) {
    const timeout =
      (error instanceof HttpError && error.status === 504) ||
      (error instanceof Error && error.name === 'TimeoutError');
    const cause =
      error instanceof HttpError || timeout ? error.message : '道路准备未能完成，请重试';
    const message = current ? `${current.from.name} → ${current.to.name}：${cause}` : cause;
    failTask(projectId, scenarioId, taskId, timeout, message);
  } finally {
    if (deadline) clearTimeout(deadline);
    state.controllers.delete(taskId);
    // A task stopped before entering the queue must not release a later task past its predecessor.
    await previous;
    release();
  }
}
