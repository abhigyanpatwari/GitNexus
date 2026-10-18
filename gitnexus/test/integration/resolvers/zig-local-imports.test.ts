import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { optionalGrammarGate } from '../../helpers/optional-grammar.js';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';

const zig = optionalGrammarGate(SupportedLanguages.Zig);

async function callsFor(source: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-zig-local-imports-'));
  try {
    writeFixtureRepo(dir, {
      'main.zig': source,
      'a.zig': `pub fn same() void {}
pub fn allowed() void {}
pub fn forbidden() void {}
pub const Inner = struct { pub fn run() void {} };
`,
      'b.zig': `pub fn same() void {}
pub const Inner = struct { pub fn run() void {} };
`,
    });
    const result = await runPipelineFromRepo(dir, () => {});
    return getRelationships(result, 'CALLS').filter((edge) => edge.sourceFilePath === 'main.zig');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe.skipIf(!zig.available)('Zig block-local imports', () => {
  it('resolves legal same-name namespace aliases independently in sibling blocks', async () => {
    const calls = await callsFor(`pub fn siblings() void {
    { const m = @import("a.zig"); m.same(); }
    { const m = @import("b.zig"); m.same(); }
}
`);
    expect(calls.map((edge) => edge.rel.targetId).sort()).toEqual([
      'Function:a.zig:same',
      'Function:b.zig:same',
    ]);
  });

  it('does not expose a block alias after leaving its block', async () => {
    const calls = await callsFor(`pub fn afterBlock() void {
    { const m = @import("a.zig"); m.allowed(); }
    m.forbidden();
}
`);
    expect(calls.map((edge) => edge.rel.targetId)).toEqual(['Function:a.zig:allowed']);
  });

  it('does not resolve an alias before its local declaration', async () => {
    const calls = await callsFor(`pub fn beforeDeclaration() void {
    m.forbidden();
    const m = @import("a.zig");
    m.allowed();
}
`);
    expect(calls.map((edge) => edge.rel.targetId)).toEqual(['Function:a.zig:allowed']);
  });

  it('keeps deep aliases within their declaration block', async () => {
    const calls = await callsFor(`pub fn deepSiblings() void {
    { const m = @import("a.zig"); const chosen = m.Inner.run; chosen(); }
    { const m = @import("b.zig"); const chosen = m.Inner.run; chosen(); }
}
`);
    expect(calls.map((edge) => edge.rel.targetId).sort()).toEqual([
      'Method:a.zig:Inner.run#0',
      'Method:b.zig:Inner.run#0',
    ]);
  });

  it('does not borrow an unrelated callable for an unresolved named import', async () => {
    const calls = await callsFor(`pub fn missingImport() void {
    const forbidden = @import("missing.zig").forbidden;
    forbidden();
}
`);
    expect(calls).toEqual([]);
  });

  it('resolves a named member alias through the enclosing block import', async () => {
    const calls = await callsFor(`pub fn namedAlias() void {
    { const m = @import("a.zig"); const local = m.allowed; local(); }
}
`);
    expect(calls.map((edge) => edge.rel.targetId)).toEqual(['Function:a.zig:allowed']);
  });

  it('retains repeated inline receivers in separate functions', async () => {
    const calls = await callsFor(`pub fn first() void { @import("a.zig").allowed(); }
pub fn second() void { @import("a.zig").allowed(); }
`);
    expect(calls.map((edge) => [edge.source, edge.rel.targetId]).sort()).toEqual([
      ['first', 'Function:a.zig:allowed'],
      ['second', 'Function:a.zig:allowed'],
    ]);
  });

  it('preserves declaration-order independent module imports', async () => {
    const calls = await callsFor(`pub fn moduleImport() void { m.allowed(); }
const m = @import("a.zig");
`);
    expect(calls.map((edge) => edge.rel.targetId)).toEqual(['Function:a.zig:allowed']);
  });
});
