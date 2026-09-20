import type { ExtractedRoute } from './laravel.js';

const HTTP_METHOD_MAP: Record<string, string> = {
  query: 'GET',
  mutation: 'POST',
  subscription: 'WS',
};

// Shared by the file gate and the line scanner. Extraction already allowed
// whitespace before '(' (`publicProcedure.query (`) but the gate used a
// literal `.query(` substring, so pretty-printed terminals never entered
// the scanner. Keep both sides on this one pattern.
const TERMINAL_CALL_RE = /\.\s*(query|mutation|subscription)\s*\(/;

// Procedure keys may sit at the start of an indented line, or mid-line after
// `{` / `,` in a compact router (`t.router({ health: publicProcedure.query(...) })`).
// Quoted keys (`'create'` / `"create"`) are the same procedure name as the
// unquoted identifier.
const PROCEDURE_KEY_RE =
  /(?:^|[{,])\s*(['"]?)(\w+)\1\s*:\s*(\w*Procedure|t\.procedure)\b/;

/** Normalize slashes and prefix `/` so a repo-root `routers/foo.ts` matches `/routers/`. */
export function shouldScanForTrpcRoutes(filePath: string): boolean {
  let p = filePath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return p.includes('/routers/') || p.includes('/trpc/') || p.includes('/server/');
}

function extractRouterPrefix(content: string, filePath: string): string | null {
  // Comments / string literals must not supply a prefix (`// const fooRouter =`
  // or a `.merge('post.'` inside a string). maskNonCode preserves length, so a
  // hit on the mask can be re-read from the original for quoted merge text.
  const masked = maskSource(content);

  const mergePos = masked.search(/\.merge\s*\(/);
  if (mergePos >= 0) {
    const mergeMatch = content
      .slice(mergePos)
      .match(/\.merge\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*,/);
    if (mergeMatch) {
      // A '.merge('post.', ...)' prefix composes the route-path key; a stray
      // leading/trailing dot would double up when we join ('post..list') —
      // strip both edges and treat an all-dot prefix as no prefix.
      const merged = (mergeMatch[1] ?? mergeMatch[2] ?? '').replace(/^\.+|\.+$/g, '');
      return merged.length > 0 ? merged : null;
    }
  }

  const routerVarMatch = masked.match(
    /(?:export\s+)?(?:const|let|var)\s+(\w+Router)\s*=\s*(?:createTRPCRouter|\w+\s*\.\s*router)\s*\(/,
  );
  if (routerVarMatch) {
    return routerVarMatch[1].replace(/Router$/i, '');
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
function isTrpcRouterFile(content: string): boolean {
  // Cheap reject before the terminal regex: every live procedure still
  // contains one of these identifiers. Whitespace between `.` and the
  // name is allowed by TERMINAL_CALL_RE, so we do not require a literal `.query`.
  if (
    !content.includes('query') &&
    !content.includes('mutation') &&
    !content.includes('subscription')
  ) {
    return false;
  }
  if (!TERMINAL_CALL_RE.test(content)) {
    return false;
  }
  return (
    /initTRPC|createTRPCRouter|createTRPCProxyClient|createTRPCNext|@trpc\//.test(content) ||
    /\b(?:public|protected|private)Procedure\b/.test(content)
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
}

/**
 * Replace comments and string/template literals with spaces so a regex can
 * see only real code. Updates `state` so the next line (and `maskSource`)
 * inherit the live comment/string machine.
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
      if (ch === state.inString) state.inString = null;
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
    if (ch === "'" || ch === '"' || ch === '\u0060') {
      // Keep `'create':` / `"admin":` visible so PROCEDURE_KEY_RE and
      // ROUTER_OPEN_RE can see quoted keys after the mask. A real string
      // (no `ident` + matching quote + colon) is still blanked.
      if (ch !== '\u0060') {
        const quotedKey = line.slice(i).match(/^(['"])(\w+)\1\s*:/);
        if (quotedKey) {
          i += quotedKey[0].length;
          continue;
        }
      }
      out[i] = ' ';
      state.inString = ch;
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Whole-file mask. Length-preserving so indices align with `content`. */
function maskSource(content: string): string {
  const state: ScanState = { inString: null, inBlockComment: false };
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
}

// Router open: 'name: t.router(', 'name: trpc.router(',
// 'name: createTRPCRouter(', 'name: someProcedure.router(', and the bare
// 'name: router(' style ('import { router } from "../trpc"' re-exports are
// common in v11 codebases). Same `(?:^|[{,])` prefix as PROCEDURE_KEY_RE so a
// compact `admin: t.router({ list: ...})` mid-line still pushes nestStack.
// The object-literal body opens at the first '{' scanned after the match
// (almost always on the same line).
const ROUTER_OPEN_RE =
  /(?:^|[{,])\s*(['"]?)(\w+)\1\s*:\s*(?:(?:t|trpc|tRPC)\s*\.\s*router|createTRPCRouter|\w+Procedure\s*\.\s*router|router)\s*\(/;

// `/g` copies for matchAll. The non-global originals stay lastIndex-safe for `.test()`.
const TERMINAL_CALL_RE_G = new RegExp(TERMINAL_CALL_RE.source, 'g');
const PROCEDURE_KEY_RE_G = new RegExp(PROCEDURE_KEY_RE.source, 'g');
const ROUTER_OPEN_RE_G = new RegExp(ROUTER_OPEN_RE.source, 'g');

function matchAll(re: RegExp, text: string): RegExpMatchArray[] {
  re.lastIndex = 0;
  return [...text.matchAll(re)];
}

export function extractTrpcRoutes(filePath: string, content: string): ExtractedRoute[] {
  if (!isTrpcRouterFile(content)) return [];

  const routes: ExtractedRoute[] = [];
  const seen = new Set<string>();
  const prefix = extractRouterPrefix(content, filePath);

  const lines = content.split('\n');
  const nestStack: NestFrame[] = [];
  const scanState: ScanState = { inString: null, inBlockComment: false };
  let depth = 0;
  // Set on a router-open; the first '{' scanned afterwards opens the
  // router's object literal and pushes the frame (handles both
  // 'user: t.router({' and the rare '{' on the following line).
  let pendingRouterName: string | null = null;
  let currentProcedure: { name: string; line: number; depth: number } | null = null;

  const emitProcedure = (method: string, proc: { name: string; line: number }): void => {
    // Nested routers compose the full path ('user.admin.list'): without the
    // stack, same-named procedures in sibling routers deduped to ONE route
    // and the survivor carried the wrong path.
    const parts = [...nestStack.map((frame) => frame.name), proc.name];
    const procedurePath = [...(prefix ? [prefix] : []), ...parts].join('.');

    if (!seen.has(procedurePath)) {
      seen.add(procedurePath);
      routes.push({
        filePath,
        httpMethod: HTTP_METHOD_MAP[method] ?? 'POST',
        routePath: '/trpc/' + procedurePath,
        routeName: procedurePath,
        // A tRPC router is an object binding, not a class. Route consumers
        // resolve 'controllerName' through lookupClassByName
        // (call-processor.ts), which would either skip these routes (no such
        // class) or mis-link an unrelated same-named class — leave it unset;
        // call-processor binds the same-file handler symbol directly.
        controllerName: null,
        methodName: proc.name,
        middleware: [],
        prefix: null,
        lineNumber: proc.line,
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Keys / router-opens / terminals all see the same comment/string mask so
    // a commented-out `create: publicProcedure.query(` cannot steal the
    // pending key or emit a phantom route.
    const masked = maskNonCode(line, scanState);

    const routerByIndex = new Map<number, string>();
    for (const m of matchAll(ROUTER_OPEN_RE_G, masked)) {
      routerByIndex.set(m.index ?? 0, m[2]);
    }
    const keyByIndex = new Map<number, string>();
    for (const m of matchAll(PROCEDURE_KEY_RE_G, masked)) {
      const idx = m.index ?? 0;
      // 'admin: adminProcedure.router(' matches both; the router-open wins
      // so we do not poison currentProcedure (the double-prefix bug).
      if (!routerByIndex.has(idx)) keyByIndex.set(idx, m[2]);
    }
    const terminalByIndex = new Map<number, string>();
    for (const m of matchAll(TERMINAL_CALL_RE_G, masked)) {
      terminalByIndex.set(m.index ?? 0, m[1]);
    }

    for (let c = 0; c < masked.length; c++) {
      const ch = masked[c];
      if (ch === '{') {
        depth++;
        if (pendingRouterName !== null) {
          nestStack.push({ name: pendingRouterName, openDepth: depth });
          pendingRouterName = null;
        }
      } else if (ch === '}') {
        depth--;
        while (nestStack.length > 0 && nestStack[nestStack.length - 1].openDepth > depth) {
          nestStack.pop();
        }
        // Nested `}),` inside `.input(z.object({...}))` returns TO the
        // recorded depth — the procedure chain is still open. Only a `}`
        // that drops BELOW the key's object (router / statement close)
        // clears the pending procedure.
        if (currentProcedure !== null && depth < currentProcedure.depth) {
          currentProcedure = null;
        }
      } else if (ch === ';' && currentProcedure !== null && depth <= currentProcedure.depth) {
        currentProcedure = null;
      }

      // Brace (and nest push) at this index first, then router-open / key
      // that used `{` or `,` as their regex prefix. `{ admin: t.router({`
      // must set pending on the first `{` *after* that `{` opened the parent,
      // so the inner `{` is the one that pushes `admin`.
      const routerName = routerByIndex.get(c);
      if (routerName !== undefined) {
        pendingRouterName = routerName;
      } else {
        const keyName = keyByIndex.get(c);
        if (keyName !== undefined) {
          currentProcedure = { name: keyName, line: i + 1, depth };
        }
      }

      const terminalMethod = terminalByIndex.get(c);
      if (terminalMethod !== undefined && currentProcedure !== null) {
        emitProcedure(terminalMethod, currentProcedure);
        currentProcedure = null;
      }
    }
  }

  return routes;
}
