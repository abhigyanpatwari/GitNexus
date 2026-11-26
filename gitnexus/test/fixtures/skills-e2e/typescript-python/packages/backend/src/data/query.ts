
export function runQuery(sql: string) {
  return { sql, rows: [] };
}

export function buildQuery(table: string) {
  return 'SELECT * FROM ' + table;
}
