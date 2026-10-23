import { describe, expect, it } from 'vitest';
import { cfgOf, parse } from '../../helpers/ts-cfg-harness.js';
import {
  computeGuardRefinements,
  createFunctionRefinement,
  type GuardFacts,
} from '../../../src/core/ingestion/taint/guard-refinement.js';

function fixture(body = 'if (!valid(x)) return; consume(x);') {
  const cfg = cfgOf(`function f(x: string) { ${body} }`);
  const subject = cfg.bindings!.findIndex((binding) => binding.name === 'x');
  const condition = cfg.blocks.find((block) => block.text.includes('valid(x)'))!.index;
  const sink = cfg.blocks.find((block) => block.text.includes('consume(x)'))!.index;
  const facts: GuardFacts = {
    eligible: true,
    primitiveBindings: [subject],
    predicates: [
      {
        block: condition,
        subject,
        accepts: false,
        restriction: { chars: 'abcdef0123456789', min: 7, max: 40 },
      },
    ],
  };
  return { cfg, subject, sink, facts };
}

describe('accepted-edge guard proof', () => {
  it('discards malformed optional call facts without breaking baseline analysis', () => {
    const cfg = cfgOf(
      'function f(x: string) { if (!/^[0-9a-f]{7,40}$/.test(x)) return; consume("git show " + x); }',
    );
    const malformed = {
      ...cfg,
      blocks: cfg.blocks.map((block) => ({
        ...block,
        statements: block.statements?.map((statement) => ({
          ...statement,
          ...(statement.refinement?.calls
            ? {
                refinement: {
                  ...statement.refinement,
                  calls: statement.refinement.calls.map((call) => ({ ...call, site: 9999 })),
                },
              }
            : {}),
        })),
      })),
    };
    const refinement = createFunctionRefinement(malformed);
    expect(refinement.argument(4, 0, 0, 0)).toBeUndefined();
    expect(refinement.isPredicate(2, 0, 0)).toBe(false);
    expect(
      createFunctionRefinement({ ...cfg, refinementSafe: undefined }).argument(4, 0, 0, 0),
    ).toBeUndefined();
  });
  it('charges large statement operand lists against the traversal budget', () => {
    const { cfg, facts } = fixture();
    const oversized = {
      ...cfg,
      blocks: cfg.blocks.map((block) => ({
        ...block,
        statements: block.statements?.map((statement) => ({
          ...statement,
          uses: Array(1000).fill(0),
        })),
      })),
    };
    const proof = computeGuardRefinements(oversized, facts, { maxVisits: 128 });
    expect(proof.status).toBe('fallback');
    expect(proof.visits).toBeLessThanOrEqual(129);
  });

  it.each(['if (!/^[0-9a-f]{7,40}$/.test(ref)) return;', 'if (ref !== "abcdef0") return;'])(
    'rejects a proof when an escaped spelling can hide a write: %s',
    (guard) => {
      const source =
        'function f(ref:string) {' +
        guard +
        String.raw` \u0072ef = input(); consume('git show ' + ref); }`;
      expect(parse(source).hasError).toBe(false);
      const cfg = cfgOf(source);
      expect(cfg.refinementSafe).toBe(false);
      expect(createFunctionRefinement(cfg).guards.status).toBe('fallback');
    },
  );

  it('certifies only uses dominated by the accepted edge', () => {
    const { cfg, facts, subject, sink } = fixture();
    const proof = computeGuardRefinements(cfg, facts);
    expect(proof.status).toBe('computed');
    expect(proof.at(subject, sink)?.min).toBe(7);
    expect(proof.at(subject, cfg.entryIndex)).toBeUndefined();
  });

  it('does not borrow validation from the rejected edge', () => {
    const { cfg, facts, subject, sink } = fixture('if (valid(x)) return; consume(x);');
    const predicates = facts.predicates.map((predicate) => ({ ...predicate, accepts: true }));
    expect(
      computeGuardRefinements(cfg, { ...facts, predicates }).at(subject, sink),
    ).toBeUndefined();
  });

  it('rejects a guard with a bypass path', () => {
    const { cfg, facts, subject, sink } = fixture(
      'if (flag) { if (!valid(x)) return; } consume(x);',
    );
    expect(computeGuardRefinements(cfg, facts).at(subject, sink)).toBeUndefined();
  });

  it('does not certify reassigned parameters or unknown primitive identity', () => {
    const { cfg, facts, subject, sink } = fixture(
      'if (!valid(x)) return; x = input(); consume(x);',
    );
    expect(computeGuardRefinements(cfg, facts).at(subject, sink)).toBeUndefined();
    expect(
      computeGuardRefinements(cfg, { ...facts, primitiveBindings: [] }).at(subject, sink),
    ).toBeUndefined();
  });

  it('retains no proof after a traversal budget failure or unsupported region', () => {
    const { cfg, facts, subject, sink } = fixture();
    const capped = computeGuardRefinements(cfg, facts, { maxVisits: 1 });
    expect(capped.status).toBe('fallback');
    expect(capped.at(subject, sink)).toBeUndefined();
    expect(
      computeGuardRefinements(cfg, { ...facts, eligible: false }).at(subject, sink),
    ).toBeUndefined();
  });
});
