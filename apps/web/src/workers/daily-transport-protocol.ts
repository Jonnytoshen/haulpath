import type {
  DailyTransportProgress,
  DailyTransportSearch,
  DailyTransportResult,
  DailyTransportTask,
} from '@haulpath/domain';

export type DailyTransportWorkerData = Pick<
  DailyTransportTask,
  'taskId' | 'projectId' | 'scenarioId' | 'inputVersion' | 'snapshot' | 'config' | 'search'
>;
type Identity = Pick<
  DailyTransportWorkerData,
  'taskId' | 'projectId' | 'scenarioId' | 'inputVersion'
>;
export type DailyTransportWorkerMessage = Identity &
  (
    | { type: 'candidate'; search: DailyTransportSearch; result: DailyTransportResult }
    | { type: 'search'; search: DailyTransportSearch }
    | { type: 'finished' }
    | { type: 'progress'; progress: DailyTransportProgress }
    | { type: 'result'; result: DailyTransportResult }
    | { type: 'error'; error: string }
  );
