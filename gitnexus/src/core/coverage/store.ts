// gitnexus/src/core/coverage/store.ts
import Database from 'better-sqlite3';
import path from 'path';
import type {
  CoverageRunRecord,
  LineHitRecord,
  BranchHitRecord,
  SymbolCoverageRecord,
  EdgeTraversalRecord,
} from './types.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coverage_runs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  label TEXT,
  command TEXT,
  duration_ms INTEGER,
  total_execs INTEGER,
  total_lines INTEGER NOT NULL DEFAULT 0,
  covered_lines INTEGER NOT NULL DEFAULT 0,
  coverage_ratio REAL NOT NULL DEFAULT 0.0
);

CREATE TABLE IF NOT EXISTS line_hits (
  run_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, file_path, line_number)
);

CREATE TABLE IF NOT EXISTS branch_hits (
  run_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, file_path, line_number, branch_id)
);

CREATE TABLE IF NOT EXISTS symbol_coverage (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  symbol_name TEXT,
  file_path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  total_lines INTEGER NOT NULL DEFAULT 0,
  covered_lines INTEGER NOT NULL DEFAULT 0,
  coverage_ratio REAL NOT NULL DEFAULT 0.0,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE IF NOT EXISTS edge_traversal (
  run_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  source_node_id TEXT,
  target_node_id TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, edge_id)
);
`;

export class CoverageStore {
  private db: Database.Database;
  private insertRunStmt: Database.Statement;
  private insertLineHitStmt: Database.Statement;
  private insertBranchHitStmt: Database.Statement;
  private insertSymbolCovStmt: Database.Statement;
  private insertEdgeTravStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);

    this.insertRunStmt = this.db.prepare(`
      INSERT OR REPLACE INTO coverage_runs
        (id, timestamp, label, command, duration_ms, total_execs, total_lines, covered_lines, coverage_ratio)
      VALUES (@id, @timestamp, @label, @command, @durationMs, @totalExecs, @totalLines, @coveredLines, @coverageRatio)
    `);

    this.insertLineHitStmt = this.db.prepare(`
      INSERT OR REPLACE INTO line_hits (run_id, file_path, line_number, hit_count)
      VALUES (@runId, @filePath, @lineNumber, @hitCount)
    `);

    this.insertBranchHitStmt = this.db.prepare(`
      INSERT OR REPLACE INTO branch_hits (run_id, file_path, line_number, branch_id, hit_count)
      VALUES (@runId, @filePath, @lineNumber, @branchId, @hitCount)
    `);

    this.insertSymbolCovStmt = this.db.prepare(`
      INSERT OR REPLACE INTO symbol_coverage
        (run_id, node_id, symbol_name, file_path, start_line, end_line, total_lines, covered_lines, coverage_ratio)
      VALUES (@runId, @nodeId, @symbolName, @filePath, @startLine, @endLine, @totalLines, @coveredLines, @coverageRatio)
    `);

    this.insertEdgeTravStmt = this.db.prepare(`
      INSERT OR REPLACE INTO edge_traversal (run_id, edge_id, source_node_id, target_node_id, hit_count)
      VALUES (@runId, @edgeId, @sourceNodeId, @targetNodeId, @hitCount)
    `);
  }

  upsertRun(run: CoverageRunRecord): void {
    this.insertRunStmt.run({
      id: run.id,
      timestamp: run.timestamp,
      label: run.label ?? null,
      command: run.command ?? null,
      durationMs: run.durationMs ?? null,
      totalExecs: run.totalExecs ?? null,
      totalLines: run.totalLines,
      coveredLines: run.coveredLines,
      coverageRatio: run.coverageRatio,
    });
  }

  getRun(id: string): CoverageRunRecord | undefined {
    return this.db.prepare('SELECT * FROM coverage_runs WHERE id = ?').get(id) as CoverageRunRecord | undefined;
  }

  listRuns(): CoverageRunRecord[] {
    return this.db.prepare('SELECT * FROM coverage_runs ORDER BY timestamp DESC').all() as CoverageRunRecord[];
  }

  deleteRun(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM line_hits WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM branch_hits WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM symbol_coverage WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM edge_traversal WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM coverage_runs WHERE id = ?').run(id);
    });
    tx();
  }

  deleteAllRuns(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM line_hits').run();
      this.db.prepare('DELETE FROM branch_hits').run();
      this.db.prepare('DELETE FROM symbol_coverage').run();
      this.db.prepare('DELETE FROM edge_traversal').run();
      this.db.prepare('DELETE FROM coverage_runs').run();
    });
    tx();
  }

  insertLineHits(records: LineHitRecord[]): void {
    const tx = this.db.transaction(() => {
      for (const r of records) this.insertLineHitStmt.run(r);
    });
    tx();
  }

  insertBranchHits(records: BranchHitRecord[]): void {
    const tx = this.db.transaction(() => {
      for (const r of records) this.insertBranchHitStmt.run(r);
    });
    tx();
  }

  insertSymbolCoverage(records: SymbolCoverageRecord[]): void {
    const tx = this.db.transaction(() => {
      for (const r of records) this.insertSymbolCovStmt.run(r);
    });
    tx();
  }

  insertEdgeTraversals(records: EdgeTraversalRecord[]): void {
    const tx = this.db.transaction(() => {
      for (const r of records) this.insertEdgeTravStmt.run(r);
    });
    tx();
  }

  getLineHits(runId: string): LineHitRecord[] {
    return this.db.prepare('SELECT * FROM line_hits WHERE run_id = ?').all(runId) as LineHitRecord[];
  }

  getSymbolCoverage(runId: string): SymbolCoverageRecord[] {
    return this.db.prepare('SELECT * FROM symbol_coverage WHERE run_id = ?').all(runId) as SymbolCoverageRecord[];
  }

  getUncoveredSymbols(runId: string, limit = 10): SymbolCoverageRecord[] {
    return this.db.prepare(
      'SELECT * FROM symbol_coverage WHERE run_id = ? AND coverage_ratio < 1.0 ORDER BY coverage_ratio ASC LIMIT ?',
    ).all(runId, limit) as SymbolCoverageRecord[];
  }

  getMergedLineHits(runIds: string[]): Map<string, Map<number, number>> {
    const placeholders = runIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT file_path, line_number, MAX(hit_count) as max_hits
       FROM line_hits WHERE run_id IN (${placeholders})
       GROUP BY file_path, line_number`,
    ).all(...runIds) as { file_path: string; line_number: number; max_hits: number }[];

    const result = new Map<string, Map<number, number>>();
    for (const row of rows) {
      if (!result.has(row.file_path)) result.set(row.file_path, new Map());
      result.get(row.file_path)!.set(row.line_number, row.max_hits);
    }
    return result;
  }

  close(): void {
    this.db.close();
  }
}

export function openCoverageStore(repoPath: string): CoverageStore {
  const dbPath = path.join(repoPath, '.gitnexus', 'coverage.db');
  return new CoverageStore(dbPath);
}
