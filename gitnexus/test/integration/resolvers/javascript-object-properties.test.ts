/**
 * A1/A5 — property access on a PLAIN OBJECT LITERAL must be answerable.
 *
 * Verified root cause: `Property` definition nodes are created only for
 * DECLARED CLASS FIELDS. Object-literal keys mint no node, so `ACCESSES` has
 * no target and "who reads/writes this config field?" returns a confident
 * zero. Capture and emission are already correct and language-neutral — a
 * `read`/`write` site maps to `ACCESSES` for any resolved target — so this is
 * purely definition-node coverage plus receiver resolution.
 *
 * Two receiver shapes, deliberately separated:
 *   - through the holding variable (`exitRules.exitMinAtrMult`) — the receiver
 *     is typeable, so this must resolve precisely.
 *   - through an untyped param (`cfg.exitMinAtrMult`) — the option-bag shape
 *     that dominates idiomatic JS. Not precisely solvable without types;
 *     covered by name-based fallback at reduced confidence.
 *
 * STATUS — not yet implemented; these are the acceptance criteria.
 *
 * Established so far:
 *   - A parse-query pattern scoped to object literals BOUND TO A VARIABLE
 *     (`(variable_declarator name: (identifier) value: (object (pair key:
 *     (property_identifier) @name) @definition.property))`) matches correctly:
 *     verified against the raw JAVASCRIPT_QUERIES, 4 captures on this fixture
 *     with the right names. It is NOT enough on its own — no `Property` node
 *     reaches the graph, and `local-symbol-pruner` is not the cause (it drops
 *     only Const/Variable/Static). The remaining gate is in the parse worker's
 *     node-creation path for `@definition.property` captures.
 *   - The two receiver shapes need different mechanisms. Through the holding
 *     variable the receiver is typeable and must resolve precisely. Through an
 *     untyped param it is not, and needs name-based matching — sanctioned for
 *     dynamic languages here (`fieldFallbackOnMethodLookup` defaults on, and
 *     the Vue provider documents it recovering plain-object-literal cases) but
 *     it must carry reduced confidence so precision is not overclaimed.
 */
import { describe, it, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('JavaScript plain-object property access (A1/A5)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-object-properties'),
      () => {},
    );
  }, 60000);

  it.todo('indexes object-literal keys as Property nodes');
  it.todo('emits ACCESSES for a read through the holding variable');
  it.todo('emits ACCESSES for the property WRITE (A5)');
  it.todo('emits ACCESSES for a read through an untyped param (option bag)');
});
