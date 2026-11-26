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

function analyze(code: string, fnIndex = 0) {
  const cfgs = cfgsOf(code);
  const cfg = cfgs[fnIndex] ?? cfgOf(code, fnIndex);
  expect(hasTaintSafeSites(cfg)).toBe(true);
  const defUse = computeReachingDefs(cfg);
  const matches = matchFunctionSites(cfg, MECH, buildTaintImportIndex(importsFor(code)));
  const excludeBarrierCallees = discoverProtoGuardCallees(cfgs);
  return {
    cfg,
    flows: computeTaintFlows(
      cfg,
      defUse,
      matches,
      undefined,
      undefined,
      excludeBarrierCallees.size > 0 ? { excludeBarrierCallees } : undefined,
    ),
  };
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

  it('suppresses direct source use at the sink (no intermediate binding def)', () => {
    // sourceOcc.point is the sink statement — must not be treated as a
    // post-check reassignment of the validated binding.
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        exec(req.body);
      }
    `);
    expect(flows.findings).toHaveLength(0);
  });

  it('does not suppress a different member of the same object', () => {
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        exec(req.query);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress when a sink arg mixes validated and unvalidated members', () => {
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        exec(req.body + req.query);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress after the validated member is overwritten', () => {
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        req.body = req.query;
        exec(req.body);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not treat compound validator args as validating each member', () => {
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body + req.query)) return;
        exec(req.body);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
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

  it('does not kind-blind suppress command-injection for proto-only safeKey', () => {
    // Proto-only names vouch for key shape, not shell safety.
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
    const { flows } = analyze(code, 1);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not kind-blind suppress isValidKey that only rejects __proto__', () => {
    const code = `
      function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
      function write(req: any) {
        const key = req.body;
        if (!isValidKey(key)) return;
        exec(key);
      }
    `;
    const { flows } = analyze(code, 1);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('suppresses when isValidKey vouchers the value (not proto-only)', () => {
    const code = `
      function isValidKey(key: string) {
        return /^[a-z0-9._-]+$/i.test(key);
      }
      function write(req: any) {
        const key = req.body;
        if (!isValidKey(key)) return;
        exec(key);
      }
    `;
    const { flows } = analyze(code, 1);
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
    // Discovery only — proto-only name must not kind-blind kill command-injection.
    const { flows } = analyze(code, 1);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
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
    const { flows } = analyze(code, 1);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects inverted acceptsProto as a proto-guard', () => {
    const cfgs = cfgsOf(`
      function acceptsProto(key: string) {
        if (key !== "__proto__") return false;
        return true;
      }
    `);
    expect(functionContainsProtoGuard(cfgs[0])).toBe(false);
    expect([...discoverProtoGuardCallees(cfgs)]).not.toContain('acceptsProto');
  });

  it('rejects equality that accepts __proto__ then returns false elsewhere', () => {
    const cfgs = cfgsOf(`
      function acceptsProto(key: string) {
        if (key === "__proto__") return true;
        return false;
      }
    `);
    expect(functionContainsProtoGuard(cfgs[0])).toBe(false);
  });

  it('accepts if (key === "__proto__") return false as a proto-guard', () => {
    const cfgs = cfgsOf(`
      function safeKey(key: string) {
        if (key === "__proto__") return false;
        return true;
      }
    `);
    expect(functionContainsProtoGuard(cfgs[0])).toBe(true);
  });

  it('rejects helpers that only log a !== __proto__ check then return true', () => {
    const cfgs = cfgsOf(`
      function logOk(key: string) {
        if (key !== "__proto__") console.log("ok");
        return true;
      }
    `);
    expect(functionContainsProtoGuard(cfgs[0])).toBe(false);
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

  it('set-value: .filter(protoKey) does not suppress command-injection findings', () => {
    // Kind contract: rejecting __proto__ must not kind-blind kill shell taint.
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
    const { flows } = analyze(code, 1);
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
