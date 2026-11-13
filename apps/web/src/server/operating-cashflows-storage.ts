import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ANNUAL_TRANSPORT_ALGORITHM_VERSION,
  OPERATING_CASHFLOW_POLICY,
  calculateOperatingYear,
  operatingInputIssues,
  type OperatingCashflowResult,
  type OperatingCashflowView,
  type PlanningScenario,
  type PlanningScenarioContext,
} from '@haulpath/domain';
import type { DailyTransportStorage } from './daily-transport-storage';
import { HttpError } from './http';
import { assertScenarioEditable, scenarioFields, scenarioRevision } from './scenario-validation';

/** Full-context equivalence is deliberately conservative; only the explicit financial input and unvalidated results are excluded. */
function physicalInput(context: PlanningScenarioContext) {
  const physical = { ...context };
  delete physical.operatingCashflows;
  delete physical.assetCashflows;
  physical.results = [];
  return physical;
}
export class OperatingCashflowStorage {
  constructor(
    private db: Database.Database,
    private scenario: (projectId: string, scenarioId: string) => PlanningScenario,
    private transport: DailyTransportStorage,
  ) {}
  getView(projectId: string, scenarioId: string): OperatingCashflowView {
    const scenario = this.scenario(projectId, scenarioId);
    const rows = this.db
      .prepare(
        'SELECT payload FROM operating_cashflow_results WHERE project_id = ? AND scenario_id = ? ORDER BY rowid DESC',
      )
      .all(projectId, scenarioId) as { payload: string }[];
    return {
      projectId,
      scenarioId,
      inputVersion: scenario.inputVersion,
      issues: operatingInputIssues(scenario.context),
      results: rows.map((r) => JSON.parse(r.payload)),
    };
  }
  getResult(projectId: string, scenarioId: string, resultId: string): OperatingCashflowResult {
    this.scenario(projectId, scenarioId);
    const row = this.db
      .prepare(
        'SELECT payload FROM operating_cashflow_results WHERE id = ? AND project_id = ? AND scenario_id = ?',
      )
      .get(resultId, projectId, scenarioId) as { payload: string } | undefined;
    if (!row) throw new HttpError(404, '该规划方案下的运营收支结果不存在');
    return JSON.parse(row.payload);
  }
  calculate(
    projectId: string,
    scenarioId: string,
    input: Record<string, unknown>,
  ): OperatingCashflowResult {
    return this.db.transaction(() => {
      const scenario = this.scenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      scenarioFields(input, ['expectedRevision', 'sourceTaskId']);
      if (scenarioRevision(input.expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后核对');
      if (typeof input.sourceTaskId !== 'string' || !input.sourceTaskId)
        throw new HttpError(400, '请显式选择本方案年度任务作为实际业务依据');
      const source = this.transport.getTask(projectId, scenarioId, input.sourceTaskId);
      if (
        source.config.stage !== 'annual-transport' ||
        source.algorithmVersion !== ANNUAL_TRANSPORT_ALGORITHM_VERSION ||
        !source.annualResult ||
        ['queued', 'running'].includes(source.status)
      )
        throw new HttpError(409, '请选择已结束且保留年度成果的兼容任务');
      if (
        !isDeepStrictEqual(physicalInput(scenario.context), physicalInput(source.snapshot.context))
      )
        throw new HttpError(409, '年度证据与当前完整物理输入不等价，请重新校核运输能力');
      if (!scenario.context.annualTransport?.length) throw new HttpError(409, '年度物理输入待配置');
      const financial = scenario.context.operatingCashflows;
      if (!financial) throw new HttpError(409, '请先保存运营收支输入');
      const years = scenario.context.annualTransport.map((year) =>
        calculateOperatingYear(
          scenario.context,
          year,
          source.annualResult!.years.find((r) => r.year === year.year),
        ),
      );
      const issues = financial.years
        .filter((y) => !scenario.context.annualTransport!.some((p) => p.year === y.year))
        .map((y) => `${y.year}：评价年份关联失效，请显式修复`);
      if (!source.annualResult.complete)
        issues.push('来源年度任务未形成完整多年成果，仅核对已保留的年度证据');
      const result: OperatingCashflowResult = {
        id: randomUUID(),
        projectId,
        scenarioId,
        inputVersion: scenario.inputVersion,
        createdAt: new Date().toISOString(),
        sourceTaskId: source.taskId,
        sourceInputVersion: source.inputVersion,
        sourceStatus: source.status,
        sourceComplete: source.annualResult.complete,
        policy: OPERATING_CASHFLOW_POLICY,
        input: structuredClone(financial),
        annualInputs: structuredClone(scenario.context.annualTransport),
        complete: !issues.length && years.every((y) => y.complete),
        economicStatus: 'not-ready',
        issues,
        years,
      };
      this.db
        .prepare(
          'INSERT INTO operating_cashflow_results (id, project_id, scenario_id, payload) VALUES (?, ?, ?, ?)',
        )
        .run(result.id, projectId, scenarioId, JSON.stringify(result));
      return result;
    })();
  }
}
