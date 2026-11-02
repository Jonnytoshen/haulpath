import type {
  JsonObject,
  JsonValue,
  PlanningScenarioContext,
  TransportCycle,
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
  scenarioFields(context, ['schemaVersion', 'resources', 'transportCycles', 'annual', 'results']);
  if (
    context.schemaVersion !== 1 ||
    !jsonObject(context.resources) ||
    (context.transportCycles !== undefined &&
      (!Array.isArray(context.transportCycles) || !jsonValue(context.transportCycles))) ||
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
    annual: context.annual,
    results: context.results,
  };
}
