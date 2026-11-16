import {
  assetCategories,
  assetOwners,
  assetEventNames,
  isStrategy,
  operatingBases,
  operatingFlows,
  scenarioInputFieldLabel,
  strategyLabels,
  type PlanningScenarioContext,
} from '@haulpath/domain';
import styles from './scenario-version-comparison.module.css';

export function scenarioInputNames(context: PlanningScenarioContext): Record<string, string> {
  const names = Object.create(null) as Record<string, string>;
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    const row = value as Record<string, unknown>;
    if (typeof row.id === 'string' && typeof row.name === 'string') names[row.id] = row.name;
    if (typeof row.id === 'string' && row.point && typeof row.point === 'object') {
      const point = row.point as Record<string, unknown>;
      if (typeof point.name === 'string') names[row.id] = point.name;
    }
    Object.values(row).forEach(visit);
  }
  visit(context);
  for (const cycle of context.transportCycles ?? []) {
    names[cycle.source.routeId] = cycle.source.name;
    cycle.positions.forEach((position, index) => {
      names[position.id] = `${cycle.name} · ${index + 1} ${position.point.name}`;
    });
  }
  for (const demand of context.transportDemands ?? []) {
    names[demand.id] =
      `${names[demand.loadingPositionId] ?? '装货位置'} → ${names[demand.unloadingPositionId] ?? '卸货位置'}`;
  }
  return names;
}

function inputName(names: Record<string, string>, id: string, fallback = id): string {
  return Object.hasOwn(names, id) && typeof names[id] === 'string' ? names[id] : fallback;
}

export default function ScenarioInputValue({
  value,
  names = Object.create(null) as Record<string, string>,
  field = '',
  path = field,
}: {
  value: unknown;
  names?: Record<string, string>;
  field?: string;
  path?: string;
}) {
  const genericInput = ['resources', 'annual'].some(
    (section) =>
      path === section || path.startsWith(`${section}.`) || path.startsWith(`${section}[`),
  );
  if (value === null && path.startsWith('swapDetourLimits.')) return <span>不限</span>;
  if (value == null || value === '') return <span className={styles.missing}>—</span>;
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>;
  if (typeof value === 'number')
    return (
      <span className={styles.number}>
        {!genericInput && ['strategy', 'continuationStrategy'].includes(field) && isStrategy(value)
          ? strategyLabels[value]
          : new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 17 }).format(value)}
      </span>
    );
  if (typeof value === 'string' && path.startsWith('assetCashflows.')) {
    const groups: Record<string, Record<string, string>> = {
      category: assetCategories,
      owner: assetOwners,
      kind: assetEventNames,
      boundary: { integrated: '一体化', 'station-only': '仅站方' },
      acquisition: { new: '本次新增', existing: '历史已发生' },
      budgetBucket: { station: '完整建站配置', connection: '接电工程' },
    };
    if (groups[field] && Object.hasOwn(groups[field], value))
      return <span>{groups[field][value]}</span>;
  }
  if (typeof value === 'string' && path.startsWith('operatingCashflows.')) {
    const labels: Record<string, string> = {
      ...operatingBases,
      ...operatingFlows,
      integrated: '一体化',
      'station-only': '仅站方',
      'station-types': '逐站采用站型年度运维',
      'annual-lines': '年度明细替代站型运维',
      station: '站方',
      transport: '运输方',
      external: '外部',
    };
    if (
      ['boundary', 'stationCostMode', 'basis', 'flow', 'payer'].includes(field) &&
      Object.hasOwn(labels, value)
    )
      return <span>{labels[value]}</span>;
  }
  if (typeof value === 'string')
    return <span>{!genericInput && field.endsWith('Id') ? inputName(names, value) : value}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className={styles.missing}>无</span>;
    return (
      <ol className={styles.values}>
        {value.map((item, index) => (
          <li key={index}>
            {!genericInput &&
            field === 'order' &&
            item &&
            typeof item === 'object' &&
            'name' in item ? (
              <span>
                {'id' in item && typeof item.id === 'string'
                  ? inputName(names, item.id, String(item.name))
                  : String(item.name)}
              </span>
            ) : (
              <ScenarioInputValue
                value={item}
                names={names}
                field={field}
                path={`${path}[${index}]`}
              />
            )}
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(
      ([key]) => genericInput || (key !== 'schemaVersion' && key !== 'id'),
    );
    if (!entries.length) return <span className={styles.missing}>无</span>;
    return (
      <dl className={styles.valueFields}>
        {entries.map(([key, item]) => (
          <div key={key}>
            <dt>{genericInput ? key : scenarioInputFieldLabel(key, path)}</dt>
            <dd>
              <ScenarioInputValue
                value={item}
                names={names}
                field={key}
                path={path ? `${path}.${key}` : key}
              />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}
