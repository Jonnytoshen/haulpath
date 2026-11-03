import {
  isStrategy,
  scenarioInputFieldLabel,
  strategyLabels,
  type PlanningScenarioContext,
} from '@haulpath/domain';
import styles from './scenario-version-comparison.module.css';

export function scenarioInputNames(context: PlanningScenarioContext): Record<string, string> {
  const names: Record<string, string> = {};
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
  return names;
}

export default function ScenarioInputValue({
  value,
  names = {},
  field = '',
  path = field,
}: {
  value: unknown;
  names?: Record<string, string>;
  field?: string;
  path?: string;
}) {
  if (value == null || value === '') return <span className={styles.missing}>—</span>;
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>;
  if (typeof value === 'number')
    return (
      <span className={styles.number}>
        {field === 'strategy' && isStrategy(value)
          ? strategyLabels[value]
          : new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 17 }).format(value)}
      </span>
    );
  if (typeof value === 'string')
    return <span>{field.endsWith('Id') ? (names[value] ?? value) : value}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className={styles.missing}>无</span>;
    return (
      <ol className={styles.values}>
        {value.map((item, index) => (
          <li key={index}>
            {field === 'order' && item && typeof item === 'object' && 'name' in item ? (
              <span>
                {'id' in item && typeof item.id === 'string'
                  ? (names[item.id] ?? String(item.name))
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
    const entries = Object.entries(value).filter(([key]) => key !== 'schemaVersion');
    if (!entries.length) return <span className={styles.missing}>无</span>;
    return (
      <dl className={styles.valueFields}>
        {entries.map(([key, item]) => (
          <div key={key}>
            <dt>{scenarioInputFieldLabel(key, path)}</dt>
            <dd>
              <ScenarioInputValue value={item} names={names} field={key} path={`${path}.${key}`} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return null;
}
