/**
 * C++ class template specialization matching and partial ordering
 * (ISO `[temp.class.spec.match]`, `[temp.class.order]`, issue #1896).
 *
 * Precedence:
 *   1. Explicit full specializations (`!typeParameters?.length`) whose
 *      normalized template arguments match `wantedArgs` win immediately.
 *   2. Candidate partial specializations (`typeParameters.length > 0`) unify
 *      their pattern arguments against `wantedArgs`; every declared template
 *      parameter must be bound consistently.
 *   3. Multiple matching partial specializations are ranked by `[temp.class.order]`:
 *      `A` is strictly more specialized than `B` iff `B`'s pattern unifies
 *      against skolemized `A` and `A`'s pattern does not unify against
 *      skolemized `B`. Incomparable or tied matches return `'ambiguous'` so
 *      the caller falls back to the primary template rather than guessing.
 */

import type { ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { bindsTypeParameter } from '../../scope-resolution/scope/walkers.js';

export type CvFlag = 'const' | 'volatile';

export type CppTypeTerm =
  | {
      readonly kind: 'pointer';
      readonly pointee: CppTypeTerm;
      readonly cv: ReadonlySet<CvFlag>;
    }
  | {
      readonly kind: 'lvalue-ref';
      readonly target: CppTypeTerm;
    }
  | {
      readonly kind: 'rvalue-ref';
      readonly target: CppTypeTerm;
    }
  | {
      readonly kind: 'array';
      readonly element: CppTypeTerm;
      readonly bound: string | null;
    }
  | {
      readonly kind: 'app';
      readonly name: string;
      readonly qualifier: string;
      readonly args: readonly CppTypeTerm[];
      readonly cv: ReadonlySet<CvFlag>;
    }
  | {
      readonly kind: 'named';
      readonly name: string;
      readonly qualifier: string;
      readonly cv: ReadonlySet<CvFlag>;
    };

const EMPTY_CV: ReadonlySet<CvFlag> = new Set();

const FUNDAMENTAL_ALIASES: Readonly<Record<string, string>> = {
  'signed int': 'int',
  signed: 'int',
  'unsigned int': 'unsigned',
  'short int': 'short',
  'signed short': 'short',
  'signed short int': 'short',
  'unsigned short int': 'unsigned short',
  'long int': 'long',
  'signed long': 'long',
  'signed long int': 'long',
  'unsigned long int': 'unsigned long',
  'long long int': 'long long',
  'signed long long': 'long long',
  'signed long long int': 'long long',
  'unsigned long long int': 'unsigned long long',
};

const VALID_SIMPLE_NAME_RE = /^[A-Za-z_]\w*$/;
const VALID_NONTYPE_LITERAL_RE = /^(?:true|false|-?(?:0x[0-9a-fA-F]+|\d+)[uUlL]*)$/;

const SQUEEZED_FUNDAMENTAL_NAMES: ReadonlySet<string> = new Set([
  'void',
  'bool',
  'char',
  'wchar_t',
  'char8_t',
  'char16_t',
  'char32_t',
  'short',
  'int',
  'long',
  'signed',
  'unsigned',
  'float',
  'double',
  'size_t',
  'ptrdiff_t',
  'nullptr_t',
]);

/**
 * Parse a C++ template-argument type/value spelling into a structured term.
 * Returns `null` for dependent member types (`typename T::U`), `decltype(...)`,
 * pack expansions (`Ts...`), function types, or malformed tokens.
 *
 * `knownParamNames` enables exact recovery of whitespace-squeezed declaration
 * tokens (`def.templateArguments` stores `'constT*'` for `S<const T*>`).
 */
export function parseCppTypeTerm(
  raw: string,
  knownParamNames?: ReadonlySet<string>,
): CppTypeTerm | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    trimmed.includes('...') ||
    /\b(?:typename|decltype)\b/.test(trimmed) ||
    hasTopLevelParens(trimmed)
  ) {
    return null;
  }
  return parseDeclaratorTerm(trimmed, knownParamNames);
}

function parseDeclaratorTerm(
  text: string,
  knownParamNames?: ReadonlySet<string>,
): CppTypeTerm | null {
  const s = text.trim();
  if (s.length === 0) return null;

  // References sit outermost in C++ declarators (`const T*&` is ref-to-pointer).
  if (s.endsWith('&&')) {
    const inner = parseDeclaratorTerm(s.slice(0, -2), knownParamNames);
    return inner === null ? null : { kind: 'rvalue-ref', target: inner };
  }
  if (s.endsWith('&')) {
    const inner = parseDeclaratorTerm(s.slice(0, -1), knownParamNames);
    return inner === null ? null : { kind: 'lvalue-ref', target: inner };
  }

  // Array declarator suffix (`T[N]` or `T[]`) outside angle brackets.
  if (s.endsWith(']')) {
    const openIdx = findMatchingOpenBracket(s, s.length - 1);
    if (openIdx <= 0) return null;
    const boundRaw = s.slice(openIdx + 1, -1).trim();
    const element = parseDeclaratorTerm(s.slice(0, openIdx), knownParamNames);
    if (element === null) return null;
    if (
      boundRaw.length > 0 &&
      !VALID_SIMPLE_NAME_RE.test(boundRaw) &&
      !VALID_NONTYPE_LITERAL_RE.test(boundRaw)
    ) {
      return null;
    }
    return { kind: 'array', element, bound: boundRaw.length > 0 ? boundRaw : null };
  }

  // Pointer layer: peel trailing cv-qualifiers belonging to a top-level `*`
  // (`int * const` -> pointer(cv={const}) to `int`; `const int *` -> pointer(cv={}) to `const int`).
  const peeledPtr = peelTrailingPointer(s);
  if (peeledPtr !== null) {
    const pointee = parseDeclaratorTerm(peeledPtr.rest, knownParamNames);
    return pointee === null ? null : { kind: 'pointer', pointee, cv: peeledPtr.cv };
  }

  return parseBaseTerm(s, knownParamNames);
}

function peelTrailingPointer(text: string): { rest: string; cv: ReadonlySet<CvFlag> } | null {
  let work = text.trim();
  const cv = new Set<CvFlag>();
  for (;;) {
    const m = /^(.*\S)\s+(const|volatile)$/.exec(work);
    // Also handle `int*const` with no space between `*` and `const`.
    const compact = m === null ? /^(.*\*)(const|volatile)$/.exec(work) : null;
    const hit = m ?? compact;
    if (hit === null) break;
    const prefix = hit[1].trim();
    if (!endsOutsideAngles(prefix)) break;
    cv.add(hit[2] as CvFlag);
    work = prefix;
  }
  if (!work.endsWith('*') || !endsOutsideAngles(work)) return null;
  const rest = work.slice(0, -1).trim();
  if (rest.length === 0) return null;
  return { rest, cv: cv.size === 0 ? EMPTY_CV : cv };
}

function parseBaseTerm(text: string, knownParamNames?: ReadonlySet<string>): CppTypeTerm | null {
  const { core, cv: baseCv } = extractTopLevelSpecifiers(text, knownParamNames);
  if (core.length === 0) return null;
  const cv = baseCv;

  const withoutLeadingScope = core.startsWith('::') ? core.slice(2).trim() : core;
  if (withoutLeadingScope.length === 0) return null;

  const { qualifier, tail } = splitTopLevelQualifier(withoutLeadingScope);
  const ltIdx = findTopLevelChar(tail, '<');
  if (ltIdx >= 0) {
    if (!tail.endsWith('>')) return null;
    const name = tail.slice(0, ltIdx).trim();
    if (!VALID_SIMPLE_NAME_RE.test(name)) return null;
    const argsRaw = splitTopLevelComma(tail.slice(ltIdx + 1, -1));
    if (argsRaw === null) return null;
    const args: CppTypeTerm[] = [];
    for (const argText of argsRaw) {
      if (argText.length === 0) continue;
      const parsed = parseCppTypeTerm(argText, knownParamNames);
      if (parsed === null) return null;
      args.push(parsed);
    }
    return { kind: 'app', name, qualifier, args, cv };
  }

  if (qualifier === '' && VALID_NONTYPE_LITERAL_RE.test(tail)) {
    return { kind: 'named', name: tail, qualifier: '', cv };
  }

  const normalizedMultiWord = tail.replace(/\s+/g, ' ').trim();
  const canonical = FUNDAMENTAL_ALIASES[normalizedMultiWord] ?? normalizedMultiWord;
  if (VALID_SIMPLE_NAME_RE.test(canonical)) {
    return { kind: 'named', name: canonical, qualifier, cv };
  }
  if (
    qualifier === '' &&
    /^(?:unsigned|signed|short|long)(?:\s+(?:unsigned|signed|short|long|int|char|double))+$/.test(
      canonical,
    )
  ) {
    return { kind: 'named', name: canonical, qualifier: '', cv };
  }
  return null;
}

function extractTopLevelSpecifiers(
  text: string,
  knownParamNames?: ReadonlySet<string>,
): {
  core: string;
  cv: ReadonlySet<CvFlag>;
} {
  // Tokenize top-level words outside `<...>` so qualifiers inside template
  // argument lists (`Box<const int>`) stay untouched.
  const cv = new Set<CvFlag>();
  const kept: string[] = [];
  let angleDepth = 0;
  let tokenStart = 0;

  const flush = (end: number): void => {
    const seg = text.slice(tokenStart, end).trim();
    if (seg.length === 0) return;
    if (seg === 'const' || seg === 'volatile') {
      cv.add(seg);
      return;
    }
    if (seg === 'struct' || seg === 'class' || seg === 'enum' || seg === 'union') {
      return;
    }
    kept.push(seg);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') {
      angleDepth++;
    } else if (ch === '>') {
      if (angleDepth > 0) angleDepth--;
    } else if (angleDepth === 0 && /\s/.test(ch)) {
      flush(i);
      tokenStart = i + 1;
    }
  }
  flush(text.length);

  // Recover squeezed cv prefixes/suffixes (`constT`, `constint`, `conststd::string`)
  // emitted by `scope-extractor`'s whitespace-squeezed `templateArguments`.
  let core = kept.join(' ').trim();
  if (!core.includes(' ')) {
    core = peelSqueezedCv(core, cv, knownParamNames);
  }

  return {
    core,
    cv: cv.size === 0 ? EMPTY_CV : cv,
  };
}

function peelSqueezedCv(
  token: string,
  cv: Set<CvFlag>,
  knownParamNames?: ReadonlySet<string>,
): string {
  let work = token;
  for (;;) {
    let changed = false;
    for (const kw of ['const', 'volatile'] as const) {
      if (work.startsWith(kw) && work.length > kw.length) {
        const rest = work.slice(kw.length);
        if (isPlausibleSqueezedTypeCore(rest, knownParamNames)) {
          cv.add(kw);
          work = rest;
          changed = true;
          break;
        }
      }
      if (work.endsWith(kw) && work.length > kw.length && !work.endsWith('>')) {
        const rest = work.slice(0, -kw.length);
        if (isPlausibleSqueezedTypeCore(rest, knownParamNames)) {
          cv.add(kw);
          work = rest;
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  return work;
}

function isPlausibleSqueezedTypeCore(
  candidate: string,
  knownParamNames?: ReadonlySet<string>,
): boolean {
  if (knownParamNames?.has(candidate) === true) return true;
  if (SQUEEZED_FUNDAMENTAL_NAMES.has(candidate)) return true;
  if (candidate.startsWith('::') || candidate.includes('::')) return true;
  const lt = candidate.indexOf('<');
  const head = lt > 0 ? candidate.slice(0, lt) : candidate;
  if (knownParamNames?.has(head) === true || SQUEEZED_FUNDAMENTAL_NAMES.has(head)) return true;
  // PascalCase user class/param (`constUser`, `constT`) vs snake_case (`constant` / `const_iterator`).
  return /^[A-Z]\w*$/.test(head);
}

function splitTopLevelQualifier(text: string): { qualifier: string; tail: string } {
  let angleDepth = 0;
  let lastSep = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') angleDepth++;
    else if (ch === '>' && angleDepth > 0) angleDepth--;
    else if (angleDepth === 0 && ch === ':' && text[i + 1] === ':') {
      lastSep = i;
      i++;
    }
  }
  if (lastSep < 0) return { qualifier: '', tail: text.trim() };
  return {
    qualifier: text.slice(0, lastSep).replace(/\s+/g, ''),
    tail: text.slice(lastSep + 2).trim(),
  };
}

function splitTopLevelComma(text: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<' || ch === '[' || ch === '(') depth++;
    else if (ch === '>' || ch === ']' || ch === ')') {
      depth--;
      if (depth < 0) return null;
    } else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

function findTopLevelChar(text: string, target: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === target && depth === 0) return i;
    if (ch === '<' || ch === '[' || ch === '(') depth++;
    else if (ch === '>' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
  }
  return -1;
}

function findMatchingOpenBracket(text: string, closeIdx: number): number {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    const ch = text[i];
    if (ch === ']') depth++;
    else if (ch === '[') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function endsOutsideAngles(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') depth++;
    else if (ch === '>' && depth > 0) depth--;
  }
  return depth === 0;
}

function hasTopLevelParens(text: string): boolean {
  let angleDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') angleDepth++;
    else if (ch === '>' && angleDepth > 0) angleDepth--;
    else if (angleDepth === 0 && (ch === '(' || ch === ')')) return true;
  }
  return false;
}

function formatCvPrefix(cv: ReadonlySet<CvFlag>): string {
  if (cv.size === 0) return '';
  const parts: string[] = [];
  if (cv.has('const')) parts.push('const');
  if (cv.has('volatile')) parts.push('volatile');
  return `${parts.join(' ')} `;
}

function formatCvSuffix(cv: ReadonlySet<CvFlag>): string {
  if (cv.size === 0) return '';
  const parts: string[] = [];
  if (cv.has('const')) parts.push('const');
  if (cv.has('volatile')) parts.push('volatile');
  return ` ${parts.join(' ')}`;
}

/** Deterministic canonical spelling of a parsed `CppTypeTerm`. */
export function canonicalCppTypeTerm(term: CppTypeTerm): string {
  switch (term.kind) {
    case 'named': {
      const q = term.qualifier.length > 0 ? `${term.qualifier}::` : '';
      return `${formatCvPrefix(term.cv)}${q}${term.name}`;
    }
    case 'app': {
      const q = term.qualifier.length > 0 ? `${term.qualifier}::` : '';
      const args = term.args.map(canonicalCppTypeTerm).join(', ');
      return `${formatCvPrefix(term.cv)}${q}${term.name}<${args}>`;
    }
    case 'pointer':
      return `${canonicalCppTypeTerm(term.pointee)}*${formatCvSuffix(term.cv)}`;
    case 'lvalue-ref':
      return `${canonicalCppTypeTerm(term.target)}&`;
    case 'rvalue-ref':
      return `${canonicalCppTypeTerm(term.target)}&&`;
    case 'array':
      return `${canonicalCppTypeTerm(term.element)}[${term.bound ?? ''}]`;
  }
}

function cvEqual(a: ReadonlySet<CvFlag>, b: ReadonlySet<CvFlag>): boolean {
  if (a.size !== b.size) return false;
  for (const flag of a) if (!b.has(flag)) return false;
  return true;
}

function cvSubset(sub: ReadonlySet<CvFlag>, sup: ReadonlySet<CvFlag>): boolean {
  for (const flag of sub) if (!sup.has(flag)) return false;
  return true;
}

function termTopLevelCv(term: CppTypeTerm): ReadonlySet<CvFlag> {
  if (term.kind === 'named' || term.kind === 'app' || term.kind === 'pointer') return term.cv;
  return EMPTY_CV;
}

function stripTermTopLevelCv(term: CppTypeTerm, toRemove: ReadonlySet<CvFlag>): CppTypeTerm {
  if (toRemove.size === 0) return term;
  if (term.kind !== 'named' && term.kind !== 'app' && term.kind !== 'pointer') return term;
  if (term.cv.size === 0) return term;
  const next = new Set<CvFlag>();
  for (const f of term.cv) if (!toRemove.has(f)) next.add(f);
  return { ...term, cv: next.size === 0 ? EMPTY_CV : next };
}

function qualifiersCompatible(q1: string, q2: string): boolean {
  if (q1 === q2) return true;
  // Treat `std::string` / `string` and `std::vector` / `vector` as compatible
  // across literal classification and `using namespace std` sites, while keeping
  // distinct user namespaces (`a::Box` vs `b::Box`) strictly separate.
  if ((q1 === 'std' && q2 === '') || (q1 === '' && q2 === 'std')) return true;
  return false;
}

function termsEqual(a: CppTypeTerm, b: CppTypeTerm): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'named':
      return (
        b.kind === 'named' &&
        a.name === b.name &&
        qualifiersCompatible(a.qualifier, b.qualifier) &&
        cvEqual(a.cv, b.cv)
      );
    case 'app':
      return (
        b.kind === 'app' &&
        a.name === b.name &&
        qualifiersCompatible(a.qualifier, b.qualifier) &&
        cvEqual(a.cv, b.cv) &&
        a.args.length === b.args.length &&
        a.args.every((arg, i) => termsEqual(arg, b.args[i]))
      );
    case 'pointer':
      return b.kind === 'pointer' && cvEqual(a.cv, b.cv) && termsEqual(a.pointee, b.pointee);
    case 'lvalue-ref':
      return b.kind === 'lvalue-ref' && termsEqual(a.target, b.target);
    case 'rvalue-ref':
      return b.kind === 'rvalue-ref' && termsEqual(a.target, b.target);
    case 'array':
      return b.kind === 'array' && a.bound === b.bound && termsEqual(a.element, b.element);
  }
}

export interface CppUnifyOptions {
  /**
   * Apply function-call `[temp.deduct.call]` top-level parameter/argument
   * adjustments (reference unwrap, cv qualification conversion on `const T&`,
   * top-level cv decay on by-value parameters). Leave `false` (default) for
   * class partial specialization matching (`[temp.class.spec.match]`), where
   * `S<int>` does NOT match `S<const T&>` or `S<const T>`.
   */
  readonly adjustCallParam?: boolean;
}

export function unifyCppTypePattern(
  patternRaw: string,
  argRaw: string,
  paramNames: ReadonlySet<string>,
  bindings: Map<string, CppTypeTerm>,
  options?: CppUnifyOptions,
): boolean {
  const pattern = parseCppTypeTerm(patternRaw, paramNames);
  const arg = parseCppTypeTerm(argRaw);
  if (pattern === null || arg === null) return false;
  return unifyTerms(pattern, arg, paramNames, bindings, options?.adjustCallParam === true, true);
}

function unifyTerms(
  pattern: CppTypeTerm,
  arg: CppTypeTerm,
  paramNames: ReadonlySet<string>,
  bindings: Map<string, CppTypeTerm>,
  adjustCallParam: boolean,
  isTopLevel: boolean,
): boolean {
  let p = pattern;
  let a = arg;

  if (adjustCallParam && isTopLevel) {
    // `[temp.deduct.call]/3`: unwrap argument reference before deduction.
    if (a.kind === 'lvalue-ref' || a.kind === 'rvalue-ref') a = a.target;

    if (p.kind === 'lvalue-ref' || p.kind === 'rvalue-ref') {
      const target = p.target;
      if (target.kind === 'named' && target.qualifier === '' && paramNames.has(target.name)) {
        // `const T&` / `T&` / `T&&`: qualification conversion allows binding a
        // non-const `int` to `const T&` with `T = int`; if `p` is non-const `T&`
        // and `a` is `const int`, `T` deduces to `const int`.
        const deduced = stripTermTopLevelCv(a, target.cv);
        return bindTemplateParam(target.name, deduced, bindings);
      }
      // `const std::vector<T>&` -> strip outer ref + top-level cv on `P` and `A`.
      p = stripTermTopLevelCv(target, termTopLevelCv(target));
      a = stripTermTopLevelCv(a, termTopLevelCv(a));
    } else {
      // By-value parameter (`void f(T)` / `Box(T)`): top-level cv decays on both `P` and `A`.
      p = stripTermTopLevelCv(p, termTopLevelCv(p));
      a = stripTermTopLevelCv(a, termTopLevelCv(a));
    }
  }

  // Template parameter leaf (`T`, `const T`, `volatile T`).
  if (p.kind === 'named' && p.qualifier === '' && paramNames.has(p.name)) {
    const argCv = termTopLevelCv(a);
    if (!cvSubset(p.cv, argCv)) return false;
    const deduced = stripTermTopLevelCv(a, p.cv);
    return bindTemplateParam(p.name, deduced, bindings);
  }

  if (p.kind !== a.kind) return false;

  switch (p.kind) {
    case 'named':
      return (
        a.kind === 'named' &&
        p.name === a.name &&
        qualifiersCompatible(p.qualifier, a.qualifier) &&
        cvEqual(p.cv, a.cv)
      );
    case 'pointer':
      return (
        a.kind === 'pointer' &&
        cvEqual(p.cv, a.cv) &&
        unifyTerms(p.pointee, a.pointee, paramNames, bindings, false, false)
      );
    case 'lvalue-ref':
      return (
        a.kind === 'lvalue-ref' &&
        unifyTerms(p.target, a.target, paramNames, bindings, false, false)
      );
    case 'rvalue-ref':
      return (
        a.kind === 'rvalue-ref' &&
        unifyTerms(p.target, a.target, paramNames, bindings, false, false)
      );
    case 'array': {
      if (a.kind !== 'array') return false;
      if (p.bound === null) {
        if (a.bound !== null) return false;
      } else {
        if (a.bound === null) return false;
        if (paramNames.has(p.bound)) {
          if (
            !bindTemplateParam(
              p.bound,
              { kind: 'named', name: a.bound, qualifier: '', cv: EMPTY_CV },
              bindings,
            )
          ) {
            return false;
          }
        } else if (p.bound !== a.bound) {
          return false;
        }
      }
      return unifyTerms(p.element, a.element, paramNames, bindings, false, false);
    }
    case 'app':
      return (
        a.kind === 'app' &&
        p.name === a.name &&
        qualifiersCompatible(p.qualifier, a.qualifier) &&
        cvEqual(p.cv, a.cv) &&
        p.args.length === a.args.length &&
        p.args.every((sub, idx) => unifyTerms(sub, a.args[idx], paramNames, bindings, false, false))
      );
  }
}

function bindTemplateParam(
  name: string,
  deduced: CppTypeTerm,
  bindings: Map<string, CppTypeTerm>,
): boolean {
  const existing = bindings.get(name);
  if (existing !== undefined) return termsEqual(existing, deduced);
  bindings.set(name, deduced);
  return true;
}

function substituteSkolems(
  term: CppTypeTerm,
  paramNames: ReadonlySet<string>,
  prefix: string,
): CppTypeTerm {
  switch (term.kind) {
    case 'named':
      if (term.qualifier === '' && paramNames.has(term.name)) {
        return { kind: 'named', name: `${prefix}${term.name}`, qualifier: '', cv: term.cv };
      }
      return term;
    case 'pointer':
      return {
        kind: 'pointer',
        pointee: substituteSkolems(term.pointee, paramNames, prefix),
        cv: term.cv,
      };
    case 'lvalue-ref':
      return {
        kind: 'lvalue-ref',
        target: substituteSkolems(term.target, paramNames, prefix),
      };
    case 'rvalue-ref':
      return {
        kind: 'rvalue-ref',
        target: substituteSkolems(term.target, paramNames, prefix),
      };
    case 'array': {
      const bound =
        term.bound !== null && paramNames.has(term.bound) ? `${prefix}${term.bound}` : term.bound;
      return {
        kind: 'array',
        element: substituteSkolems(term.element, paramNames, prefix),
        bound,
      };
    }
    case 'app':
      return {
        kind: 'app',
        name: term.name,
        qualifier: term.qualifier,
        cv: term.cv,
        args: term.args.map((arg) => substituteSkolems(arg, paramNames, prefix)),
      };
  }
}

function canUnifyTermSequence(
  patterns: readonly CppTypeTerm[],
  args: readonly CppTypeTerm[],
  paramNames: ReadonlySet<string>,
  adjustCallParam: boolean,
): boolean {
  if (patterns.length !== args.length) return false;
  const bindings = new Map<string, CppTypeTerm>();
  for (let i = 0; i < patterns.length; i++) {
    if (!unifyTerms(patterns[i], args[i], paramNames, bindings, adjustCallParam, true)) {
      return false;
    }
  }
  return bindings.size === paramNames.size;
}

/**
 * ISO `[temp.class.order]` / `[temp.func.order]`: `a` is strictly more
 * specialized than `b` iff `b` unifies against skolemized `a` and `a` does
 * NOT unify against skolemized `b`.
 */
export function isCppPatternMoreSpecialized(
  aPatterns: readonly string[],
  aParams: ReadonlySet<string>,
  bPatterns: readonly string[],
  bParams: ReadonlySet<string>,
  options?: CppUnifyOptions,
): boolean {
  if (aPatterns.length !== bPatterns.length) return false;
  const aTerms: CppTypeTerm[] = [];
  const bTerms: CppTypeTerm[] = [];
  for (let i = 0; i < aPatterns.length; i++) {
    const ta = parseCppTypeTerm(aPatterns[i], aParams);
    const tb = parseCppTypeTerm(bPatterns[i], bParams);
    if (ta === null || tb === null) return false;
    aTerms.push(ta);
    bTerms.push(tb);
  }
  const adjust = options?.adjustCallParam === true;
  const skolemA = aTerms.map((t) => substituteSkolems(t, aParams, '__gn_skolem_a_'));
  const skolemB = bTerms.map((t) => substituteSkolems(t, bParams, '__gn_skolem_b_'));
  const bMatchesA = canUnifyTermSequence(bTerms, skolemA, bParams, adjust);
  if (!bMatchesA) return false;
  const aMatchesB = canUnifyTermSequence(aTerms, skolemB, aParams, adjust);
  return !aMatchesB;
}

function termReferencesInScopeTypeParameter(
  term: CppTypeTerm,
  scopeId: ScopeId,
  scopes: ScopeResolutionIndexes,
): boolean {
  switch (term.kind) {
    case 'named':
      return term.qualifier === '' && bindsTypeParameter(scopeId, term.name, scopes);
    case 'pointer':
      return termReferencesInScopeTypeParameter(term.pointee, scopeId, scopes);
    case 'lvalue-ref':
    case 'rvalue-ref':
      return termReferencesInScopeTypeParameter(term.target, scopeId, scopes);
    case 'array':
      return (
        (term.bound !== null && bindsTypeParameter(scopeId, term.bound, scopes)) ||
        termReferencesInScopeTypeParameter(term.element, scopeId, scopes)
      );
    case 'app':
      return term.args.some((arg) => termReferencesInScopeTypeParameter(arg, scopeId, scopes));
  }
}

interface ParsedPartialSpec {
  readonly def: SymbolDefinition;
  readonly patterns: readonly CppTypeTerm[];
  readonly rawPatterns: readonly string[];
  readonly paramNames: ReadonlySet<string>;
}

/**
 * `ScopeResolver.matchTemplateSpecializations` implementation for C++.
 */
export function matchCppTemplateSpecializations(
  candidates: readonly SymbolDefinition[],
  wantedArgs: readonly string[],
  context: { readonly scopeId: ScopeId; readonly scopes: ScopeResolutionIndexes },
): readonly SymbolDefinition[] | 'ambiguous' {
  if (candidates.length === 0 || wantedArgs.length === 0) return [];

  const parsedWanted: CppTypeTerm[] = [];
  for (const raw of wantedArgs) {
    const parsed = parseCppTypeTerm(raw);
    if (parsed === null) return [];
    if (termReferencesInScopeTypeParameter(parsed, context.scopeId, context.scopes)) {
      // Dependent instantiation inside an enclosing template body (`S<T*>`):
      // actual specialization is unknown until instantiation (`[temp.dep.type]`).
      return [];
    }
    parsedWanted.push(parsed);
  }

  // 1. Explicit full specializations (`template<> struct S<int*>`) take precedence.
  const explicitMatches: SymbolDefinition[] = [];
  const partialCandidates: ParsedPartialSpec[] = [];

  for (const def of candidates) {
    const defArgs = def.templateArguments;
    if (defArgs === undefined || defArgs.length !== parsedWanted.length) continue;

    const typeParams = def.typeParameters;
    if (typeParams === undefined || typeParams.length === 0) {
      let ok = true;
      for (let i = 0; i < defArgs.length; i++) {
        const dt = parseCppTypeTerm(defArgs[i]);
        if (dt === null || !termsEqual(dt, parsedWanted[i])) {
          ok = false;
          break;
        }
      }
      if (ok) explicitMatches.push(def);
      continue;
    }

    const paramSet = new Set(typeParams.map((p) => p.name));
    const patterns: CppTypeTerm[] = [];
    let allParsed = true;
    for (const rawPat of defArgs) {
      const pt = parseCppTypeTerm(rawPat, paramSet);
      if (pt === null) {
        allParsed = false;
        break;
      }
      patterns.push(pt);
    }
    if (!allParsed) continue;
    partialCandidates.push({
      def,
      patterns,
      rawPatterns: defArgs,
      paramNames: paramSet,
    });
  }

  // Deduplicate same-specialization redeclarations by nodeId.
  const uniqueExplicit = [...new Map(explicitMatches.map((d) => [d.nodeId, d])).values()];
  if (uniqueExplicit.length === 1) return uniqueExplicit;
  if (uniqueExplicit.length > 1) return 'ambiguous';

  // 2. Partial specializations: unify pattern against concrete `parsedWanted`.
  const matchingPartials: ParsedPartialSpec[] = [];
  const seenPartialIds = new Set<string>();
  for (const spec of partialCandidates) {
    if (seenPartialIds.has(spec.def.nodeId)) continue;
    if (canUnifyTermSequence(spec.patterns, parsedWanted, spec.paramNames, false)) {
      seenPartialIds.add(spec.def.nodeId);
      matchingPartials.push(spec);
    }
  }

  if (matchingPartials.length === 0) return [];
  if (matchingPartials.length === 1) return [matchingPartials[0].def];

  // 3. Partial ordering (`[temp.class.order]`): accept only a unique partial
  // specialization that is strictly more specialized than every other match.
  const undominated = matchingPartials.filter(
    (candidate) =>
      !matchingPartials.some(
        (other) =>
          other !== candidate &&
          isCppPatternMoreSpecialized(
            other.rawPatterns,
            other.paramNames,
            candidate.rawPatterns,
            candidate.paramNames,
          ),
      ),
  );

  if (undominated.length !== 1) return 'ambiguous';
  const winner = undominated[0];
  const dominatesAll = matchingPartials.every(
    (other) =>
      other === winner ||
      isCppPatternMoreSpecialized(
        winner.rawPatterns,
        winner.paramNames,
        other.rawPatterns,
        other.paramNames,
      ),
  );
  return dominatesAll ? [winner.def] : 'ambiguous';
}
