import {
  annualTransportInputIssues,
  type AnnualTransportYear,
  type PlanningScenario,
} from '@haulpath/domain';
import { HttpError } from './http';
import { scenarioFields } from './scenario-validation';

export function annualTransportYearsOf(
  value: unknown,
  scenario: PlanningScenario,
): AnnualTransportYear[] {
  if (!Array.isArray(value)) throw new HttpError(400, '年度输入须为数组');
  const years = value
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new HttpError(400, '年度输入须为对象');
      scenarioFields(item, ['year', 'operatingDays', 'demands']);
      if (
        typeof item.year !== 'number' ||
        typeof item.operatingDays !== 'number' ||
        !Array.isArray(item.demands)
      )
        throw new HttpError(400, '请明确录入年份、运营天数及需求');
      const demands = item.demands
        .map((target: unknown) => {
          if (!target || typeof target !== 'object' || Array.isArray(target))
            throw new HttpError(400, '年度需求须为对象');
          const entry = target as Record<string, unknown>;
          scenarioFields(entry, ['demandId', 'dailyTonnes']);
          if (typeof entry.demandId !== 'string' || typeof entry.dailyTonnes !== 'number')
            throw new HttpError(400, '年度需求关联及吨数无效');
          return { demandId: entry.demandId, dailyTonnes: entry.dailyTonnes };
        })
        .sort((a: { demandId: string }, b: { demandId: string }) =>
          a.demandId.localeCompare(b.demandId),
        );
      return { year: item.year, operatingDays: item.operatingDays, demands };
    })
    .sort((a, b) => a.year - b.year);
  if (years.length) {
    const issues = annualTransportInputIssues({ ...scenario.context, annualTransport: years });
    if (issues.length) throw new HttpError(400, issues.join('；'));
  }
  return years;
}
