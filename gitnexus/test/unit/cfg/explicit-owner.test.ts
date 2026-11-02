import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { emitFileCfgs, isEmitSafeCfg } from '../../../src/core/ingestion/cfg/emit.js';
import { CfgBuilder } from '../../../src/core/ingestion/cfg/cfg-builder.js';
import { BASICBLOCK_CSV_HEADER, buildBasicBlockRow } from '../../../src/core/lbug/csv-generator.js';
import { getCopyQuery } from '../../../src/core/lbug/lbug-adapter.js';
import { BASICBLOCK_SCHEMA } from '../../../src/core/lbug/schema.js';

describe('provider-declared executable region owner', () => {
  it('carries the exact owner through graph emission and the persisted row', () => {
    const builder = new CfgBuilder('program.cbl', 8, 15, 0);
    builder.connect([builder.entryIndex], builder.exitIndex, 'seq');
    const cfg = { ...builder.finish(), ownerId: 'Module:program.cbl:PAYROLL' };
    const graph = createKnowledgeGraph();
    emitFileCfgs(graph, [cfg]);
    const blocks = [...graph.iterNodes()];
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.properties.ownerId === cfg.ownerId)).toBe(true);
    const columns = BASICBLOCK_CSV_HEADER.split(',');
    expect(columns).toContain('ownerId');
    expect(buildBasicBlockRow(blocks[0]!).split(',')[columns.indexOf('ownerId')]).toBe(
      '"Module:program.cbl:PAYROLL"',
    );
    expect(getCopyQuery('BasicBlock', '/tmp/blocks.csv')).toContain('ownerId');
    expect(BASICBLOCK_SCHEMA).toContain('ownerId STRING');
  });

  it('rejects malformed explicit owners while retaining the implicit function format', () => {
    const builder = new CfgBuilder('a.ts', 1, 3, 0);
    builder.connect([builder.entryIndex], builder.exitIndex, 'seq');
    const cfg = builder.finish();
    expect(isEmitSafeCfg(cfg)).toBe(true);
    expect(isEmitSafeCfg({ ...cfg, ownerId: '' })).toBe(false);
    expect(isEmitSafeCfg({ ...cfg, ownerId: 12 } as never)).toBe(false);
  });
});
