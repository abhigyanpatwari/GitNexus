/**
 * #3913 — validating-predicate barrier guards (CDG, `__proto__` callees, filter).
 */
import { describe, it, expect } from 'vitest';
import { cfgOf, cfgsOf, importsFor } from '../../helpers/ts-cfg-harness.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';
import { hasTaintSafeSites } from '../../../src/core/ingestion/taint/site-safety.js';
import type { SourceSinkSanitizerSpec } from '../../../src/core/ingestion/taint/source-sink-config.js';
import {
  buildTaintImportIndex,
  matchFunctionSites,
} from '../../../src/core/ingestion/taint/match.js';
import { computeTaintFlows } from '../../../src/core/ingestion/taint/propagate.js';
import {
  buildBarrierGuardIndex,
  discoverProtoGuardCallees,
  functionContainsProtoGuard,
  isBarrierCalleeName,
  isBarrierGuarded,
  validatedLabelForCondition,
} from '../../../src/core/ingestion/taint/barrier-guards.js';

const MECH: SourceSinkSanitizerSpec = {
  sources: [
    {
      kind: 'remote-input',
      objects: ['req'],
      properties: ['body', 'query', 'params', 'headers'],
    },
  ],
  sinks: [{ name: 'exec', kind: 'command-injection', args: [0], global: true }],
  sanitizers: [],
};

function analyze(code: string, fnIndex = 0, extraBarrierCallees?: ReadonlySet<string>) {
  const cfg = cfgOf(code, fnIndex);
  expect(hasTaintSafeSites(cfg)).toBe(true);
  const defUse = computeReachingDefs(cfg);
  const matches = matchFunctionSites(cfg, MECH, buildTaintImportIndex(importsFor(code)));
  return {
    cfg,
    flows: computeTaintFlows(
      cfg,
      defUse,
      matches,
      undefined,
      undefined,
      extraBarrierCallees ? { extraBarrierCallees } : undefined,
    ),
  };
}

function analyzeWithFileProtoGuards(code: string, fnIndex: number) {
  const cfgs = cfgsOf(code);
  const protoGuards = discoverProtoGuardCallees(cfgs);
  return analyze(code, fnIndex, protoGuards);
}

describe('barrier-guards name + polarity helpers', () => {
  it.each([
    ['isValidHostName', true],
    ['isValidKey', true],
    ['isSafeHost', true], // isX shape
    ['validateInput', true],
    ['checkToken', true],
    ['safeKey', false],
    ['validator.isEmail', true], // leaf isEmail matches isX
    ['isNaN', false],
    ['isArray', false],
    ['hasOwnProperty', false],
    ['maybeOk', false],
  ])('%s → %s', (name, expected) => {
    expect(isBarrierCalleeName(name)).toBe(expected);
  });

  it('maps leading ! polarity to the validated CDG label', () => {
    expect(validatedLabelForCondition('(!isValidHostName(hostname))', 'isValidHostName')).toBe(
      'F',
    );
    expect(validatedLabelForCondition('(isValidHostName(hostname))', 'isValidHostName')).toBe('T');
  });
});

describe('barrier-guards CDG index', () => {
  it('guards the fall-through after if (!isValid(x)) return', () => {
    const cfg = cfgOf(`
      function f(req: any) {
        const hostname = req.body;
        if (!isValidHostName(hostname)) return;
        exec(hostname);
      }
    `);
    const index = buildBarrierGuardIndex(cfg);
    const hostname = cfg.bindings!.findIndex((b) => b.name === 'hostname');
    const sink = cfg.blocks.find((b) => b.text.includes('exec(hostname)'))!.index;
    expect(isBarrierGuarded(index, hostname, sink)?.callee).toBe('isValidHostName');
  });
});

describe('barrier-guards via computeTaintFlows (#3913)', () => {
  it('suppresses dns-sync early-return shape', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const hostname = req.body;
        if (!isValidHostName(hostname)) return;
        exec(hostname);
      }
    `);
    expect(flows.status).toBe('computed');
    expect(flows.findings).toHaveLength(0);
    expect(flows.kills.length).toBeGreaterThan(0);
  });

  it('suppresses then-branch shape', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const hostname = req.body;
        if (isValidHostName(hostname)) {
          exec(hostname);
        }
      }
    `);
    expect(flows.findings).toHaveLength(0);
  });

  it('still finds the unguarded flow', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const hostname = req.body;
        exec(hostname);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('still finds the wrong-branch flow', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const hostname = req.body;
        if (!isValidHostName(hostname)) {
          exec(hostname);
        }
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not kill for an unknown non-validating predicate', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const hostname = req.body;
        if (!maybeOk(hostname)) return;
        exec(hostname);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('reduce-object: early return before the sink leaves no finding on that path', () => {
    // Patched shape: config-flag early return; no sink remains on the continuing path.
    const { flows } = analyze(`
      function reduce(req: any) {
        const obj = req.body;
        if (obj && obj.plain) return obj;
        return obj;
      }
    `);
    expect(flows.findings).toHaveLength(0);
  });
});

describe('barrier-guards __proto__ callee + filter (#3913 §2)', () => {
  it('detects __proto__ guard bodies and names them via functionName', () => {
    const cfgs = cfgsOf(`
      function safeKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
      function other(key: string) {
        return key.length > 0;
      }
    `);
    expect(cfgs[0].functionName).toBe('safeKey');
    expect(functionContainsProtoGuard(cfgs[0])).toBe(true);
    expect(functionContainsProtoGuard(cfgs[1])).toBe(false);
    expect([...discoverProtoGuardCallees(cfgs)]).toEqual(['safeKey']);
  });

  it('barriers a writer that calls a __proto__-guard function without "valid" in the name', () => {
    const code = `
      function safeKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
      function write(req: any) {
        const key = req.body;
        if (!safeKey(key)) return;
        exec(key);
      }
    `;
    const { flows } = analyzeWithFileProtoGuards(code, 1);
    expect(flows.findings).toHaveLength(0);
  });

  it('set-value: .filter(isValidKey) neutralizes keys before the sink', () => {
    const { flows } = analyze(
      `
      function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
      function set(req: any) {
        const path = req.body;
        const keys = path.split(".").filter(isValidKey);
        for (const key of keys) {
          exec(key);
        }
      }
    `,
      1,
    );
    expect(flows.findings).toHaveLength(0);
  });

  it('keeps node.extend-style setProperty without a __proto__ guard as a finding', () => {
    // Negative control from #3913: a writer that does NOT call a proto guard.
    const { flows } = analyze(`
      function setProperty(req: any) {
        const key = req.body;
        exec(key);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });
});
