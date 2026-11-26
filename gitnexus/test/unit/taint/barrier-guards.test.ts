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
    ['validateInput', true],
    ['validHost', true],
    ['isSafeHost', false], // bare isX — not a value voucher
    ['checkToken', false], // bare checkX — must not kill command-injection
    ['isInvalid', false], // contains "valid" but means the opposite
    ['isInvalidHost', false],
    ['safeKey', false],
    ['validator.isEmail', false], // leaf isEmail — no isValid*/validate*
    ['isNaN', false],
    ['isArray', false],
    ['hasOwnProperty', false],
    ['maybeOk', false],
  ])('%s → %s', (name, expected) => {
    expect(isBarrierCalleeName(name)).toBe(expected);
  });

  it('maps leading ! polarity to the validated CDG label', () => {
    expect(validatedLabelForCondition('(!isValidHostName(hostname))', 'isValidHostName')).toBe('F');
    expect(validatedLabelForCondition('(isValidHostName(hostname))', 'isValidHostName')).toBe('T');
  });

  it('keeps bang polarity across qualified callees', () => {
    expect(
      validatedLabelForCondition(
        '(!validators.isValidHostName(hostname))',
        'validators.isValidHostName',
      ),
    ).toBe('F');
    expect(
      validatedLabelForCondition('(validators.isValidHostName(hostname))', 'isValidHostName'),
    ).toBe('T');
  });

  it('refuses compound conditions (|| / &&)', () => {
    expect(
      validatedLabelForCondition('(isValidHostName(hostname) || debugMode)', 'isValidHostName'),
    ).toBeUndefined();
    expect(
      validatedLabelForCondition('(isValidHostName(hostname) && ready)', 'isValidHostName'),
    ).toBeUndefined();
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
    const hostname = (cfg.bindings ?? []).findIndex((b) => b.name === 'hostname');
    const sinkBlock = cfg.blocks.find((b) => b.text.includes('exec(hostname)'));
    expect(sinkBlock).toBeDefined();
    if (!sinkBlock) throw new Error('missing sink block');
    expect(isBarrierGuarded(index, hostname, sinkBlock.index)?.callee).toBe('isValidHostName');
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

  it('does not suppress for checkToken (name is not a value voucher)', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const cmd = req.body;
        if (!checkToken(cmd)) return;
        exec(cmd);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress for isInvalid on the true branch', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const cmd = req.body;
        if (isInvalid(cmd)) {
          exec(cmd);
        }
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress compound || conditions', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const hostname = req.body;
        if (isValidHostName(hostname) || debugMode) {
          exec(hostname);
        }
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress when the binding is reassigned after validation', () => {
    const { flows } = analyze(`
      function f(req: any) {
        let hostname = req.body;
        if (!isValidHostName(hostname)) return;
        hostname = req.query.command;
        exec(hostname);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not treat reduce-object config-flag early-return as a validator barrier', () => {
    // Under-kill: `obj.plain` is not a validating predicate — sink still fires.
    const { flows } = analyze(`
      function reduce(req: any) {
        const obj = req.body;
        if (obj && obj.plain) return obj;
        exec(obj);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not validate secondary args of a multi-arg validator call', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const hostname = req.body;
        const command = req.query;
        if (!isValidHostName(hostname, command)) return;
        exec(command);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
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

  it('discovers const-arrow __proto__ guards via inferred functionName', () => {
    const code = `
      const safeKey = (key: string) => key !== "__proto__" && key !== "constructor";
      function write(req: any) {
        const key = req.body;
        if (!safeKey(key)) return;
        exec(key);
      }
    `;
    const cfgs = cfgsOf(code);
    expect(cfgs.some((c) => c.functionName === 'safeKey')).toBe(true);
    expect([...discoverProtoGuardCallees(cfgs)]).toContain('safeKey');
    const { flows } = analyzeWithFileProtoGuards(code, 1);
    expect(flows.findings).toHaveLength(0);
  });

  it('does not treat a __proto__ logger that always returns true as a guard', () => {
    const code = `
      function logProto(key: string) {
        if (key === "__proto__") console.log("proto");
        return true;
      }
      function write(req: any) {
        const key = req.body;
        if (!logProto(key)) return;
        exec(key);
      }
    `;
    const cfgs = cfgsOf(code);
    expect([...discoverProtoGuardCallees(cfgs)]).not.toContain('logProto');
    const { flows } = analyzeWithFileProtoGuards(code, 1);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('suppresses qualified !validators.isValidHostName early-return', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const hostname = req.body;
        if (!validators.isValidHostName(hostname)) return;
        exec(hostname);
      }
    `);
    expect(flows.findings).toHaveLength(0);
  });

  it('set-value: .filter(isValidKey) neutralizes keys when callback is a proto-guard', () => {
    const code = `
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
    `;
    const { flows } = analyzeWithFileProtoGuards(code, 1);
    expect(flows.findings).toHaveLength(0);
  });

  it('does not neutralize .filter when isValid* callback always returns true', () => {
    const code = `
      function isValidKey(_key: string) {
        return true;
      }
      function set(req: any) {
        const path = req.body;
        const keys = path.split(".").filter(isValidKey);
        for (const key of keys) {
          exec(key);
        }
      }
    `;
    const { flows } = analyzeWithFileProtoGuards(code, 1);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not treat filter thisArg as the barrier callback', () => {
    const code = `
      function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
      function set(req: any) {
        const path = req.body;
        const keys = path.split(".").filter(() => true, isValidKey);
        for (const key of keys) {
          exec(key);
        }
      }
    `;
    const { flows } = analyzeWithFileProtoGuards(code, 1);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
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
