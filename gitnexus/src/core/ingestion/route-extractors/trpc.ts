import type { ExtractedRoute } from './laravel.js';

const HTTP_METHOD_MAP: Record<string, string> = {
  query: 'GET',
  mutation: 'POST',
  subscription: 'WS',
};

// Shared by the file gate and the line scanner. A tRPC terminal is
// `.query(` / `.mutation(` / `.subscription(` only after a Procedure
// builder (`publicProcedure`, `t.procedure`) or at the start of a
// line (prettier-broken chain). `db.query(` / `obj.query(` must not
// match. Chained `.input(...).query(` is accepted in the scanner when
// parenDepth is back at the procedure key (the input parens closed).
// The `/m` flag lets the file gate see a line-start `.query(` in
// whole-file text.
const TERMINAL_CALL_RE =
  /(?:(?<=Procedure)|(?<=\bprocedure)|^)\s*\.\s*(query|mutation|subscription)\s*\(/m;

// Procedure keys may sit at the start of an indented line, or mid-line after
// `{` / `,` in a compact router (`t.router({ health: publicProcedure.query(...) })`).
// Quoted keys (`'create'` / `"admin-panel"`) are the same procedure name as the
// unquoted identifier. Unquoted stays `\w+`; quoted allows hyphens and similar
// identifier-like punctuation (`$`, `.`). Dual groups: name = m[1] || m[3].
// `procedure` is the official `const procedure = t.procedure` alias (also the
// HOC-pair shape in the TS/JS queries); it is not covered by `\w*Procedure`.
const PROCEDURE_KEY_RE =
  /(?:^|[{,])\s*(?:['"]([\w$.-]+)['"]|((\w+)))\s*:\s*(\w*Procedure|t\.procedure|procedure)\b/;

/** Normalize slashes and prefix `/` so a repo-root `routers/foo.ts` matches `/routers/`. */
export function shouldScanForTrpcRoutes(filePath: string): boolean {
  let p = filePath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return p.includes('/routers/') || p.includes('/trpc/') || p.includes('/server/');
}

function hasTrpcTerminalKeyword(content: string): boolean {
  return (
    content.includes('query') || content.includes('mutation') || content.includes('subscription')
  );
}

function prefixFromBinding(
  masked: string,
  content: string,
  filePath: string,
  binding: RegExpMatchArray | null,
): string | null {
  // Comments / string literals must not supply a prefix (`// const fooRouter =`
  // or a `.merge('post.'` inside a string). maskNonCode preserves length, so a
  // hit on the mask can be re-read from the original for quoted merge text.

  // Prefer the exported *Router binding; otherwise the first const/let/var.
  // A file-wide first `.merge('post.', …)` used to prefix every procedure,
  // including a later `export const appRouter = t.router({ health })`.
  if (binding) {
    const rhsStart = binding.index + binding[0].length;
    const rhsMasked = masked.slice(rhsStart);

    // Only `t.merge` / `trpc.merge` / `tRPC.merge` / `*Router.merge` on THIS
    // binding is a tRPC prefix. `defaults.merge('internal', …)` is lodash-style
    // and cannot match here; a preceding `t.merge('post.', postRouter)` is
    // ignored when this binding is `t.router` / `createTRPCRouter` / `router(`.
    if (/^(?:t|trpc|tRPC|\w+Router)\s*\.\s*merge\s*\(/.test(rhsMasked)) {
      const mergeMatch = content
        .slice(rhsStart)
        .match(/\.merge\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*,/);
      if (mergeMatch) {
        // A '.merge('post.', ...)' prefix composes the route-path key; a stray
        // leading/trailing dot would double up when we join ('post..list') —
        // strip both edges and treat an all-dot prefix as no prefix.
        const merged = (mergeMatch[1] ?? mergeMatch[2] ?? '').replace(/^\.+|\.+$/g, '');
        return merged.length > 0 ? merged : null;
      }
    }

    if (/^(?:createTRPCRouter|\w+\s*\.\s*router|router)\s*\(/.test(rhsMasked)) {
      // `appRouter` / `rootRouter` is the root binding, not a nest key.
      // Live tRPC paths are `admin.users.list`, not `app.admin.users.list`.
      // Do not fall through to the filename prefix — this file is the root composer.
      const base = binding[1].replace(/Router$/i, '');
      if (/^(app|root)$/i.test(base)) return null;
      return base;
    }
  }

  const fileName =
    filePath
      .split('/')
      .pop()
      ?.replace(/\.(ts|tsx|js|jsx)$/, '') ?? '';
  if (fileName && fileName !== 'index' && fileName !== 'root') return fileName;

  return null;
}

// Allowlist, not the previous broad w*Procedure wildcard: /\b\w*Procedure\w*\b/
// also matched unrelated identifiers (ProcedureBuilder, a local
// procedureFactory...), letting files that merely REFERENCE procedures pass
// the gate and emit phantom routes. Every real v9-v11 router imports one of
// these exact names.
function isTrpcRouterFileMasked(masked: string): boolean {
  // Markers and cheap-checks run on the mask: a comment/string `@trpc/server`
  // or `initTRPC` must not open the file for an unrelated `fooProcedure.query`.
  // Real routers keep unquoted identifiers (`initTRPC`, `publicProcedure`).
  // Cheap reject before the terminal regex: every live procedure still
  // contains one of these identifiers. Whitespace between `.` and the
  // name is allowed by TERMINAL_CALL_RE, so we do not require a literal `.query`.
  if (
    !masked.includes('query') &&
    !masked.includes('mutation') &&
    !masked.includes('subscription')
  ) {
    return false;
  }
  if (!TERMINAL_CALL_RE.test(masked)) {
    // Compact `.input(...).mutation(` is not Procedure-adjacent or
    // line-start; the scanner binds it via parenDepth.
    if (!/\.\s*(?:query|mutation|subscription)\s*\(/.test(masked)) {
      return false;
    }
  }
  return (
    /initTRPC|createTRPCRouter|createTRPCProxyClient|createTRPCNext|@trpc\//.test(masked) ||
    /\b(?:public|protected|private)Procedure\b/.test(masked)
  );
}

/**
 * Brace-depth scanner state shared across the lines of one file. Tracks block
 * comments and string/template literals so braces inside them never skew the
 * depth counter — a skewed counter would mis-nest (or never pop) the router
 * stack below and corrupt the emitted procedure paths.
 */
interface ScanState {
  inString: string | null;
  inBlockComment: boolean;
  /** Last non-whitespace code char — distinguishes `/regex/` from `a / b`. */
  prevSignificant: string | null;
  /**
   * Last identifier token. Persists across whitespace, comments, and newlines
   * (`return\n  /}/`) so a keyword that introduces an expression can start a
   * regex. Cleared by any other significant token (`return 1 / 2` stays division).
   */
  lastIdentifier: string | null;
  /** `(` ++ / `)` -- in this masker; never below 0. */
  parenDepth: number;
  /**
   * Paren depth of a control keyword's opening `(` (`if` / `while` / …),
   * remembered until that condition's `)` closes.
   */
  controlConditionDepth: number | null;
  /**
   * After a control-condition `)`, the next `/` is a regex — until another
   * significant non-`/` token. `(a + b) / c` and `foo(ok) / x` stay division.
   */
  regexAfterControlClose: boolean;
}

/** Keywords that introduce an expression/statement, so the next `/` is a regex. */
const REGEX_AFTER_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'else',
  'new',
  'delete',
  'void',
  'typeof',
  'yield',
  'await',
  'in',
  'of',
  'instanceof',
]);

/** Control keywords whose parenthesized condition makes the following `/` a regex. */
const CONTROL_CONDITION_KEYWORDS = new Set(['if', 'while', 'for', 'catch', 'switch', 'with']);

function createScanState(): ScanState {
  return {
    inString: null,
    inBlockComment: false,
    prevSignificant: null,
    lastIdentifier: null,
    parenDepth: 0,
    controlConditionDepth: null,
    regexAfterControlClose: false,
  };
}

/** `/` starts a regex unless the previous significant char ends a primary (`a / b`). */
function previousAllowsDivision(state: ScanState): boolean {
  if (state.regexAfterControlClose) {
    return false;
  }
  if (state.lastIdentifier !== null && REGEX_AFTER_KEYWORDS.has(state.lastIdentifier)) {
    return false;
  }
  const prev = state.prevSignificant;
  if (prev === null) return false;
  // Identifier / number, call/index close, or a just-closed string/template.
  return /[\w$)\]]/.test(prev) || prev === "'" || prev === '"' || prev === '\u0060';
}

/**
 * Blank one `/pattern/flags` literal (length-preserving). `start` is the
 * opening `/`. Character classes keep `/` from ending the pattern.
 */
function maskRegexLiteral(line: string, out: string[], start: number): number {
  out[start] = ' ';
  let i = start + 1;
  let inClass = false;
  while (i < line.length) {
    const c = line[i];
    out[i] = ' ';
    if (c === '\\') {
      if (i + 1 < line.length) out[i + 1] = ' ';
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      i++;
      continue;
    }
    if (c === '[') {
      inClass = true;
      i++;
      continue;
    }
    if (c === '/') {
      i++;
      while (i < line.length && /[a-zA-Z]/.test(line[i])) {
        out[i] = ' ';
        i++;
      }
      return i;
    }
    i++;
  }
  return i;
}

/**
 * Replace comments, string/template literals, and regex literals with spaces
 * so a regex can see only real code. `{` / `}` inside `/}/` must not move
 * brace depth. Updates `state` so the next line (and `maskSource`) inherit
 * the live comment/string machine and the last significant code char.
 */
function maskNonCode(line: string, state: ScanState): string {
  const out = line.split('');
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    if (state.inString !== null) {
      out[i] = ' ';
      if (ch === '\\') {
        if (i + 1 < line.length) out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (ch === state.inString) {
        state.inString = null;
        state.prevSignificant = ch;
      }
      i++;
      continue;
    }
    if (state.inBlockComment) {
      out[i] = ' ';
      if (ch === '*' && next === '/') {
        if (i + 1 < line.length) out[i + 1] = ' ';
        state.inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < line.length) {
        out[i] = ' ';
        i++;
      }
      return out.join('');
    }
    if (ch === '/' && next === '*') {
      out[i] = ' ';
      if (i + 1 < line.length) out[i + 1] = ' ';
      state.inBlockComment = true;
      i += 2;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      let ident = '';
      while (j < line.length && /[\w$]/.test(line[j])) {
        ident += line[j];
        j++;
      }
      // Property names (`foo.return / x`) are not keyword introducers.
      state.lastIdentifier = state.prevSignificant === '.' ? null : ident;
      state.prevSignificant = ident.charAt(ident.length - 1);
      state.regexAfterControlClose = false;
      i = j;
      continue;
    }
    if (ch === '/' && !previousAllowsDivision(state)) {
      i = maskRegexLiteral(line, out, i);
      state.prevSignificant = '/';
      state.lastIdentifier = null;
      state.regexAfterControlClose = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '\u0060') {
      // Keep `'create':` / `"admin-panel":` visible so PROCEDURE_KEY_RE and
      // ROUTER_OPEN_RE can see quoted keys after the mask. A real string
      // (no `ident` + matching quote + colon) is still blanked.
      if (ch !== '\u0060') {
        const quotedKey = line.slice(i).match(/^(['"])([\w$.-]+)\1\s*:/);
        if (quotedKey) {
          i += quotedKey[0].length;
          state.prevSignificant = ':';
          state.lastIdentifier = null;
          state.regexAfterControlClose = false;
          continue;
        }
      }
      out[i] = ' ';
      state.inString = ch;
      state.lastIdentifier = null;
      state.regexAfterControlClose = false;
      i++;
      continue;
    }
    if (ch === '(') {
      state.parenDepth++;
      if (state.lastIdentifier !== null && CONTROL_CONDITION_KEYWORDS.has(state.lastIdentifier)) {
        state.controlConditionDepth = state.parenDepth;
      }
      state.prevSignificant = '(';
      state.lastIdentifier = null;
      state.regexAfterControlClose = false;
      i++;
      continue;
    }
    if (ch === ')') {
      if (
        state.controlConditionDepth !== null &&
        state.parenDepth === state.controlConditionDepth
      ) {
        state.regexAfterControlClose = true;
        state.controlConditionDepth = null;
      } else {
        state.regexAfterControlClose = false;
      }
      if (state.parenDepth > 0) state.parenDepth--;
      state.prevSignificant = ')';
      state.lastIdentifier = null;
      i++;
      continue;
    }
    if (!/\s/.test(ch)) {
      state.prevSignificant = ch;
      state.lastIdentifier = null;
      state.regexAfterControlClose = false;
    }
    i++;
  }
  return out.join('');
}

/** Whole-file mask. Length-preserving so indices align with `content`. */
function maskSource(content: string): string {
  const state = createScanState();
  return content
    .split('\n')
    .map((line) => maskNonCode(line, state))
    .join('\n');
}

/**
 * A nested router literal ('admin: adminProcedure.router({ ... })'). openDepth
 * is the brace depth INSIDE the router's object literal, so the frame pops as
 * soon as depth drops back below it (i.e. at the router's closing brace).
 */
interface NestFrame {
  name: string;
  openDepth: number;
  /** `(` depth of the `router(` that opened this nest. */
  parenDepth: number;
}

// Router open: 'name: t.router(', 'name: trpc.router(',
// 'name: createTRPCRouter(', 'name: someProcedure.router(', and the bare
// 'name: router(' style ('import { router } from "../trpc"' re-exports are
// common in v11 codebases). Same `(?:^|[{,])` prefix as PROCEDURE_KEY_RE so a
// compact `admin: t.router({ list: ...})` mid-line still pushes nestStack.
// The object-literal body opens at the first '{' scanned after the match
// (almost always on the same line).
const ROUTER_OPEN_RE =
  /(?:^|[{,])\s*(?:['"]([\w$.-]+)['"]|((\w+)))\s*:\s*(?:(?:t|trpc|tRPC)\s*\.\s*router|createTRPCRouter|\w+Procedure\s*\.\s*router|router)\s*\(/;

// Same-file `const adminRouter = t.router({` / `createTRPCRouter(` / bare `router(`.
const ROUTER_BINDING_RE =
  /(?:export\s+)?(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(?:(?:t|trpc|tRPC)\s*\.\s*router|createTRPCRouter|router)\s*\(/;

// Identifier composition: `admin: adminRouter,` / last-property `admin: adminRouter`.
// Optional `as` / `satisfies` tail (`admin: adminRouter as const`) still mounts.
// `list: publicProcedure.query(` does not match — the next token is `.`.
const ROUTER_REF_RE =
  /(?:^|[{,])\s*(?:['"]([\w$.-]+)['"]|((\w+)))\s*:\s*([A-Za-z_$][\w$]*)\s*(?:(?:as|satisfies)\b[^,}]*)?(?:[,}]|$)/;

// `export const appRouter = t.merge('post.', postRouter)` — the merge string
// is the file prefix; this records a zero-hop mount so postRouter procedures
// are not dropped as unmounted.
const MERGE_ROUTER_REF_RE =
  /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:t|trpc|tRPC|\w+Router)\s*\.\s*merge\s*\([^,]+,\s*([A-Za-z_$][\w$]*)\s*\)/;

// `/g` copies for matchAll. The non-global originals stay lastIndex-safe for `.test()`.
const TERMINAL_CALL_RE_G = new RegExp(TERMINAL_CALL_RE.source, 'gm');
const PROCEDURE_KEY_RE_G = new RegExp(PROCEDURE_KEY_RE.source, 'g');
const ROUTER_OPEN_RE_G = new RegExp(ROUTER_OPEN_RE.source, 'g');
const ROUTER_BINDING_RE_G = new RegExp(ROUTER_BINDING_RE.source, 'g');
const ROUTER_REF_RE_G = new RegExp(ROUTER_REF_RE.source, 'g');
const MERGE_ROUTER_REF_RE_G = new RegExp(MERGE_ROUTER_REF_RE.source, 'g');
// Every `.query(` / `.mutation(` / `.subscription(` — the scanner emits
// only at the procedure's parenDepth, and only when TERMINAL_CALL_RE
// matched or the previous non-space is `)` (chained `.input(...).query(`).
const ANY_TERMINAL_RE_G = /\.\s*(query|mutation|subscription)\s*\(/g;

function matchAll(re: RegExp, text: string): RegExpMatchArray[] {
  re.lastIndex = 0;
  return [...text.matchAll(re)];
}

function findPrefixRouterBinding(masked: string): RegExpMatchArray | null {
  // Prefer the live composer (`appRouter` / `rootRouter`) when this file both
  // defines a leaf `export const postRouter` and remounts it on `appRouter`.
  // Falling through to the first exported *Router would treat that leaf as
  // root and drop the remount key (`blog: postRouter` → `/trpc/post.list`).
  const composer = masked.match(/export\s+(?:const|let|var)\s+((?:app|root)Router)\s*=\s*/i);
  if (composer && composer.index !== undefined) return composer;
  const exportBinding = masked.match(/export\s+(?:const|let|var)\s+(\w+Router)\s*=\s*/);
  const anyBinding = masked.match(/(?:export\s+)?(?:const|let|var)\s+(\w+Router)\s*=\s*/);
  const binding = exportBinding ?? anyBinding;
  if (!binding || binding.index === undefined) return null;
  return binding;
}

interface RouterMount {
  parent: string | null;
  key: string;
  child: string;
  /** Inline `t.router({ ... })` names wrapping this identifier mount. */
  nestParts: string[];
}

interface BindingFrame {
  name: string;
  openDepth: number;
  /** `(` depth of the `router(` that opened this object literal. */
  parenDepth: number;
}

/**
 * Walk identifier mounts from a nested router up to the file's prefix binding.
 * Memoized per binding: a depth-N chain used to recopy the ancestor path at
 * every procedure (O(procedures × depth²) array copies — quadratic-plus on
 * the C# concentrated-namespace analogue). One table is O(bindings + mounts).
 */
function buildMountPathLookup(
  root: string | null,
  mountsByChild: Map<string, RouterMount[]>,
): (binding: string | null) => string[][] {
  const memo = new Map<string, string[][]>();
  const visiting = new Set<string>();

  return function paths(binding: string | null): string[][] {
    if (!binding || !root || binding === root) return [[]];
    const cached = memo.get(binding);
    if (cached) return cached;
    // A cycle is not a root: returning [[]] fabricated `/trpc/b.list`.
    if (visiting.has(binding)) return [];
    visiting.add(binding);
    const parents = mountsByChild.get(binding);
    // Unmounted non-root bindings contribute no paths (pendingEmits drop).
    let result: string[][] = [];
    if (parents && parents.length > 0) {
      const out: string[][] = [];
      for (const mount of parents) {
        const hop = mount.key ? [...mount.nestParts, mount.key] : [...mount.nestParts];
        if (!mount.parent) {
          out.push(hop);
          continue;
        }
        for (const prefix of paths(mount.parent)) {
          out.push([...prefix, ...hop]);
        }
      }
      if (out.length > 0) result = out;
    }
    visiting.delete(binding);
    // Memoize live paths immediately so a depth-N chain is one walk, not one
    // remount per procedure. Leave nested empty results uncached: a cycle cut
    // returns [] for this hop only, and memoizing that would drop a later live
    // path (`a.b.list` after `a` ↔ `b`). A finished top-level [] is real
    // (unmounted / no root path) and is safe to cache.
    if (result.length > 0 || visiting.size === 0) memo.set(binding, result);
    return result;
  };
}

function prevNonSpace(text: string, index: number): string | null {
  for (let p = index - 1; p >= 0; p--) {
    if (!/\s/.test(text[p])) return text[p];
  }
  return null;
}

// `create: publicProcedure.mutation(handler)` — the graph Function is
// `handler`, not the object key. Inline `async` / `function` / `() =>`
// callbacks keep the key so HOC pair naming still matches.
const IDENTIFIER_CALLBACK_RESERVED = new Set(['async', 'function', 'await', 'new', 'yield']);
const IDENTIFIER_CALLBACK_RE =
  /^\.\s*(?:query|mutation|subscription)\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/;

function identifierCallbackName(textFromDot: string): string | undefined {
  const match = textFromDot.match(IDENTIFIER_CALLBACK_RE);
  if (!match || IDENTIFIER_CALLBACK_RESERVED.has(match[1])) return undefined;
  return match[1];
}

/** Line-start `^    .query(` matches at column 0; the scanner keys the `.`. */
function terminalDotIndex(text: string, start: number): number {
  const dot = text.indexOf('.', start);
  return dot === -1 ? start : dot;
}

export function extractTrpcRoutes(filePath: string, content: string): ExtractedRoute[] {
  // Raw miss is decisive: masking never invents `query` / `mutation` /
  // `subscription`, so skip the per-char mask on files that cannot be routers.
  if (!hasTrpcTerminalKeyword(content)) return [];
  const maskedSource = maskSource(content);
  if (!isTrpcRouterFileMasked(maskedSource)) return [];

  const routesByPath = new Map<string, ExtractedRoute>();
  const binding = findPrefixRouterBinding(maskedSource);
  const prefix = prefixFromBinding(maskedSource, content, filePath, binding);
  const rootBinding = binding?.[1] ?? null;

  const lines = content.split('\n');
  const nestStack: NestFrame[] = [];
  const bindingStack: BindingFrame[] = [];
  const mounts: RouterMount[] = [];
  const routerBindingNames = new Set<string>();
  const scanState = createScanState();
  let depth = 0;
  let parenDepth = 0;
  // Set on a router-open; the first '{' scanned afterwards opens the
  // router's object literal and pushes the frame (handles both
  // 'user: t.router({' and the rare '{' on the following line).
  let pendingRouterName: string | null = null;
  let pendingBindingName: string | null = null;
  let currentProcedure: { name: string; depth: number; parenDepth: number } | null = null;

  const pendingEmits: Array<{
    method: string;
    localParts: string[];
    containingBinding: string | null;
    terminalLine: number;
    methodName: string;
  }> = [];

  const emitProcedure = (
    method: string,
    proc: { name: string },
    terminalLine: number,
    textFromDot: string,
  ): void => {
    // Nested routers compose the full path ('user.admin.list'): without the
    // stack, same-named procedures in sibling routers deduped to ONE route
    // and the survivor carried the wrong path. Identifier mounts
    // (`admin: adminRouter`) are applied after the scan.
    pendingEmits.push({
      method,
      localParts: [...nestStack.map((frame) => frame.name), proc.name],
      containingBinding: bindingStack[bindingStack.length - 1]?.name ?? null,
      terminalLine,
      methodName: identifierCallbackName(textFromDot) ?? proc.name,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Keys / router-opens / terminals all see the same comment/string mask so
    // a commented-out `create: publicProcedure.query(` cannot steal the
    // pending key or emit a phantom route.
    const masked = maskNonCode(line, scanState);

    const routerByIndex = new Map<number, string>();
    for (const m of matchAll(ROUTER_OPEN_RE_G, masked)) {
      routerByIndex.set(m.index ?? 0, m[1] || m[3]);
    }
    const bindingByIndex = new Map<number, string>();
    for (const m of matchAll(ROUTER_BINDING_RE_G, masked)) {
      bindingByIndex.set(m.index ?? 0, m[1]);
      routerBindingNames.add(m[1]);
    }
    const keyByIndex = new Map<number, string>();
    for (const m of matchAll(PROCEDURE_KEY_RE_G, masked)) {
      const idx = m.index ?? 0;
      // 'admin: adminProcedure.router(' matches both; the router-open wins
      // so we do not poison currentProcedure (the double-prefix bug).
      if (!routerByIndex.has(idx)) keyByIndex.set(idx, m[1] || m[3]);
    }
    const refByIndex = new Map<number, { key: string; child: string }>();
    for (const m of matchAll(ROUTER_REF_RE_G, masked)) {
      const idx = m.index ?? 0;
      if (routerByIndex.has(idx) || keyByIndex.has(idx)) continue;
      refByIndex.set(idx, { key: m[1] || m[3], child: m[4] });
    }
    const terminalByIndex = new Map<number, string>();
    for (const m of matchAll(TERMINAL_CALL_RE_G, masked)) {
      terminalByIndex.set(terminalDotIndex(masked, m.index ?? 0), m[1]);
    }
    const anyTerminalByIndex = new Map<number, string>();
    for (const m of matchAll(ANY_TERMINAL_RE_G, masked)) {
      anyTerminalByIndex.set(m.index ?? 0, m[1]);
    }

    for (let c = 0; c < masked.length; c++) {
      const ch = masked[c];
      if (ch === '{') {
        depth++;
        if (pendingBindingName !== null) {
          bindingStack.push({ name: pendingBindingName, openDepth: depth, parenDepth });
          pendingBindingName = null;
        }
        if (pendingRouterName !== null) {
          nestStack.push({ name: pendingRouterName, openDepth: depth, parenDepth });
          pendingRouterName = null;
        }
      } else if (ch === '}') {
        depth--;
        while (nestStack.length > 0 && nestStack[nestStack.length - 1].openDepth > depth) {
          nestStack.pop();
        }
        while (bindingStack.length > 0 && bindingStack[bindingStack.length - 1].openDepth > depth) {
          bindingStack.pop();
        }
        // Nested `}),` inside `.input(z.object({...}))` returns TO the
        // recorded depth — the procedure chain is still open. Only a `}`
        // that drops BELOW the key's object (router / statement close)
        // clears the pending procedure.
        if (currentProcedure !== null && depth < currentProcedure.depth) {
          currentProcedure = null;
        }
      } else if (ch === '(') {
        parenDepth++;
      } else if (ch === ')') {
        if (parenDepth > 0) parenDepth--;
      } else if (ch === ';' && currentProcedure !== null && depth <= currentProcedure.depth) {
        currentProcedure = null;
      }

      // Brace (and nest push) at this index first, then router-open / key
      // that used `{` or `,` as their regex prefix. `{ admin: t.router({`
      // must set pending on the first `{` *after* that `{` opened the parent,
      // so the inner `{` is the one that pushes `admin`.
      const bindingName = bindingByIndex.get(c);
      if (bindingName !== undefined) {
        pendingBindingName = bindingName;
      }
      const routerName = routerByIndex.get(c);
      if (routerName !== undefined) {
        pendingRouterName = routerName;
      } else {
        const keyName = keyByIndex.get(c);
        if (keyName !== undefined) {
          currentProcedure = { name: keyName, depth, parenDepth };
        }
      }
      const ref = refByIndex.get(c);
      if (ref !== undefined) {
        const routerOpen = nestStack[nestStack.length - 1] ?? bindingStack[bindingStack.length - 1];
        // Only direct properties of a router object: refs inside `.query(` /
        // callbacks sit at a deeper parenDepth than the router-open `(`.
        if (!routerOpen || parenDepth <= routerOpen.parenDepth) {
          mounts.push({
            parent: bindingStack[bindingStack.length - 1]?.name ?? pendingBindingName,
            key: ref.key,
            child: ref.child,
            nestParts: nestStack.map((frame) => frame.name),
          });
        }
      }

      const candidate = anyTerminalByIndex.get(c);
      if (
        candidate !== undefined &&
        currentProcedure !== null &&
        parenDepth === currentProcedure.parenDepth &&
        (terminalByIndex.has(c) || prevNonSpace(masked, c) === ')')
      ) {
        // Identifier callbacks are `^`-anchored; current line is enough except
        // prettier-broken `.query(\n  handler\n)`. Cap at two following lines
        // so we do not rescan the file tail on every terminal.
        emitProcedure(
          candidate,
          currentProcedure,
          i + 1,
          lines
            .slice(i, i + 3)
            .join('\n')
            .slice(c),
        );
        currentProcedure = null;
      }
    }
  }

  for (const m of matchAll(MERGE_ROUTER_REF_RE_G, maskedSource)) {
    mounts.push({
      parent: m[1],
      key: '',
      child: m[2],
      nestParts: [],
    });
  }

  const mountsByChild = new Map<string, RouterMount[]>();
  for (const mount of mounts) {
    if (!routerBindingNames.has(mount.child)) continue;
    const list = mountsByChild.get(mount.child) ?? [];
    list.push(mount);
    mountsByChild.set(mount.child, list);
  }

  const mountPathsOf = buildMountPathLookup(rootBinding, mountsByChild);

  for (const pending of pendingEmits) {
    const mountPaths = mountPathsOf(pending.containingBinding);
    for (const mountParts of mountPaths) {
      const procedurePath = [
        ...(prefix ? [prefix] : []),
        ...mountParts,
        ...pending.localParts,
      ].join('.');

      // Last write wins: `t.router({ list: a, list: b })` is a JS object
      // literal, so tRPC only ever sees `b`. Keeping the first emit would
      // bind CALLS to dead handler code. Sibling routers still stay distinct
      // because `procedurePath` includes the nest (`admin.list` vs `billing.list`).
      routesByPath.set(procedurePath, {
        filePath,
        httpMethod: HTTP_METHOD_MAP[pending.method] ?? 'POST',
        routePath: '/trpc/' + procedurePath,
        routeName: procedurePath,
        // A tRPC router is an object binding, not a class. Route consumers
        // resolve 'controllerName' through lookupClassByName
        // (call-processor.ts), which would either skip these routes (no such
        // class) or mis-link an unrelated same-named class — leave it unset;
        // call-processor binds the same-file handler symbol directly.
        controllerName: null,
        methodName: pending.methodName,
        middleware: [],
        prefix: null,
        // pickSameFileHandler compares this 1-based line to Function
        // startLine (0-based). The handler is the terminal callback
        // (`.query` / `.mutation` / `.subscription`), so emit that line
        // — not the object-key line, which is often earlier after
        // `.input()` / `.use()` chaining. Same-line key+terminal is unchanged.
        lineNumber: pending.terminalLine,
      });
    }
  }

  return [...routesByPath.values()];
}
