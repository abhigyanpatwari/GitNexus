// Go's filename rules include historical targets and the android/linux,
// ios/darwin and illumos/solaris aliases. Keep these tables aligned with
// https://go.dev/src/internal/syslist/syslist.go and go/build.matchTag.
const GOOS = new Set(
  'aix android darwin dragonfly freebsd hurd illumos ios js linux nacl netbsd openbsd plan9 solaris wasip1 windows zos'.split(
    ' ',
  ),
);
const GOARCH = new Set(
  '386 amd64 amd64p32 arm armbe arm64 arm64be loong64 mips mipsle mips64 mips64le mips64p32 mips64p32le ppc ppc64 ppc64le riscv riscv64 s390 s390x sparc sparc64 wasm'.split(
    ' ',
  ),
);
const UNIX = new Set(
  'aix android darwin dragonfly freebsd hurd illumos ios linux netbsd openbsd solaris'.split(' '),
);
const OS_ALIAS: Readonly<Record<string, string>> = {
  android: 'linux',
  ios: 'darwin',
  illumos: 'solaris',
};

type Term = ReadonlyMap<string, boolean>;
/** OR of AND terms; null means unknown, [] means unsatisfiable. */
export type GoBuildConstraint = readonly Term[] | null;
type Expr = string | { op: 'not'; value: Expr } | { op: 'and' | 'or'; left: Expr; right: Expr };
const MAX_TERMS = 64;
const MAX_TOKENS = 128;
const MAX_HEADER = 16384;
const TAG = /^[\p{L}\p{Nd}_.]+$/u;

function parseExpression(text: string): Expr | undefined {
  // Go's expression lexer skips only ASCII spaces/tabs, not all Unicode whitespace.
  const tokens = text.match(/&&|\|\||[!()]|[\p{L}\p{Nd}_.]+|[^ \t]/gu) ?? [];
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return undefined;
  let i = 0;
  const atom = (): Expr => {
    const token = tokens[i++];
    if (token === '!') {
      if (tokens[i] === '!') throw new Error('double negation not allowed');
      return { op: 'not', value: atom() };
    }
    if (token === '(') {
      const value = or();
      if (tokens[i++] !== ')') throw new Error('unclosed build constraint');
      return value;
    }
    if (!token || !TAG.test(token)) throw new Error('invalid build tag');
    return token;
  };
  const and = (): Expr => {
    let left = atom();
    while (tokens[i] === '&&') {
      i++;
      left = { op: 'and', left, right: atom() };
    }
    return left;
  };
  const or = (): Expr => {
    let left = and();
    while (tokens[i] === '||') {
      i++;
      left = { op: 'or', left, right: and() };
    }
    return left;
  };
  try {
    const result = or();
    return i === tokens.length ? result : undefined;
  } catch {
    return undefined;
  }
}

function mergeTerms(a: Term, b: Term): Term | undefined {
  const merged = new Map(a);
  for (const [tag, value] of b) {
    if (merged.has(tag) && merged.get(tag) !== value) return undefined;
    merged.set(tag, value);
  }
  return merged;
}

function conjunction(a: GoBuildConstraint, b: GoBuildConstraint): GoBuildConstraint {
  if (a === null || b === null || a.length * b.length > MAX_TERMS) return null;
  const terms: Term[] = [];
  for (const left of a)
    for (const right of b) {
      const merged = mergeTerms(left, right);
      if (merged) terms.push(merged);
    }
  return terms;
}

function toTerms(expr: Expr, negated = false): GoBuildConstraint {
  if (typeof expr === 'string') return [new Map([[expr, !negated]])];
  if (expr.op === 'not') return toTerms(expr.value, !negated);
  const left = toTerms(expr.left, negated);
  const right = toTerms(expr.right, negated);
  if ((expr.op === 'and') !== negated) return conjunction(left, right);
  if (left === null || right === null || left.length + right.length > MAX_TERMS) return null;
  return [...left, ...right];
}

/** Read only leading comments; a directive quoted inside a block is not active. */
function headerExpression(source: string): string | null {
  const header = source.slice(0, MAX_HEADER + 1);
  let modern: string | undefined;
  const legacy: string[] = [];
  let legacyEnd = 0;
  let ended = false;
  let inBlock = false;
  let offset = 0;
  // Bounded header scan, without splitting/copying an entire source file.
  while (offset < header.length && offset < MAX_HEADER) {
    const newline = header.indexOf('\n', offset);
    const end = newline === -1 ? header.length : newline;
    if (end > MAX_HEADER) return null;
    let line = header.slice(offset, end).trim();
    offset = end + 1;
    if (!line && !ended) legacyEnd = legacy.length;
    if (!line.startsWith('//')) ended = ended || line.length > 0;
    if (!inBlock && /^\/\/go:build(?:\s|$)/.test(line)) {
      if (modern !== undefined) return null;
      modern = line.slice('//go:build'.length).trim();
      if (!modern) return null;
    }
    if (!ended && /^\/\/\s*\+build(?:\s|$)/.test(line)) {
      legacy.push(line.replace(/^\/\/\s*\+build\s*/, ''));
    }
    while (line) {
      if (inBlock) {
        const close = line.indexOf('*/');
        if (close === -1) break;
        inBlock = false;
        line = line.slice(close + 2).trim();
      } else if (line.startsWith('/*')) {
        inBlock = true;
        line = line.slice(2);
      } else if (line.startsWith('//')) {
        break;
      } else {
        // Modern syntax takes precedence over legacy +build lines.
        if (modern !== undefined) return modern;
        const lines = legacy.slice(0, legacyEnd);
        if (
          lines.some(
            (text) =>
              !text || text.split(/[\s,]+/).some((tag) => !/^!?[\p{L}\p{Nd}_.]+$/u.test(tag)),
          )
        )
          return null;
        return lines
          .map(
            (text) =>
              `(${text
                .split(/\s+/)
                .map((term) => `(${term.split(',').join(' && ')})`)
                .join(' || ')})`,
          )
          .join(' && ');
      }
    }
  }
  return null;
}

/**
 * File eligibility for repository-wide structural analysis, not a host build.
 * Unknown/malformed or overly complex constraints remain possible, so they
 * cannot be used to prove that a competing owner is absent. Arbitrary tags
 * stay symbolic; OS/arch tags describe normal target configurations (not
 * user -tags overrides of reserved platform names). Feature/release tag
 * implications are deliberately over-approximated, never guessed.
 */
export function goFileBuildConstraint(
  filePath: string,
  source: string | undefined,
): GoBuildConstraint {
  const basename = (filePath.replace(/\\/g, '/').split('/').pop() ?? '').split('.')[0];
  const parts = basename.split('_');
  if (parts.at(-1) === 'test') parts.pop();
  const filename = new Map<string, boolean>();
  if (parts.length >= 2) {
    const last = parts.at(-1) ?? '';
    const previous = parts.at(-2) ?? '';
    if (GOOS.has(last) || GOARCH.has(last)) filename.set(last, true);
    if (parts.length >= 3 && GOARCH.has(last) && GOOS.has(previous)) filename.set(previous, true);
  }
  if (source === undefined) return null;
  const text = headerExpression(source);
  if (text === null) return null;
  if (!text) return [filename];
  const expr = parseExpression(text);
  return expr === undefined ? null : conjunction([filename], toTerms(expr));
}

function possibleTarget(term: Term): boolean {
  // The sentinel preserves possibilities for future targets. Only recognized
  // platform tags constrain an axis; unknown tags remain independent booleans.
  let operatingSystems = [...GOOS, ''];
  let architectures = [...GOARCH, ''];
  for (const [tag, value] of term) {
    if (GOOS.has(tag) || tag === 'unix') {
      operatingSystems = operatingSystems.filter(
        (os) => (os === tag || OS_ALIAS[os] === tag || (tag === 'unix' && UNIX.has(os))) === value,
      );
    } else if (GOARCH.has(tag)) {
      architectures = architectures.filter((arch) => (arch === tag) === value);
    }
  }
  return operatingSystems.length > 0 && architectures.length > 0;
}

export function goBuildConstraintsMayOverlap(a: GoBuildConstraint, b: GoBuildConstraint): boolean {
  if (a === null || b === null) return true;
  for (const left of a)
    for (const right of b) {
      const merged = mergeTerms(left, right);
      if (merged && possibleTarget(merged)) return true;
    }
  return false;
}
