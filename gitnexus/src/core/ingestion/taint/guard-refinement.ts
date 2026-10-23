import type { FunctionCfg } from '../cfg/types.js';
import {
  applyValueEffect,
  MAX_VALUE_BYTES,
  MAX_VALUE_NODES,
  UNKNOWN_VALUE,
  type StatementValueFacts,
  type StringRestriction,
  type ValueEffect,
  type ValueExpression,
} from './value-refinement.js';

const MAX_REFINEMENT_VISITS = 50_000;
const MAX_REFINEMENT_WORDS = 65_536;

/** Normalized worker facts. No AST, executable predicates or model callbacks. */
export interface GuardFacts {
  readonly eligible: boolean;
  readonly primitiveBindings: readonly number[];
  readonly predicates: readonly {
    readonly block: number;
    readonly subject: number;
    readonly accepts: boolean;
    readonly restriction: StringRestriction;
    readonly establishesPrimitive?: boolean;
  }[];
}

export interface GuardRefinements {
  readonly status: 'computed' | 'no-guard' | 'fallback';
  readonly visits: number;
  at(binding: number, block: number): StringRestriction | undefined;
}

export interface FunctionRefinement {
  readonly guards: GuardRefinements;
  argument(
    block: number,
    statement: number,
    site: number,
    argument: number,
    inputBinding?: number,
  ): ValueEffect | undefined;
  defaultShell(block: number, statement: number, site: number): boolean;
  isPredicate(block: number, statement: number, site: number): boolean;
}

/** Run/file-owned context shared by the two consumers; no AST or global cache. */
export function createFunctionRefinement(cfg: FunctionCfg): FunctionRefinement {
  if (cfg.refinementSafe !== true)
    return cfg.refinementSafe === false ? FALLBACK_REFINEMENT : NO_REFINEMENT;
  if (cfg.blocks.length + cfg.edges.length > MAX_REFINEMENT_WORDS) return FALLBACK_REFINEMENT;
  let scanVisits = 0;
  const predicates: GuardFacts['predicates'][number][] = [];
  const definitions = new Map<number, ValueExpression>();
  const written = new Set<number>();
  const calls = new Map<string, NonNullable<StatementValueFacts['calls']>[number]>();
  const predicateSites = new Set<string>();
  let factCount = 0;
  const validBinding = (binding: unknown): binding is number =>
    ++scanVisits <= MAX_REFINEMENT_VISITS &&
    Number.isInteger(binding) &&
    typeof binding === 'number' &&
    binding >= 0 &&
    binding < (cfg.bindings?.length ?? 0);
  const validExpression = (expression: ValueExpression): boolean => {
    let nodes = MAX_VALUE_NODES;
    let bytes = 0;
    const visit = (value: ValueExpression): boolean => {
      if (
        ++scanVisits > MAX_REFINEMENT_VISITS ||
        !value ||
        typeof value !== 'object' ||
        --nodes < 0
      )
        return false;
      if (value.kind === 'unknown' || value.kind === 'non-string') return true;
      if (value.kind === 'binding') return validBinding(value.binding);
      if (value.kind === 'literal') {
        if (typeof value.value !== 'string') return false;
        bytes += value.value.length;
        return bytes <= MAX_VALUE_BYTES;
      }
      return (
        value.kind === 'concat' &&
        Array.isArray(value.parts) &&
        value.parts.length <= MAX_VALUE_NODES &&
        value.parts.every(visit)
      );
    };
    return visit(expression);
  };
  if (
    cfg.primitiveBindings !== undefined &&
    (!Array.isArray(cfg.primitiveBindings) ||
      cfg.primitiveBindings.length > MAX_REFINEMENT_WORDS ||
      !cfg.primitiveBindings.every(validBinding))
  )
    return FALLBACK_REFINEMENT;
  for (const block of cfg.blocks)
    for (let index = 0; index < (block.statements?.length ?? 0); index++) {
      if (++scanVisits > MAX_REFINEMENT_VISITS) return FALLBACK_REFINEMENT;
      const statement = block.statements![index];
      if (
        !Array.isArray(statement.defs) ||
        (statement.mayDefs !== undefined && !Array.isArray(statement.mayDefs))
      )
        return FALLBACK_REFINEMENT;
      const shape = statement.refinement;
      if (
        shape !== undefined &&
        (!shape ||
          typeof shape !== 'object' ||
          (shape.definitions !== undefined &&
            (!Array.isArray(shape.definitions) || shape.definitions.length > 256)) ||
          (shape.calls !== undefined && (!Array.isArray(shape.calls) || shape.calls.length > 256)))
      )
        return FALLBACK_REFINEMENT;
      if (shape?.predicate) {
        const predicate = shape.predicate;
        if (
          !validBinding(predicate.subject) ||
          typeof predicate.accepts !== 'boolean' ||
          (predicate.establishesPrimitive !== undefined &&
            predicate.establishesPrimitive !== true) ||
          applyValueEffect(
            { kind: 'restrict', value: { kind: 'input' }, restriction: predicate.restriction },
            UNKNOWN_VALUE,
          ).kind !== 'string'
        )
          return FALLBACK_REFINEMENT;
        if (predicate.site !== undefined) {
          if (
            !Number.isInteger(predicate.site) ||
            statement.sites?.[predicate.site]?.kind !== 'call'
          )
            return FALLBACK_REFINEMENT;
          predicateSites.add(`${block.index}:${index}:${predicate.site}`);
        }
        if (predicates.length >= 64) return FALLBACK_REFINEMENT;
        predicates.push({ ...predicate, block: block.index });
      }
      for (const definition of shape?.definitions ?? []) {
        if (
          ++factCount > 256 ||
          !definition ||
          !validBinding(definition.binding) ||
          !validExpression(definition.value)
        )
          return FALLBACK_REFINEMENT;
        if (definitions.has(definition.binding)) written.add(definition.binding);
        else definitions.set(definition.binding, definition.value);
      }
      for (const bindings of [statement.defs, statement.mayDefs ?? []])
        for (const binding of bindings) {
          if (++scanVisits > MAX_REFINEMENT_VISITS) return FALLBACK_REFINEMENT;
          const entry = cfg.bindings?.[binding];
          if (
            entry?.kind === 'param'
              ? block.index !== cfg.entryIndex
              : entry?.kind !== 'const' || entry.declLine !== statement.line
          )
            written.add(binding);
        }
      for (const call of shape?.calls ?? []) {
        if (
          ++factCount > 256 ||
          !call ||
          !Number.isInteger(call.site) ||
          !statement.sites?.[call.site] ||
          !Array.isArray(call.arguments) ||
          call.arguments.length > MAX_VALUE_NODES ||
          !call.arguments.every(validExpression) ||
          (call.defaultShell !== undefined && typeof call.defaultShell !== 'boolean')
        )
          return FALLBACK_REFINEMENT;
        calls.set(`${block.index}:${index}:${call.site}`, call);
      }
    }
  const guards = computeGuardRefinements(cfg, {
    eligible: cfg.refinementSafe === true,
    primitiveBindings: cfg.primitiveBindings ?? [],
    predicates,
  });
  const active = cfg.refinementSafe === true && guards.status !== 'fallback';
  return {
    guards,
    defaultShell: (block, statement, site) =>
      active && calls.get(`${block}:${statement}:${site}`)?.defaultShell === true,
    isPredicate: (block, statement, site) =>
      active && predicateSites.has(`${block}:${statement}:${site}`),
    argument(block, statement, site, argument, inputBinding) {
      const expression = calls.get(`${block}:${statement}:${site}`)?.arguments[argument];
      if (!active || !expression) return;
      let remaining = MAX_VALUE_NODES;
      const seen = new Set<number>();
      let exhausted = false;
      const visit = (value: ValueExpression): ValueEffect => {
        if (--remaining < 0) {
          exhausted = true;
          return { kind: 'unknown' };
        }
        if (value.kind === 'literal' || value.kind === 'non-string' || value.kind === 'unknown')
          return value;
        if (value.kind === 'concat') return { kind: 'concat', parts: value.parts.map(visit) };
        if (value.kind !== 'binding') return { kind: 'unknown' };
        const binding = value.binding;
        if (written.has(binding) || seen.has(binding)) return { kind: 'unknown' };
        seen.add(binding);
        const definition = definitions.get(binding);
        const base: ValueEffect =
          binding === inputBinding
            ? { kind: 'input' }
            : definition
              ? visit(definition)
              : { kind: 'unknown' };
        seen.delete(binding);
        const restriction = guards.at(binding, block);
        return restriction ? { kind: 'restrict', value: base, restriction } : base;
      };
      const result = visit(expression);
      return exhausted ? undefined : result;
    },
  };
}

const NO_GUARDS: GuardRefinements = Object.freeze({
  status: 'no-guard',
  visits: 0,
  at: () => undefined,
});

const NO_REFINEMENT: FunctionRefinement = Object.freeze({
  guards: NO_GUARDS,
  argument: () => undefined,
  defaultShell: () => false,
  isPredicate: () => false,
});
const FALLBACK_REFINEMENT: FunctionRefinement = Object.freeze({
  ...NO_REFINEMENT,
  guards: { ...NO_GUARDS, status: 'fallback' as const },
});

export type RefinementSolver = (cfg: FunctionCfg) => FunctionRefinement;

export function createMemoizedRefinement(
  onCompute?: (result: FunctionRefinement) => void,
): RefinementSolver {
  const cache = new WeakMap<FunctionCfg, FunctionRefinement>();
  return (cfg) => {
    let result = cache.get(cfg);
    if (!result) {
      result = createFunctionRefinement(cfg);
      cache.set(cfg, result);
      onCompute?.(result);
    }
    return result;
  };
}

/** Removing an accepted edge must make the use unreachable from ENTRY. */
export function computeGuardRefinements(
  cfg: FunctionCfg,
  facts?: GuardFacts,
  limits?: { maxVisits?: number; maxGuards?: number; maxWords?: number },
): GuardRefinements {
  if (!facts?.predicates?.length) return NO_GUARDS;
  let visits = 0;
  const fallback = (): GuardRefinements => ({ status: 'fallback', visits, at: () => undefined });
  const maxVisits = limits?.maxVisits ?? MAX_REFINEMENT_VISITS;
  const maxGuards = limits?.maxGuards ?? 64;
  const maxWords = limits?.maxWords ?? MAX_REFINEMENT_WORDS;
  const count = cfg.blocks.length;
  if (
    facts.eligible !== true ||
    !Array.isArray(facts.predicates) ||
    !Array.isArray(facts.primitiveBindings) ||
    facts.predicates.length > maxGuards ||
    facts.primitiveBindings.length > maxWords ||
    count + cfg.edges.length > maxWords ||
    !Number.isInteger(cfg.entryIndex) ||
    cfg.entryIndex < 0 ||
    cfg.entryIndex >= count
  )
    return fallback();

  const successors: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < cfg.edges.length; i++) {
    const edge = cfg.edges[i];
    if (
      !Number.isInteger(edge.from) ||
      !Number.isInteger(edge.to) ||
      edge.from < 0 ||
      edge.from >= count ||
      edge.to < 0 ||
      edge.to >= count
    )
      return fallback();
    successors[edge.from].push(i);
  }
  const reachable = (removed = -1): Uint8Array | undefined => {
    const seen = new Uint8Array(count);
    const pending = [cfg.entryIndex];
    seen[cfg.entryIndex] = 1;
    while (pending.length) {
      if (++visits > maxVisits) return;
      const block = pending.pop()!;
      for (const index of successors[block]) {
        if (++visits > maxVisits) return;
        if (index === removed) continue;
        const to = cfg.edges[index].to;
        if (!seen[to]) {
          seen[to] = 1;
          pending.push(to);
        }
      }
    }
    return seen;
  };
  const original = reachable();
  if (!original) return fallback();
  const primitives = new Set(facts.primitiveBindings);
  const written = new Set<number>();
  const uses = new Map<number, Set<number>>();
  const subjects = new Set(facts.predicates.map((predicate) => predicate.subject));
  for (const block of cfg.blocks) {
    for (const statement of block.statements ?? []) {
      if (++visits > maxVisits) return fallback();
      if (
        !Array.isArray(statement.defs) ||
        !Array.isArray(statement.uses) ||
        (statement.mayDefs !== undefined && !Array.isArray(statement.mayDefs))
      )
        return fallback();
      for (const bindings of [statement.defs, statement.mayDefs ?? []])
        for (const binding of bindings) {
          if (++visits > maxVisits) return fallback();
          if (!subjects.has(binding)) continue;
          const declaration = cfg.bindings?.[binding];
          const isInitial =
            declaration?.kind === 'param'
              ? block.index === cfg.entryIndex
              : declaration?.kind === 'const' && statement.line === declaration.declLine;
          if (!isInitial) written.add(binding);
        }
      for (const binding of statement.uses) {
        if (++visits > maxVisits) return fallback();
        if (!subjects.has(binding)) continue;
        let blocks = uses.get(binding);
        if (!blocks) uses.set(binding, (blocks = new Set()));
        blocks.add(block.index);
      }
    }
  }
  const certificates = new Map<number, Map<number, StringRestriction>>();
  let words = count + cfg.edges.length;
  for (const predicate of facts.predicates) {
    if (
      !Number.isInteger(predicate.block) ||
      !Number.isInteger(predicate.subject) ||
      !original[predicate.block] ||
      !cfg.bindings?.[predicate.subject] ||
      written.has(predicate.subject) ||
      (!primitives.has(predicate.subject) && !predicate.establishesPrimitive)
    )
      continue;
    const checked = applyValueEffect(
      { kind: 'restrict', value: { kind: 'input' }, restriction: predicate.restriction },
      UNKNOWN_VALUE,
    );
    if (checked.kind !== 'string') continue;
    const edges = successors[predicate.block];
    // An unlabeled seq leg is the false fallthrough only alongside one true edge.
    const explicit = edges.filter(
      (index) => cfg.edges[index].kind === (predicate.accepts ? 'cond-true' : 'cond-false'),
    );
    const accepted =
      explicit.length === 1
        ? explicit[0]
        : !predicate.accepts &&
            explicit.length === 0 &&
            edges.length === 2 &&
            edges.some((index) => cfg.edges[index].kind === 'cond-true')
          ? edges.find((index) => cfg.edges[index].kind === 'seq')
          : undefined;
    if (accepted === undefined) continue;
    const bypass = reachable(accepted);
    if (!bypass) return fallback();
    for (const block of uses.get(predicate.subject) ?? []) {
      if (++visits > maxVisits || ++words > maxWords) return fallback();
      if (!original[block] || bypass[block]) continue;
      let points = certificates.get(predicate.subject);
      if (!points) certificates.set(predicate.subject, (points = new Map()));
      const previous = points.get(block);
      const restriction = predicate.restriction;
      if (!previous) points.set(block, restriction);
      else {
        const chars = [...new Set(previous.chars)]
          .filter((char) => restriction.chars.includes(char))
          .sort()
          .join('');
        const min = Math.max(previous.min, restriction.min);
        const max = Math.min(previous.max, restriction.max);
        if (chars && min <= max) points.set(block, { chars, min, max });
      }
    }
  }
  return {
    status: 'computed',
    visits,
    at: (binding, block) => certificates.get(binding)?.get(block),
  };
}
