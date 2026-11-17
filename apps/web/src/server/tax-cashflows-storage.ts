import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  TAX_CASHFLOW_POLICY,
  OPERATING_CASHFLOW_POLICY,
  ASSET_CASHFLOW_POLICY,
  taxInputIssues,
  calculateTaxCashflows,
  type PlanningScenario,
  type TaxCashflowResult,
  type TaxCashflowView,
} from '@haulpath/domain';
import type { OperatingCashflowStorage } from './operating-cashflows-storage';
import type { AssetCashflowStorage } from './asset-cashflows-storage';
import { HttpError } from './http';
import { assertScenarioEditable, scenarioFields, scenarioRevision } from './scenario-validation';

export class TaxCashflowStorage {
  constructor(
    private db: Database.Database,
    private scenario: (projectId: string, scenarioId: string) => PlanningScenario,
    private operating: OperatingCashflowStorage,
    private assets: AssetCashflowStorage,
  ) {}
  getView(projectId: string, scenarioId: string): TaxCashflowView {
    const scenario = this.scenario(projectId, scenarioId);
    const rows = this.db
      .prepare(
        'SELECT payload FROM tax_cashflow_results WHERE project_id = ? AND scenario_id = ? ORDER BY rowid DESC',
      )
      .all(projectId, scenarioId) as { payload: string }[];
    return {
      inputVersion: scenario.inputVersion,
      issues: taxInputIssues(scenario.context),
      results: rows.map((r) => JSON.parse(r.payload)),
    };
  }
  getResult(projectId: string, scenarioId: string, resultId: string): TaxCashflowResult {
    this.scenario(projectId, scenarioId);
    const row = this.db
      .prepare(
        'SELECT payload FROM tax_cashflow_results WHERE id = ? AND project_id = ? AND scenario_id = ?',
      )
      .get(resultId, projectId, scenarioId) as { payload: string } | undefined;
    if (!row) throw new HttpError(404, '该规划方案下的税务现金流账目不存在');
    return JSON.parse(row.payload);
  }
  calculate(
    projectId: string,
    scenarioId: string,
    input: Record<string, unknown>,
  ): TaxCashflowResult {
    return this.db.transaction(() => {
      const scenario = this.scenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      scenarioFields(input, ['expectedRevision', 'operatingResultId', 'assetResultId']);
      if (scenarioRevision(input.expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后核对');
      if (!scenario.context.taxCashflows) throw new HttpError(409, '请先保存税务规则');
      if (
        typeof input.operatingResultId !== 'string' ||
        !input.operatingResultId ||
        typeof input.assetResultId !== 'string' ||
        !input.assetResultId
      )
        throw new HttpError(400, '请显式选择本方案的运营及资产账目');
      const operating = this.operating.getResult(projectId, scenarioId, input.operatingResultId);
      const assets = this.assets.getResult(projectId, scenarioId, input.assetResultId);
      if (
        !operating.complete ||
        !assets.complete ||
        operating.policy !== OPERATING_CASHFLOW_POLICY ||
        assets.policy !== ASSET_CASHFLOW_POLICY
      )
        throw new HttpError(409, '请选择完整且政策兼容的运营及资产账目');
      if (
        !isDeepStrictEqual(operating.input, scenario.context.operatingCashflows) ||
        !isDeepStrictEqual(operating.annualInputs, scenario.context.annualTransport) ||
        !isDeepStrictEqual(assets.input, scenario.context.assetCashflows) ||
        !isDeepStrictEqual(assets.stationNetwork, scenario.context.stationNetwork ?? null)
      )
        throw new HttpError(409, '来源账目与当前运营、资产、年份或站网输入不相容，请显式重新核对');
      if (operating.input.boundary !== assets.input.boundary)
        throw new HttpError(409, '来源账目的业务边界不一致');
      this.operating.assertCurrentEvidence(projectId, scenarioId, operating);
      const result: TaxCashflowResult = {
        id: randomUUID(),
        projectId,
        scenarioId,
        inputVersion: scenario.inputVersion,
        createdAt: new Date().toISOString(),
        policy: TAX_CASHFLOW_POLICY,
        input: structuredClone(scenario.context.taxCashflows),
        operatingResult: operating,
        assetResult: assets,
        economicStatus: 'not-ready',
        financingStatus: 'not-evaluated',
        financingTaxInterface: 'unlevered-income-before-loss-v1',
        ...calculateTaxCashflows(scenario.context, operating, assets),
      };
      this.db
        .prepare(
          'INSERT INTO tax_cashflow_results (id, project_id, scenario_id, payload) VALUES (?, ?, ?, ?)',
        )
        .run(result.id, projectId, scenarioId, JSON.stringify(result));
      return result;
    })();
  }
}
