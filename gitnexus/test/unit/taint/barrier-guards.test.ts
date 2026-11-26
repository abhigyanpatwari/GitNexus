/**
 * #3913 — validating-predicate barrier guards (unit + end-to-end through
 * computeTaintFlows).
 */
import { describe, it, expect } from 'vitest';
import { cfgOf, importsFor } from '../../helpers/ts-cfg-harness.js';
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

function analyze(code: string) {
  const cfg = cfgOf(code, 0);
  expect(hasTaintSafeSites(cfg)).toBe(true);
  const defUse = computeReachingDefs(cfg);
  const matches = matchFunctionSites(cfg, MECH, buildTaintImportIndex(importsFor(code)));
  return { cfg, flows: computeTaintFlows(cfg, defUse, matches) };
}

describe('barrier-guards name + polarity helpers', () => {
  it.each([
    ['isValidHostName', true],
    ['isValidKey', true],
    ['validateInput', true],
    ['checkToken', true],
    ['validator.isEmail', false], // no validity signal in the leaf name
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
    expect(validatedLabelForCondition('(!!isValidHostName(hostname))', 'isValidHostName')).toBe(
      'T',
    );
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

  it('guards the then-branch of if (isValid(x))', () => {
    const cfg = cfgOf(`
      function f(req: any) {
        const hostname = req.body;
        if (isValidHostName(hostname)) {
          exec(hostname);
        }
      }
    `);
    const index = buildBarrierGuardIndex(cfg);
    const hostname = cfg.bindings!.findIndex((b) => b.name === 'hostname');
    const sink = cfg.blocks.find((b) => b.text.includes('exec(hostname)'))!.index;
    expect(isBarrierGuarded(index, hostname, sink)?.validatedLabel).toBe('T');
  });
});

describe('barrier-guards via computeTaintFlows (#3913)', () => {
  it('suppresses dns-sync early-return shape: if (!isValidHostName(x)) return; exec(x)', () => {
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

  it('suppresses then-branch shape: if (isValidHostName(x)) { exec(x) }', () => {
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

  it('still finds the wrong-branch flow: if (!isValid(x)) { exec(x) }', () => {
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
});
