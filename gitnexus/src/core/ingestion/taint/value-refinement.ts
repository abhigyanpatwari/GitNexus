/** A deliberately closed string domain. Unknown always preserves ordinary taint. */
export interface StringRestriction {
  readonly chars: string;
  readonly min: number;
  readonly max: number;
}

/** Small, provider-normalized expression vocabulary; absent shape stays unknown. */
export type ValueExpression =
  | { readonly kind: 'unknown' | 'non-string' }
  | { readonly kind: 'binding'; readonly binding: number }
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'concat'; readonly parts: readonly ValueExpression[] };

export interface StatementValueFacts {
  readonly predicate?: {
    readonly site?: number;
    readonly subject: number;
    readonly accepts: boolean;
    readonly restriction: StringRestriction;
    readonly establishesPrimitive?: boolean;
  };
  readonly definitions?: readonly { readonly binding: number; readonly value: ValueExpression }[];
  readonly calls?: readonly {
    readonly site: number;
    readonly arguments: readonly ValueExpression[];
    readonly defaultShell?: boolean;
  }[];
}

export type ValueEffect =
  | { readonly kind: 'unknown' | 'input' | 'non-string' }
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'concat'; readonly parts: readonly ValueEffect[] }
  | {
      readonly kind: 'restrict';
      readonly value: ValueEffect;
      readonly restriction: StringRestriction;
    };

export type RefinedValue =
  | { readonly kind: 'unknown' | 'non-string' }
  | { readonly kind: 'string'; readonly parts: readonly (string | StringRestriction)[] };

export const UNKNOWN_VALUE: RefinedValue = Object.freeze({ kind: 'unknown' });
export const MAX_VALUE_NODES = 32;
export const MAX_VALUE_BYTES = 256;

function validRestriction(value: StringRestriction): boolean {
  return (
    typeof value?.chars === 'string' &&
    value.chars.length > 0 &&
    value.chars.length <= 128 &&
    [...value.chars].every((c) => c.charCodeAt(0) < 128) &&
    Number.isInteger(value.min) &&
    Number.isInteger(value.max) &&
    value.min >= 0 &&
    value.max >= value.min &&
    value.max <= MAX_VALUE_BYTES
  );
}

/** Parse a linear, fully anchored ASCII subset; never execute a repository regex. */
export function parseAnchoredAsciiPattern(
  pattern: string,
  flags: string,
): StringRestriction | undefined {
  if (
    flags !== '' ||
    pattern.length > MAX_VALUE_BYTES ||
    !pattern.startsWith('^') ||
    !pattern.endsWith('$')
  )
    return;
  const body = pattern.slice(1, -1);
  let index = 0;
  let min = 0;
  let max = 0;
  const alphabet = new Set<string>();
  while (index < body.length) {
    const chars: string[] = [];
    if (body[index] === '[') {
      const end = body.indexOf(']', index + 1);
      if (end < 0) return;
      const raw = body.slice(index + 1, end);
      if (!raw || /[^A-Za-z0-9-]/.test(raw)) return;
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === '-') return;
        if (raw[i + 1] === '-') {
          const first = raw.charCodeAt(i);
          const last = raw.charCodeAt(i + 2);
          if (!Number.isFinite(last) || last < first || last - first > 127) return;
          for (let c = first; c <= last; c++) chars.push(String.fromCharCode(c));
          i += 2;
        } else chars.push(raw[i]);
      }
      index = end + 1;
    } else {
      const char = body[index++];
      if (!/[A-Za-z0-9]/.test(char)) return;
      chars.push(char);
    }
    let lo = 1;
    let hi = 1;
    if (body[index] === '{') {
      const end = body.indexOf('}', index);
      if (end < 0) return;
      const match = /^(\d{1,3})(?:,(\d{1,3}))?$/.exec(body.slice(index + 1, end));
      if (!match) return;
      lo = Number(match[1]);
      hi = Number(match[2] ?? match[1]);
      if (hi < lo || hi > MAX_VALUE_BYTES) return;
      index = end + 1;
    }
    min += lo;
    max += hi;
    if (max > MAX_VALUE_BYTES) return;
    for (const char of chars) alphabet.add(char);
  }
  if (alphabet.size === 0 || min === 0) return;
  return { chars: [...alphabet].sort().join(''), min, max };
}

/** A bounded transfer. Missing, malformed, oversized and incompatible effects are unknown. */
export function applyValueEffect(
  effect: ValueEffect | undefined,
  input: RefinedValue,
): RefinedValue {
  // A contradicted primitive contract must not revive at a later typed boundary.
  if (input.kind === 'non-string') return input;
  let remaining = MAX_VALUE_NODES;
  let exhausted = false;
  const visit = (node: ValueEffect | undefined): RefinedValue => {
    if (!node) return UNKNOWN_VALUE;
    if (--remaining < 0) {
      exhausted = true;
      return UNKNOWN_VALUE;
    }
    switch (node.kind) {
      case 'input':
        return input;
      case 'non-string':
        return { kind: 'non-string' };
      case 'unknown':
        return UNKNOWN_VALUE;
      case 'literal':
        return typeof node.value === 'string' && node.value.length <= MAX_VALUE_BYTES
          ? { kind: 'string', parts: [node.value] }
          : UNKNOWN_VALUE;
      case 'restrict': {
        if (!validRestriction(node.restriction)) return UNKNOWN_VALUE;
        const prior = visit(node.value);
        return prior.kind === 'non-string' ? prior : { kind: 'string', parts: [node.restriction] };
      }
      case 'concat': {
        if (!Array.isArray(node.parts) || node.parts.length > MAX_VALUE_NODES) return UNKNOWN_VALUE;
        const parts: (string | StringRestriction)[] = [];
        let bytes = 0;
        for (const part of node.parts) {
          const value = visit(part);
          if (value.kind !== 'string') return value;
          for (const segment of value.parts) {
            bytes += typeof segment === 'string' ? segment.length : segment.max;
            if (bytes > MAX_VALUE_BYTES || parts.length >= MAX_VALUE_NODES) return UNKNOWN_VALUE;
            if (typeof segment === 'string' && typeof parts.at(-1) === 'string') {
              parts[parts.length - 1] = String(parts.at(-1)) + segment;
            } else parts.push(segment);
          }
        }
        return { kind: 'string', parts };
      }
      default:
        return UNKNOWN_VALUE;
    }
  };
  const result = visit(effect);
  return exhausted ? UNKNOWN_VALUE : result;
}

/** Guarantees weaken across routes. Different shapes widen immediately (including recursion). */
export function joinRefinedValues(left: RefinedValue, right: RefinedValue): RefinedValue {
  if (left.kind === 'non-string') return left;
  if (right.kind === 'non-string') return right;
  if (left.kind !== 'string' || right.kind !== 'string') {
    return UNKNOWN_VALUE;
  }
  if (left.parts.length !== right.parts.length) return UNKNOWN_VALUE;
  const parts: (string | StringRestriction)[] = [];
  for (let i = 0; i < left.parts.length; i++) {
    const a = left.parts[i];
    const b = right.parts[i];
    if (typeof a === 'string' || typeof b === 'string') {
      if (a !== b) return UNKNOWN_VALUE;
      parts.push(a);
    } else {
      parts.push({
        chars: [...new Set(a.chars + b.chars)].sort().join(''),
        min: Math.min(a.min, b.min),
        max: Math.max(a.max, b.max),
      });
    }
  }
  return { kind: 'string', parts };
}

/** Operation/argument roles, not a blanket executable exemption. */
export function provesInertCommand(value: RefinedValue, prefixes: readonly string[]): boolean {
  if (value.kind !== 'string' || value.parts.length !== 2) return false;
  const [prefix, argument] = value.parts;
  return (
    typeof prefix === 'string' &&
    prefixes.includes(prefix) &&
    typeof argument !== 'string' &&
    validRestriction(argument) &&
    argument.min > 0 &&
    // ASCII letters/digits cannot introduce a shell operator, whitespace or option.
    /^[A-Za-z0-9]+$/.test(argument.chars)
  );
}

/** Canonical bounded identity, independent of JSON property insertion order. */
export function valueEffectKey(effect: ValueEffect | undefined): string {
  if (!effect) return '';
  let remaining = MAX_VALUE_NODES;
  const encode = (value: ValueEffect): unknown => {
    if (--remaining < 0) return '?';
    switch (value.kind) {
      case 'literal':
        return ['literal', value.value];
      case 'concat':
        return ['concat', ...value.parts.map(encode)];
      case 'restrict':
        return [
          'restrict',
          encode(value.value),
          [...new Set(value.restriction.chars)].sort().join(''),
          value.restriction.min,
          value.restriction.max,
        ];
      default:
        return [value.kind];
    }
  };
  return JSON.stringify(encode(effect));
}
