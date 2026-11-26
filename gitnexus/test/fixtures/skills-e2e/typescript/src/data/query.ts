
import { formatResult } from './format';
import { getCached } from './cache';

export function runQuery(sql: string) {
  const cached = getCached(sql);
  if (cached) return cached;
  return formatResult({ sql, rows: [] });
}

export function buildQuery(table: string, conditions: any) {
  return 'SELECT * FROM ' + table;
}
