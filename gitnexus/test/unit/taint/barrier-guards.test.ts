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
  discoverProtoGuardRefs,
  functionContainsProtoGuard,
  isBarrierCalleeName,
  isBarrierGuarded,
  resolveBarrierExclusions,
  type ProtoGuardRef,
  validatedLabelForCondition,
} from '../../../src/core/ingestion/taint/barrier-guards.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';

/** Retarget CFG filePath for cross-module exclusion tests. */
function withFilePath(cfgs: readonly FunctionCfg[], filePath: string): FunctionCfg[] {
  return cfgs.map((c) => ({ ...c, filePath }));
}

const MECH: SourceSinkSanitizerSpec = {
  sources: [
    {
      kind: 'remote-input',
      objects: ['req', '$req'],
      properties: ['body', 'query', 'params', 'headers'],
    },
  ],
  sinks: [{ name: 'exec', kind: 'command-injection', args: [0], global: true }],
  sanitizers: [],
};

function analyze(
  code: string,
  fnIndex = 0,
  opts?: {
    excludeBarrierCallees?: ReadonlySet<string>;
    extraCfgs?: readonly FunctionCfg[];
    repoProtoGuards?: readonly ProtoGuardRef[];
  },
) {
  const cfgs = cfgsOf(code);
  const cfg = cfgs[fnIndex] ?? cfgOf(code, fnIndex);
  expect(hasTaintSafeSites(cfg)).toBe(true);
  const defUse = computeReachingDefs(cfg);
  const matches = matchFunctionSites(cfg, MECH, buildTaintImportIndex(importsFor(code)));
  const repoProto =
    opts?.repoProtoGuards ?? (opts?.extraCfgs ? discoverProtoGuardRefs(opts.extraCfgs) : undefined);
  const excludeBarrierCallees =
    opts?.excludeBarrierCallees ??
    resolveBarrierExclusions(cfgs, importsFor(code), repoProto, cfg.filePath);
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
    // #3913: name-heuristic barriers (`isValid*`) intentionally do not require
    // a resolvable callee body — patched CVE shapes use opaque validators.
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

  it('suppresses sinks nested under a further condition on the validated branch', () => {
    const { flows } = analyze(`
      function f(req: any, ready: boolean) {
        const hostname = req.body;
        if (!isValidHostName(hostname)) return;
        if (ready) {
          exec(hostname);
        }
      }
    `);
    expect(flows.findings).toHaveLength(0);
    expect(flows.kills.length).toBeGreaterThan(0);
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

  it('does not suppress after a compound member write reintroduces taint', () => {
    // `req.body += req.query` must invalidate the barrier the same as `=`.
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        req.body += req.query;
        exec(req.body);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
    expect(flows.kills).toHaveLength(0);
  });

  it('does not suppress after a destructuring write to the validated property', () => {
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        ({ body: req.body } = req.query);
        exec(req.body);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
    expect(flows.kills).toHaveLength(0);
  });

  it('does not suppress after a same-line conditional member write before the sink', () => {
    // Distinct CFG blocks can share endLine; write must still invalidate.
    const { flows } = analyze(`
      function f(req: any, rewrite: boolean) {
        if (!isValidHostName(req.body)) return;
        if (rewrite) req.body = req.query; exec(req.body);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress after a same-line conditional object rebinding before the sink', () => {
    const { flows } = analyze(`
      function f(req: any, other: any, rebind: boolean) {
        if (!isValidHostName(req.body)) return;
        if (rebind) req = other; exec(req.body);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress after a same-statement comma rebinding before the sink', () => {
    // Rebind and sink share one program point — text order must invalidate.
    const { flows } = analyze(`
      function f(req: any, other: any) {
        if (!isValidHostName(req.body)) return;
        (req = other, exec(req.body));
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('barrier kill records only the suppressed sink kind', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const hostname = req.body;
        if (!isValidHostName(hostname)) return;
        exec(hostname);
      }
    `);
    expect(flows.findings).toHaveLength(0);
    expect(flows.kills.length).toBeGreaterThan(0);
    for (const kill of flows.kills) {
      expect([...kill.neutralized]).toEqual(['command-injection']);
    }
  });

  it('does not suppress after a $-prefixed receiver member is overwritten', () => {
    // `\b` does not match before `$`; identifier lookbehind must.
    const { flows } = analyze(`
      function f($req: any) {
        if (!isValidHostName($req.body)) return;
        $req.body = $req.query;
        exec($req.body);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('still suppresses when a different object writes the same property name', () => {
    // `other.body =` must not be treated as overwriting validated `req.body`.
    const { flows } = analyze(`
      function f(req: any, other: any) {
        if (!isValidHostName(req.body)) return;
        other.body = req.query;
        exec(req.body);
      }
    `);
    expect(flows.findings).toHaveLength(0);
  });

  it('does not suppress same-line member overwrite before the sink', () => {
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        req.body = req.query; exec(req.body);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress when an earlier call precedes a pre-sink member overwrite', () => {
    // audit() must not be used as the sink anchor for assign-vs-call ordering.
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        (audit(), (req.body = req.query), exec(req.body));
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('still suppresses when the member write is after the sink', () => {
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        exec(req.body);
        req.body = req.query;
      }
    `);
    expect(flows.findings).toHaveLength(0);
  });

  it('still suppresses when a prior stmt exists and the member write is after the sink', () => {
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        const unused = 1;
        exec(req.body);
        req.body = req.query;
      }
    `);
    expect(flows.findings).toHaveLength(0);
  });

  it('does not suppress after the validated object binding is rebound', () => {
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        req = other;
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

  it('does not treat member+binding compounds as validating the member', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const suffix = req.query;
        if (!isValidHostName(req.body + suffix)) return;
        exec(req.body);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not treat compound plain-binding validator args as validating each part', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const command = req.body;
        const suffix = req.query;
        if (!isValidHostName(command + suffix)) return;
        exec(command);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress after a post-validation transform into the sink', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const host = req.body;
        if (!isValidHostName(host)) return;
        exec(host.replaceAll(".", ";"));
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress after a kind-partial sanitizer transform into the sink', () => {
    // escape neutralizes xss only; barrier must still refuse — validated
    // pre-escape value ≠ sink arg (sanitizer hop or args-narrow miss).
    const mech: SourceSinkSanitizerSpec = {
      ...MECH,
      sanitizers: [{ name: 'escape', neutralizes: ['xss'], global: true }],
    };
    for (const code of [
      `
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        exec(escape(req.body));
      }
    `,
      `
      function f(req: any) {
        const host = req.body;
        if (!isValidHostName(host)) return;
        exec(escape(host));
      }
    `,
    ]) {
      const cfgs = cfgsOf(code);
      const cfg = cfgs[0];
      expect(hasTaintSafeSites(cfg)).toBe(true);
      const defUse = computeReachingDefs(cfg);
      const matches = matchFunctionSites(cfg, mech, buildTaintImportIndex(importsFor(code)));
      const flows = computeTaintFlows(cfg, defUse, matches);
      expect(flows.findings.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('does not suppress through a matched sanitizer at a non-cleared arg position', () => {
    // sanitize clears only arg 1 — arg 0 still transforms; barrier must refuse.
    const mech: SourceSinkSanitizerSpec = {
      ...MECH,
      sanitizers: [
        { name: 'sanitize', args: [1], neutralizes: ['command-injection'], global: true },
      ],
    };
    const code = `
      function f(req: any, other: any) {
        if (!isValidHostName(req.body)) return;
        exec(sanitize(req.body, other));
      }
    `;
    const cfg = cfgsOf(code)[0];
    expect(hasTaintSafeSites(cfg)).toBe(true);
    const defUse = computeReachingDefs(cfg);
    const matches = matchFunctionSites(cfg, mech, buildTaintImportIndex(importsFor(code)));
    const flows = computeTaintFlows(cfg, defUse, matches);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress when a direct and transformed path share the sink arg', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const host = req.body;
        if (!isValidHostName(host)) return;
        exec(host + wrap(host));
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not treat isValid(command + command) as validating command', () => {
    const { flows } = analyze(`
      function f(req: any) {
        const command = req.body;
        if (!isValidHostName(command + command)) return;
        exec(command);
      }
    `);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('does not suppress after a multiline member overwrite before the sink', () => {
    const { flows } = analyze(`
      function f(req: any) {
        if (!isValidHostName(req.body)) return;
        req
          .body = req.query;
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

  it('does not kind-blind suppress qualified call to same-file proto-only helper', () => {
    const code = `
      function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
      function write(req: any) {
        const validators = { isValidKey };
        if (!validators.isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const { flows } = analyze(code, 1);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
    expect(flows.kills).toHaveLength(0);
  });

  it('keeps a genuine local isValidKey barrier despite an unrelated proto-only helper', () => {
    // Repo-wide name clash must not disable this file's real validator.
    const protoOnly = `
      export function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
    `;
    const genuine = `
      function isValidKey(key: string) {
        return /^[a-z0-9._-]+$/i.test(key);
      }
      function write(req: any) {
        if (!isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const { flows } = analyze(genuine, 1, {
      repoProtoGuards: discoverProtoGuardRefs(withFilePath(cfgsOf(protoOnly), 'other.ts')),
    });
    expect(flows.findings).toHaveLength(0);
    expect(flows.kills.length).toBeGreaterThan(0);
  });

  it('keeps a genuine imported isValidKey when another module has a proto-only same name', () => {
    const protoMod = `
      export function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
    `;
    const genuineMod = `
      export function isValidKey(key: string) {
        return /^[a-z0-9._-]+$/i.test(key);
      }
    `;
    const caller = `
      import { isValidKey } from './validators';
      function write(req: any) {
        if (!isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const repo = [
      ...discoverProtoGuardRefs(withFilePath(cfgsOf(protoMod), 'proto.ts')),
      ...discoverProtoGuardRefs(withFilePath(cfgsOf(genuineMod), 'validators.ts')),
    ];
    expect(repo.some((r) => r.name === 'isValidKey' && r.filePath === 'proto.ts')).toBe(true);
    expect(repo.some((r) => r.filePath === 'validators.ts')).toBe(false);
    const excluded = resolveBarrierExclusions(
      cfgsOf(caller),
      importsFor(caller),
      repo,
      'fixture.ts',
    );
    expect([...excluded]).not.toContain('isValidKey');
    const { flows } = analyze(caller, 0, { repoProtoGuards: repo });
    expect(flows.findings).toHaveLength(0);
  });

  it('resolves relative proto imports against the importing file path', () => {
    const proto = `
      export function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
    `;
    const caller = `
      import { isValidKey } from './guards';
      function write(req: any) {
        if (!isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const repo = [
      ...discoverProtoGuardRefs(withFilePath(cfgsOf(proto), 'current/guards.ts')),
      ...discoverProtoGuardRefs(withFilePath(cfgsOf(proto), 'other/guards.ts')),
    ];
    const fromCurrent = resolveBarrierExclusions(
      withFilePath(cfgsOf(caller), 'current/app.ts'),
      importsFor(caller),
      repo,
      'current/app.ts',
    );
    expect([...fromCurrent]).toContain('isValidKey');
    const fromOther = resolveBarrierExclusions(
      withFilePath(cfgsOf(caller), 'elsewhere/app.ts'),
      importsFor(caller),
      repo,
      'elsewhere/app.ts',
    );
    expect([...fromOther]).not.toContain('isValidKey');
  });

  it('does not kind-blind suppress imported proto-only isValidKey from another file', () => {
    // Caller-only discovery misses the helper body; cross-file exclusion must apply.
    const helper = `
      export function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
    `;
    const caller = `
      import { isValidKey } from './helpers';
      function write(req: any) {
        if (!isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const helperCfgs = withFilePath(cfgsOf(helper), 'helpers.ts');
    expect([...discoverProtoGuardCallees(cfgsOf(caller))]).not.toContain('isValidKey');
    expect([...discoverProtoGuardCallees(helperCfgs)]).toContain('isValidKey');
    const { flows } = analyze(caller, 0, { extraCfgs: helperCfgs });
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
    expect(flows.kills).toHaveLength(0);
  });

  it('does not kind-blind suppress namespace-imported proto-only helper', () => {
    const helper = `
      export function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
    `;
    const caller = `
      import * as guards from './helpers';
      function write(req: any) {
        if (!guards.isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const helperCfgs = withFilePath(cfgsOf(helper), 'helpers.ts');
    const repo = discoverProtoGuardRefs(helperCfgs);
    const excluded = resolveBarrierExclusions(
      cfgsOf(caller),
      importsFor(caller),
      repo,
      'fixture.ts',
    );
    expect([...excluded]).toContain('guards.isValidKey');
    expect([...excluded]).not.toContain('isValidKey');
    const { flows } = analyze(caller, 0, { extraCfgs: helperCfgs });
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
    expect(flows.kills).toHaveLength(0);
  });

  it('namespace proto exclusion does not disable a separate same-named validator', () => {
    const helper = `
      export function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
    `;
    const caller = `
      import * as guards from './helpers';
      function isValidKey(key: string) {
        return /^[a-z0-9._-]+$/i.test(key);
      }
      function write(req: any) {
        if (!isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const helperCfgs = withFilePath(cfgsOf(helper), 'helpers.ts');
    const { flows } = analyze(caller, 1, { extraCfgs: helperCfgs });
    expect(flows.findings).toHaveLength(0);
  });

  it('does not exclude via ambiguous same-basename modules', () => {
    const protoA = `
      export function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
    `;
    const protoB = `
      export function isValidKey(key: string) {
        return key !== "__proto__";
      }
    `;
    const caller = `
      import { isValidKey } from './helpers';
      function write(req: any) {
        if (!isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const repo = [
      ...discoverProtoGuardRefs(withFilePath(cfgsOf(protoA), 'a/helpers.ts')),
      ...discoverProtoGuardRefs(withFilePath(cfgsOf(protoB), 'b/helpers.ts')),
    ];
    const excluded = resolveBarrierExclusions(
      cfgsOf(caller),
      importsFor(caller),
      repo,
      'fixture.ts',
    );
    expect([...excluded]).not.toContain('isValidKey');
  });

  it('does not kind-blind suppress aliased import of a proto-only helper', () => {
    // Exclusion set has declared CFG name isValidKey; call site is isValidHostName.
    const helper = `
      export function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
    `;
    const caller = `
      import { isValidKey as isValidHostName } from './helpers';
      function write(req: any) {
        if (!isValidHostName(req.body)) return;
        exec(req.body);
      }
    `;
    const helperCfgs = withFilePath(cfgsOf(helper), 'helpers.ts');
    const repo = discoverProtoGuardRefs(helperCfgs);
    expect(repo.some((r) => r.name === 'isValidKey')).toBe(true);
    const excluded = [
      ...resolveBarrierExclusions(cfgsOf(caller), importsFor(caller), repo, 'fixture.ts'),
    ];
    expect(excluded).toContain('isValidHostName');
    expect(excluded).not.toContain('isValidKey');
    const { flows } = analyze(caller, 0, { extraCfgs: helperCfgs });
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
    expect(flows.kills).toHaveLength(0);
  });

  it('alias proto exclusion does not disable a separate same-named local validator', () => {
    const helper = `
      export function isValidKey(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }
    `;
    const caller = `
      import { isValidKey as protoKey } from './helpers';
      function isValidKey(key: string) {
        return /^[a-z0-9._-]+$/i.test(key);
      }
      function write(req: any) {
        if (!isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const helperCfgs = withFilePath(cfgsOf(helper), 'helpers.ts');
    const excluded = resolveBarrierExclusions(
      cfgsOf(caller),
      importsFor(caller),
      discoverProtoGuardRefs(helperCfgs),
      'fixture.ts',
    );
    expect([...excluded]).toContain('protoKey');
    expect([...excluded]).not.toContain('isValidKey');
    const { flows } = analyze(caller, 1, { extraCfgs: helperCfgs });
    expect(flows.findings).toHaveLength(0);
  });

  it('discovers member-assigned proto guards by property name', () => {
    const code = `
      const validators: any = {};
      validators.isValidKey = function helper(key: string) {
        return key !== "__proto__" && key !== "constructor";
      };
      function write(req: any) {
        if (!validators.isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const cfgs = cfgsOf(code);
    expect(cfgs.some((c) => c.functionName === 'isValidKey')).toBe(true);
    expect(cfgs.some((c) => c.functionName === 'helper')).toBe(false);
    expect([...discoverProtoGuardCallees(cfgs)]).toContain('isValidKey');
    const { flows } = analyze(
      code,
      cfgs.findIndex((c) => c.functionName === 'write'),
    );
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
    expect(flows.kills).toHaveLength(0);
  });

  it('decodes unicode escapes in computed member-assigned proto guards', () => {
    for (const prop of ['isValid\\u004bey', 'isValid\\u{4b}ey']) {
      const code = `
      const validators: any = {};
      validators["${prop}"] = function helper(key: string) {
        return key !== "__proto__" && key !== "constructor";
      };
      function write(req: any) {
        if (!validators.isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
      const cfgs = cfgsOf(code);
      expect(cfgs.some((c) => c.functionName === 'isValidKey')).toBe(true);
      expect(cfgs.some((c) => /u0?04b|u\{/i.test(c.functionName ?? ''))).toBe(false);
      const { flows } = analyze(
        code,
        cfgs.findIndex((c) => c.functionName === 'write'),
      );
      expect(flows.findings.length).toBeGreaterThanOrEqual(1);
      expect(flows.kills).toHaveLength(0);
    }
  });

  it('strips line continuations in computed member-assigned proto guards', () => {
    const code = `
      const validators: any = {};
      validators["isValid\\
Key"] = function helper(key: string) {
        return key !== "__proto__" && key !== "constructor";
      };
      function write(req: any) {
        if (!validators.isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const cfgs = cfgsOf(code);
    expect(cfgs.some((c) => c.functionName === 'isValidKey')).toBe(true);
    expect(cfgs.some((c) => (c.functionName ?? '').includes('\n'))).toBe(false);
    const { flows } = analyze(
      code,
      cfgs.findIndex((c) => c.functionName === 'write'),
    );
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
    expect(flows.kills).toHaveLength(0);
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

  it('discovers named function expressions by their outer binding name', () => {
    const code = `
      const isValidKey = function helper(key: string) {
        return key !== "__proto__" && key !== "constructor";
      };
      function write(req: any) {
        const key = req.body;
        if (!isValidKey(key)) return;
        exec(key);
      }
    `;
    const cfgs = cfgsOf(code);
    expect(cfgs.some((c) => c.functionName === 'isValidKey')).toBe(true);
    expect(cfgs.some((c) => c.functionName === 'helper')).toBe(false);
    expect([...discoverProtoGuardCallees(cfgs)]).toContain('isValidKey');
    // Excluded by bare call-site name — must not kind-blind suppress.
    const { flows } = analyze(code, 1);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('discovers string-keyed object-literal proto guards by property name', () => {
    const code = `
      const validators = {
        "isValidKey": function helper(key: string) {
          return key !== "__proto__" && key !== "constructor";
        },
      };
      function write(req: any) {
        if (!validators.isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const cfgs = cfgsOf(code);
    expect(cfgs.some((c) => c.functionName === 'isValidKey')).toBe(true);
    expect(cfgs.some((c) => c.functionName === 'helper')).toBe(false);
    expect([...discoverProtoGuardCallees(cfgs)]).toContain('isValidKey');
    const { flows } = analyze(
      code,
      cfgs.findIndex((c) => c.functionName === 'write'),
    );
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
    expect(flows.kills).toHaveLength(0);
  });

  it('discovers as-cast assigned proto guards by outer binding name', () => {
    const code = `
      type Validator = (key: string) => boolean;
      const isValidKey = (function helper(key: string) {
        return key !== "__proto__" && key !== "constructor";
      }) as Validator;
      function write(req: any) {
        if (!isValidKey(req.body)) return;
        exec(req.body);
      }
    `;
    const cfgs = cfgsOf(code);
    expect(cfgs.some((c) => c.functionName === 'isValidKey')).toBe(true);
    expect(cfgs.some((c) => c.functionName === 'helper')).toBe(false);
    expect([...discoverProtoGuardCallees(cfgs)]).toContain('isValidKey');
    const { flows } = analyze(
      code,
      cfgs.findIndex((c) => c.functionName === 'write'),
    );
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
    expect(flows.kills).toHaveLength(0);
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

  it('does not treat key.includes("__proto__") as a proto-reject guard', () => {
    // Acceptor polarity — true when the key IS __proto__.
    const cfgs = cfgsOf(`
      function isValidKey(key: string) {
        return key.includes("__proto__");
      }
    `);
    expect(functionContainsProtoGuard(cfgs[0])).toBe(false);
    expect([...discoverProtoGuardCallees(cfgs)]).not.toContain('isValidKey');
  });

  it('treats !key.includes("__proto__") as a proto-reject guard', () => {
    const cfgs = cfgsOf(`
      function isValidKey(key: string) {
        return !key.includes("__proto__") && !key.includes("constructor");
      }
    `);
    expect(functionContainsProtoGuard(cfgs[0])).toBe(true);
  });

  it('accepts if (key === "__proto__") throw as a proto-guard', () => {
    const cfgs = cfgsOf(`
      function isValidKey(key: string) {
        if (key === "__proto__") throw new Error();
        return true;
      }
    `);
    expect(functionContainsProtoGuard(cfgs[0])).toBe(true);
    expect([...discoverProtoGuardCallees(cfgs)]).toContain('isValidKey');
  });

  it('does not kind-blind suppress throw-style __proto__-only isValidKey', () => {
    const code = `
      function isValidKey(key: string) {
        if (key === "__proto__") throw new Error();
        return true;
      }
      function write(req: any) {
        const command = req.body;
        if (!isValidKey(command)) return;
        exec(command);
      }
    `;
    const { flows } = analyze(code, 1);
    expect(flows.findings.length).toBeGreaterThanOrEqual(1);
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
