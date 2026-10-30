export function importCoordinate(value: string | number | undefined, label: string, limit: number, errors: string[]): string | number | undefined {
  if (value === undefined || (typeof value === 'string' && !value.trim())) {
    errors.push(`${label}缺失`);
    return undefined;
  }
  const number = typeof value === 'number' ? value
    : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(number)) {
    errors.push(`${label}必须为数值`);
    return value;
  }
  if (Math.abs(number) > limit) errors.push(`${label}超出有效范围（-${limit} 至 ${limit}）`);
  return number;
}
