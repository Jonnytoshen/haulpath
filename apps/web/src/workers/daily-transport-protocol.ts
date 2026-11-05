import type {
  DailyTransportProgress,
  DailyTransportResult,
  DailyTransportTask,
} from '@haulpath/domain';

export type DailyTransportWorkerData = Pick<
  DailyTransportTask,
  'taskId' | 'projectId' | 'scenarioId' | 'inputVersion' | 'snapshot' | 'config'
>;
type Identity = Pick<
  DailyTransportWorkerData,
  'taskId' | 'projectId' | 'scenarioId' | 'inputVersion'
>;
export type DailyTransportWorkerMessage = Identity &
  (
    | { type: 'progress'; progress: DailyTransportProgress }
    | { type: 'result'; result: DailyTransportResult }
    | { type: 'error'; error: string }
  );
