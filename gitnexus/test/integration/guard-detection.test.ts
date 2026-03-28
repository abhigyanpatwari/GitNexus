import { describe, it, expect } from 'vitest';
import { extractGuardClauses, extractGuardedCalls } from '../../src/core/ingestion/guard-extractor.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixture = readFileSync(
  join(__dirname, '../fixtures/guard-clauses/route-handler.ts'),
  'utf-8'
);

describe('guard detection integration', () => {
  it('detects all guard clauses in a Next.js route handler', () => {
    const guards = extractGuardClauses(fixture, 'typescript');
    expect(guards.length).toBeGreaterThanOrEqual(3);

    const statuses = guards.map(g => g.returnStatus).filter(Boolean);
    expect(statuses).toContain(401);
    expect(statuses).toContain(403);
    expect(statuses).toContain(404);
  });

  it('detects guarded calls (conditional business logic)', () => {
    const guarded = extractGuardedCalls(fixture, 'typescript');
    const approvalCall = guarded.find(g => g.calledName === 'initializeApprovalWorkflow');
    expect(approvalCall).toBeDefined();
    expect(approvalCall!.guard).toContain('result.requiresApproval');
  });

  it('does not flag unconditional calls as guarded', () => {
    const guarded = extractGuardedCalls(fixture, 'typescript');
    const createCall = guarded.find(g => g.calledName === 'createGrant');
    expect(createCall).toBeUndefined(); // createGrant is unconditional
  });
});
