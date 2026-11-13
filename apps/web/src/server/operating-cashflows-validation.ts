import {
  operatingFlowBases,
  validOperatingRate,
  tariffWindowIssue,
  type OperatingCashflowInput,
  type OperatingFlow,
  type OperatingBasis,
} from '@haulpath/domain';
import { HttpError } from './http';
import { scenarioFields } from './scenario-validation';

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, '运营收支输入须为对象');
  const input = value as Record<string, unknown>;
  scenarioFields(input, fields);
  return input;
}
function text(value: unknown, name: string, blank = true): string {
  if (typeof value !== 'string' || value.length > 2000 || (!blank && !value.trim()))
    throw new HttpError(400, `${name}无效`);
  return value.trim();
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new HttpError(400, '运营收支明细须为最多1000项的数组');
  return value;
}
function rate(value: unknown): string | null {
  if (value === null) return null;
  if (!validOperatingRate(value))
    throw new HttpError(400, '单价须为非负十进制文本，最多12位整数、6位小数，未知请留空');
  return value;
}
function unique(values: (string | number)[], name: string) {
  if (new Set(values).size !== values.length) throw new HttpError(400, `${name}不能重复`);
}
export function operatingCashflowInputOf(value: unknown): OperatingCashflowInput {
  const input = object(value, ['boundary', 'years']);
  if (
    input.boundary !== null &&
    input.boundary !== 'integrated' &&
    input.boundary !== 'station-only'
  )
    throw new HttpError(400, '业务边界无效');
  const years = array(input.years)
    .map((entry) => {
      const year = object(entry, [
        'year',
        'scopeSource',
        'stationCostMode',
        'lines',
        'electricity',
      ]);
      if (
        typeof year.year !== 'number' ||
        !Number.isInteger(year.year) ||
        year.year < 1 ||
        year.year > 9999
      )
        throw new HttpError(400, '年份须为1至9999的整数');
      if (
        year.stationCostMode !== null &&
        year.stationCostMode !== 'station-types' &&
        year.stationCostMode !== 'annual-lines'
      )
        throw new HttpError(400, '站点运维口径无效');
      const stationCostMode = year.stationCostMode;
      const lines = array(year.lines).map((entry) => {
        const line = object(entry, ['id', 'name', 'flow', 'basis', 'rate', 'source', 'stationId']);
        const flow = line.flow as OperatingFlow;
        const basis = line.basis as OperatingBasis;
        if (!Object.hasOwn(operatingFlowBases, flow) || !operatingFlowBases[flow].includes(basis))
          throw new HttpError(400, '费用归属或计费单位不匹配');
        if (
          line.stationId !== null &&
          (typeof line.stationId !== 'string' || !line.stationId.trim())
        )
          throw new HttpError(400, '站址身份无效');
        if (line.stationId && flow.startsWith('transport'))
          throw new HttpError(400, '运输方收支不能限定站址');
        if (stationCostMode === 'station-types' && flow === 'station-cost')
          throw new HttpError(
            400,
            '采用站型运维时不能重复录入站方运营费用，请选择年度明细替代口径',
          );
        return {
          id: text(line.id, '明细身份', false),
          name: text(line.name, '项目名称', false),
          flow,
          basis,
          rate: rate(line.rate),
          source: text(line.source, '价格来源'),
          stationId: line.stationId as string | null,
        };
      });
      unique(
        lines.map((l) => l.id),
        '收支明细身份',
      );
      const electricity = array(year.electricity).map((entry) => {
        const power = object(entry, ['powerSourceId', 'payer', 'windows']);
        if (
          power.payer !== null &&
          power.payer !== 'station' &&
          power.payer !== 'transport' &&
          power.payer !== 'external'
        )
          throw new HttpError(400, '购电承担方无效');
        const windows = array(power.windows).map((entry) => {
          const w = object(entry, ['startMinute', 'endMinute', 'rate', 'source']);
          if (
            typeof w.startMinute !== 'number' ||
            typeof w.endMinute !== 'number' ||
            !Number.isInteger(w.startMinute) ||
            !Number.isInteger(w.endMinute) ||
            w.startMinute < 0 ||
            w.startMinute >= 1440 ||
            w.endMinute < 0 ||
            w.endMinute > 1440 ||
            w.startMinute === w.endMinute
          )
            throw new HttpError(400, '电价窗口须为日内整数分钟；跨午夜可结束早于开始');
          return {
            startMinute: w.startMinute,
            endMinute: w.endMinute,
            rate: rate(w.rate),
            source: text(w.source, '电价来源'),
          };
        });
        const windowIssue = tariffWindowIssue(windows);
        if (windowIssue) throw new HttpError(400, windowIssue);
        return {
          powerSourceId: text(power.powerSourceId, '电源身份', false),
          payer: power.payer,
          windows,
        };
      });
      unique(
        electricity.map((p) => p.powerSourceId),
        '购电电源',
      );
      return {
        year: year.year,
        scopeSource: text(year.scopeSource, '收支范围依据'),
        stationCostMode,
        lines,
        electricity,
      };
    })
    .sort((a, b) => a.year - b.year);
  unique(
    years.map((y) => y.year),
    '评价年份',
  );
  return { boundary: input.boundary, years } as OperatingCashflowInput;
}
