import type {
  JsonObject,
  JsonValue,
  PlanningScenarioContext,
  PlanningScenario,
  TransportCycle,
  TransportDemand,
  FleetOperations,
  StationNetwork,
} from '@haulpath/domain';
import { HttpError } from './http';

export function scenarioFields(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new HttpError(400, '规划方案包含不支持或受保护的字段');
}

export function scenarioRevision(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1)
    throw new HttpError(400, '规划方案修订号无效');
  return input;
}

function jsonValue(input: unknown, depth = 0): input is JsonValue {
  if (depth > 50) return false;
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return true;
  if (typeof input === 'number') return Number.isFinite(input);
  if (Array.isArray(input)) return input.every((value) => jsonValue(value, depth + 1));
  return jsonObject(input, depth);
}

function jsonObject(input: unknown, depth = 0): input is JsonObject {
  return (
    input !== null &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.values(input).every((value) => jsonValue(value, depth + 1))
  );
}

export function scenarioContext(input: unknown): PlanningScenarioContext {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HttpError(400, '规划方案上下文无效');
  const context = input as Record<string, unknown>;
  scenarioFields(context, [
    'schemaVersion',
    'resources',
    'transportCycles',
    'transportDemands',
    'operations',
    'stationNetwork',
    'annual',
    'results',
  ]);
  if (
    context.schemaVersion !== 1 ||
    !jsonObject(context.resources) ||
    (context.transportCycles !== undefined &&
      (!Array.isArray(context.transportCycles) || !jsonValue(context.transportCycles))) ||
    (context.transportDemands !== undefined &&
      (!Array.isArray(context.transportDemands) || !jsonValue(context.transportDemands))) ||
    (context.operations !== undefined && !jsonObject(context.operations)) ||
    (context.stationNetwork !== undefined && !jsonObject(context.stationNetwork)) ||
    !Array.isArray(context.annual) ||
    !context.annual.every((year) => jsonObject(year)) ||
    !Array.isArray(context.results) ||
    !context.results.every((result) => jsonObject(result))
  )
    throw new HttpError(400, '规划方案上下文版本或内容无效');
  return {
    schemaVersion: 1,
    resources: context.resources,
    ...(context.transportCycles === undefined
      ? {}
      : { transportCycles: context.transportCycles as unknown as TransportCycle[] }),
    ...(context.transportDemands === undefined
      ? {}
      : { transportDemands: context.transportDemands as unknown as TransportDemand[] }),
    ...(context.operations === undefined
      ? {}
      : { operations: context.operations as unknown as FleetOperations }),
    ...(context.stationNetwork === undefined
      ? {}
      : { stationNetwork: context.stationNetwork as unknown as StationNetwork }),
    annual: context.annual,
    results: context.results,
  };
}

export function assertScenarioEditable(scenario: PlanningScenario): void {
  if (scenario.status !== 'draft')
    throw new HttpError(409, '冻结版本不可修改，请复制为新草案后继续编辑');
}
