import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  ASSET_CASHFLOW_POLICY,
  assetInputIssues,
  calculateAssetCashflows,
  type AssetCashflowResult,
  type AssetCashflowView,
  type PlanningScenario,
} from '@haulpath/domain';
import { HttpError } from './http';
import { assertScenarioEditable, scenarioFields, scenarioRevision } from './scenario-validation';

export class AssetCashflowStorage {
  constructor(
    private db: Database.Database,
    private scenario: (projectId: string, scenarioId: string) => PlanningScenario,
  ) {}
  getView(projectId: string, scenarioId: string): AssetCashflowView {
    const scenario = this.scenario(projectId, scenarioId);
    const rows = this.db
      .prepare(
        'SELECT payload FROM asset_cashflow_results WHERE project_id = ? AND scenario_id = ? ORDER BY rowid DESC',
      )
      .all(projectId, scenarioId) as { payload: string }[];
    return {
      inputVersion: scenario.inputVersion,
      issues: assetInputIssues(scenario.context),
      results: rows.map((r) => JSON.parse(r.payload)),
    };
  }
  getResult(projectId: string, scenarioId: string, resultId: string): AssetCashflowResult {
    this.scenario(projectId, scenarioId);
    const row = this.db
      .prepare(
        'SELECT payload FROM asset_cashflow_results WHERE id = ? AND project_id = ? AND scenario_id = ?',
      )
      .get(resultId, projectId, scenarioId) as { payload: string } | undefined;
    if (!row) throw new HttpError(404, '该规划方案下的资产收付账目不存在');
    return JSON.parse(row.payload);
  }
  calculate(
    projectId: string,
    scenarioId: string,
    input: Record<string, unknown>,
  ): AssetCashflowResult {
    return this.db.transaction(() => {
      const scenario = this.scenario(projectId, scenarioId);
      assertScenarioEditable(scenario);
      scenarioFields(input, ['expectedRevision']);
      if (scenarioRevision(input.expectedRevision) !== scenario.revision)
        throw new HttpError(409, '规划方案已被更新，请重新加载后核对');
      if (!scenario.context.assetCashflows) throw new HttpError(409, '请先保存资产与资金输入');
      const calculated = calculateAssetCashflows(scenario.context);
      const result: AssetCashflowResult = {
        id: randomUUID(),
        projectId,
        scenarioId,
        inputVersion: scenario.inputVersion,
        createdAt: new Date().toISOString(),
        policy: ASSET_CASHFLOW_POLICY,
        input: structuredClone(scenario.context.assetCashflows),
        stationNetwork: structuredClone(scenario.context.stationNetwork ?? null),
        economicStatus: 'not-ready',
        ...calculated,
      };
      this.db
        .prepare(
          'INSERT INTO asset_cashflow_results (id, project_id, scenario_id, payload) VALUES (?, ?, ?, ?)',
        )
        .run(result.id, projectId, scenarioId, JSON.stringify(result));
      return result;
    })();
  }
}
