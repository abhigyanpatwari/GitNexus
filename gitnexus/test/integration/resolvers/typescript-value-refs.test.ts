/**
 * TypeScript/JavaScript: value-position function references (#2437).
 *
 * Registration (`{ emitScopeCaptures: emitHook }`, shorthand `{ emitHook }`)
 * emits a reference-class USES edge — a registration is not an invocation.
 * Invocation is recovered by the field-based property-dispatch pass:
 * member-call sites `x.emitScopeCaptures()` gain synthesized CALLS edges
 * (reason `property-dispatch`, discounted confidence) to every function
 * registered under that property name. Non-callable values emit nothing
 * (resolution is MethodRegistry-gated), and promiscuous keys past the
 * fan-out cap are dropped entirely.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
  type RelEdge,
} from './helpers.js';
import {
  MAX_PROPERTY_DISPATCH_FANOUT,
  PROPERTY_DISPATCH_CONFIDENCE,
} from '../../../src/core/ingestion/scope-resolution/passes/property-dispatch.js';
import { _captureLogger, type PinoLogRecord } from '../../../src/core/logger.js';

function writeFixtureRepo(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
}

function edgesFrom(edges: RelEdge[], sourceFile: string): RelEdge[] {
  return edges.filter((c) => c.sourceFilePath === sourceFile);
}

const VALUE_REF_REASON = 'scope-resolution: value-ref';
const DISPATCH_REASON = 'property-dispatch';

describe('value-position function references (#2437)', () => {
  let repoDir: string;
  let result: PipelineResult;
  let calls: RelEdge[];
  let uses: RelEdge[];
  let logRecords: PinoLogRecord[];

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-value-refs-'));
    const cappedFunctions = Array.from(
      { length: MAX_PROPERTY_DISPATCH_FANOUT + 1 },
      (_, i) =>
        `export function capped${i}(): void {}\nexport const holder${i} = { common: capped${i} };`,
    ).join('\n');
    writeFixtureRepo(repoDir, {
      // Same-file provider object: hook value, plain value, factory call.
      'src/provider.ts': `
export function emitHook(): void {}
export const DEFAULT_PORT = 8080;
export function createVisitor(): () => void {
  return () => {};
}
export function targetCallback(): void {}
export function invokeCallback(callback: () => void): void { callback(); }
export const provider = {
  emitScopeCaptures: emitHook,
  runWithCallback: invokeCallback,
  port: DEFAULT_PORT,
  cfgVisitor: createVisitor(),
};
`,
      // Dispatch through the property — the scope-extractor-bridge shape.
      'src/bridge.ts': `
import { provider, targetCallback } from './provider';
export function runBridge(): void {
  provider.emitScopeCaptures();
  provider.runWithCallback(targetCallback);
  provider.toString();
}
`,
      // Cross-file registration: the c-cpp.ts shape.
      'src/impl.ts': `
export function emitCrossHook(): void {}
`,
      'src/registry.ts': `
import { emitCrossHook } from './impl';
export const registry = { emitScopeCaptures: emitCrossHook };
`,
      // Aliased import as pair value.
      'src/alias-registry.ts': `
import { emitCrossHook as hookImpl } from './impl';
export const aliasRegistry = { emitScopeCaptures: hookImpl };
`,
      // Shorthand registration + dispatch through it.
      'src/shorthand.ts': `
import { emitCrossHook } from './impl';
export const shorthandRegistry = { emitCrossHook };
`,
      'src/dispatch-shorthand.ts': `
import { shorthandRegistry } from './shorthand';
export function runShorthand(): void {
  shorthandRegistry.emitCrossHook();
}
`,
      // Destructuring shorthand must NOT produce a value-ref.
      'src/destructure.ts': `
export function pickHook(): void {}
const holder = { pickHook };
const { pickHook: picked } = holder;
export const keep = picked;
`,
      // Fan-out cap: one key registered by MAX+1 distinct functions.
      'src/capped.ts': `
${cappedFunctions}
`,
      'src/dispatch-capped.ts': `
import { holder0 } from './capped';
export function runCap(): void {
  holder0.common();
}
`,
      // JavaScript twins (separate query file, same patterns).
      'src/js/provider.js': `
export function emitJsHook() {}
export const DEFAULT_LIMIT = 5;
export const jsProvider = { emitScopeCaptures: emitJsHook, limit: DEFAULT_LIMIT };
`,
      'src/js/shorthand.js': `
import { emitJsHook } from './provider';
export const jsShorthand = { emitJsHook };
`,
      'src/js/bridge.js': `
import { jsProvider } from './provider';
export function runJsBridge() {
  jsProvider.emitScopeCaptures();
}
`,
    });
    const loggerCapture = _captureLogger();
    try {
      result = await runPipelineFromRepo(repoDir, () => {}, {});
      logRecords = loggerCapture.records();
    } finally {
      loggerCapture.restore();
    }
    calls = getRelationships(result, 'CALLS');
    uses = getRelationships(result, 'USES');
  }, 120000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  // ── Registration → USES ──────────────────────────────────────────────────

  it('emits USES from the provider file to a same-file longhand hook value', () => {
    const edge = edgesFrom(uses, 'src/provider.ts').find((c) => c.target === 'emitHook');
    expect(edge).toBeDefined();
    expect(edge!.sourceLabel).toBe('File');
    expect(edge!.rel.reason).toBe(VALUE_REF_REASON);
  });

  it('does not emit CALLS at the registration site', () => {
    expect(
      edgesFrom(calls, 'src/provider.ts').find(
        (c) => c.target === 'emitHook' && c.rel.reason === VALUE_REF_REASON,
      ),
    ).toBe(undefined);
  });

  it('emits nothing for a non-callable pair value', () => {
    expect(edgesFrom(calls, 'src/provider.ts').find((c) => c.target === 'DEFAULT_PORT')).toBe(
      undefined,
    );
    expect(
      edgesFrom(uses, 'src/provider.ts').find(
        (c) => c.target === 'DEFAULT_PORT' && c.rel.reason === VALUE_REF_REASON,
      ),
    ).toBe(undefined);
  });

  it('keeps a factory-call pair value as a single call-site CALLS edge', () => {
    const factory = edgesFrom(calls, 'src/provider.ts').filter((c) => c.target === 'createVisitor');
    expect(factory).toHaveLength(1);
    expect(factory[0]!.rel.reason).not.toBe(DISPATCH_REASON);
  });

  it('emits USES across files for an imported hook (the c-cpp.ts shape)', () => {
    const edge = edgesFrom(uses, 'src/registry.ts').find((c) => c.target === 'emitCrossHook');
    expect(edge).toBeDefined();
    expect(edge!.targetFilePath).toBe('src/impl.ts');
    expect(edge!.rel.reason).toBe(VALUE_REF_REASON);
  });

  it('resolves an aliased import pair value to the original definition', () => {
    const edge = edgesFrom(uses, 'src/alias-registry.ts').find((c) => c.target === 'emitCrossHook');
    expect(edge).toBeDefined();
    expect(edge!.targetFilePath).toBe('src/impl.ts');
  });

  it('emits USES for a shorthand property referencing an imported hook', () => {
    const edge = edgesFrom(uses, 'src/shorthand.ts').find((c) => c.target === 'emitCrossHook');
    expect(edge).toBeDefined();
    expect(edge!.targetFilePath).toBe('src/impl.ts');
  });

  it('emits exactly one value-ref USES per site (object shorthand), none for destructuring', () => {
    const destructure = edgesFrom(uses, 'src/destructure.ts').filter(
      (c) => c.target === 'pickHook' && c.rel.reason === VALUE_REF_REASON,
    );
    expect(destructure).toHaveLength(1);
  });

  // ── Dispatch → synthesized CALLS ─────────────────────────────────────────

  it('synthesizes CALLS from the dispatch site to the registered hook', () => {
    const edge = calls.find(
      (c) =>
        c.source === 'runBridge' && c.target === 'emitHook' && c.rel.reason === DISPATCH_REASON,
    );
    expect(edge).toBeDefined();
    expect(edge!.targetFilePath).toBe('src/provider.ts');
    expect(edge!.rel.confidence).toBe(PROPERTY_DISPATCH_CONFIDENCE);
  });

  it('propagates a callback through a property-dispatched wrapper before indirect resolution', () => {
    const edge = calls.find(
      (candidate) =>
        candidate.source === 'invokeCallback' &&
        candidate.target === 'targetCallback' &&
        candidate.rel.reason === 'callable-value-flow',
    );
    expect(edge).toBeDefined();
    expect(edge!.sourceFilePath).toBe('src/provider.ts');
    expect(edge!.targetFilePath).toBe('src/provider.ts');
  });

  it('dispatch fans out to every same-language registration of the property name', () => {
    // `emitScopeCaptures` is registered in TypeScript by emitHook
    // (provider.ts) and emitCrossHook (registry.ts + alias-registry.ts,
    // deduped by def) — a TS call through the key reaches both. emitJsHook
    // is NOT reached: scope resolution runs per language provider, so JS
    // registrations are visible only to JS dispatch sites (see runJsBridge).
    const targets = calls
      .filter((c) => c.source === 'runBridge' && c.rel.reason === DISPATCH_REASON)
      .map((c) => c.target)
      .sort();
    expect(targets).toEqual(['emitCrossHook', 'emitHook', 'invokeCallback']);
  });

  it('dispatches through a shorthand-registered key', () => {
    const edge = calls.find(
      (c) =>
        c.source === 'runShorthand' &&
        c.target === 'emitCrossHook' &&
        c.rel.reason === DISPATCH_REASON,
    );
    expect(edge).toBeDefined();
  });

  it('does not synthesize CALLS for unregistered member calls', () => {
    expect(calls.find((c) => c.target === 'toString' && c.rel.reason === DISPATCH_REASON)).toBe(
      undefined,
    );
  });

  it('drops keys past the fan-out cap entirely', () => {
    const cappedDispatch = calls.filter(
      (c) => c.rel.reason === DISPATCH_REASON && c.target.startsWith('capped'),
    );
    expect(cappedDispatch).toEqual([]);

    const capWarnings = logRecords.filter(
      (record) =>
        record.msg ===
        'property-dispatch: keys over the fan-out cap were dropped (no CALLS synthesized for them)',
    );
    expect(capWarnings).toHaveLength(1);
    expect(capWarnings[0]).toMatchObject({
      level: 40,
      lang: 'typescript',
      skippedKeys: 1,
      fanoutCap: MAX_PROPERTY_DISPATCH_FANOUT,
    });
  });

  it('every property-dispatch edge targets a registered hook', () => {
    const dispatchTargets = new Set(
      calls.filter((c) => c.rel.reason === DISPATCH_REASON).map((c) => c.target),
    );
    expect([...dispatchTargets].sort()).toEqual([
      'emitCrossHook',
      'emitHook',
      'emitJsHook',
      'invokeCallback',
    ]);
  });

  // ── JavaScript twins ─────────────────────────────────────────────────────

  it('emits USES for JavaScript longhand and shorthand hook values', () => {
    const longhand = edgesFrom(uses, 'src/js/provider.js').find((c) => c.target === 'emitJsHook');
    expect(longhand).toBeDefined();
    expect(longhand!.rel.reason).toBe(VALUE_REF_REASON);
    const shorthand = edgesFrom(uses, 'src/js/shorthand.js').find((c) => c.target === 'emitJsHook');
    expect(shorthand).toBeDefined();
  });

  it('synthesizes CALLS from a JavaScript dispatch site', () => {
    const edge = calls.find(
      (c) =>
        c.source === 'runJsBridge' && c.target === 'emitJsHook' && c.rel.reason === DISPATCH_REASON,
    );
    expect(edge).toBeDefined();
  });

  it('emits nothing for a non-callable JavaScript pair value', () => {
    expect(edgesFrom(calls, 'src/js/provider.js').find((c) => c.target === 'DEFAULT_LIMIT')).toBe(
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Declarator-named arrows: `const handler = () => {}` referenced as a pair
// value. Pins whether the arrow def is callable-labeled (USES emitted) —
// kept as its own suite so the pinned behavior is visible in isolation.
// ---------------------------------------------------------------------------

describe('value-position reference to a const-arrow handler (#2437)', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-value-refs-arrow-'));
    writeFixtureRepo(repoDir, {
      'src/arrow.ts': `
const handler = (): void => {};
export const arrowRegistry = { onEvent: handler };
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {}, {});
  }, 120000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('emits USES to the arrow function definition', () => {
    const edge = getRelationships(result, 'USES').find(
      (c) => c.sourceFilePath === 'src/arrow.ts' && c.target === 'handler',
    );
    expect(edge).toBeDefined();
    expect(edge!.rel.reason).toBe(VALUE_REF_REASON);
  });
});
