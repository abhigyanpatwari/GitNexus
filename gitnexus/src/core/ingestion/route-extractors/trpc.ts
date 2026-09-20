import type { ExtractedRoute } from './laravel.js';

const HTTP_METHOD_MAP: Record<string, string> = {
  query: 'GET',
  mutation: 'POST',
  subscription: 'WS',
};

function extractRouterPrefix(content: string, filePath: string): string | null {
  const mergeMatch = content.match(/\.merge\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*,/);
  if (mergeMatch) {
    // A '.merge('post.', ...)' prefix composes the route-path key; a stray
    // leading/trailing dot would double up when we join ('post..list') —
    // strip both edges and treat an all-dot prefix as no prefix.
    const merged = (mergeMatch[1] ?? mergeMatch[2] ?? '').replace(/^\.+|\.+$/g, '');
    return merged.length > 0 ? merged : null;
  }

  const routerVarMatch = content.match(/(?:const|let|var)\s+(\w+Router)\s*=\s*\w+\s*\.router\s*\(/);
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
  if (
    !content.includes('.query(') &&
    !content.includes('.mutation(') &&
    !content.includes('.subscription(')
  ) {
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

function scanLineBraces(
  line: string,
  state: ScanState,
  onOpen: () => void,
  onClose: () => void,
): void {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    if (state.inString !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === state.inString) state.inString = null;
      i++;
      continue;
    }
    if (state.inBlockComment) {
      if (ch === '*' && next === '/') {
        state.inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '/' && next === '/') return; // line comment: nothing else counts
    if (ch === '/' && next === '*') {
      state.inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '\u0060') {
      state.inString = ch;
      i++;
      continue;
    }
    if (ch === '{') {
      onOpen();
      i++;
      continue;
    }
    if (ch === '}') {
      onClose();
      i++;
      continue;
    }
    i++;
  }
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

// Line-anchored router open: 'name: t.router(', 'name: trpc.router(',
// 'name: createTRPCRouter(', 'name: someProcedure.router(', and the bare
// 'name: router(' style ('import { router } from "../trpc"' re-exports are
// common in v11 codebases). The object-literal body opens at the first '{'
// scanned after the match (almost always on the same line).
const ROUTER_OPEN_RE =
  /^\s*(\w+)\s*:\s*(?:(?:t|trpc|tRPC)\s*\.\s*router|createTRPCRouter|\w+Procedure\s*\.\s*router|router)\s*\(/;

export function extractTrpcRoutes(filePath: string, content: string): ExtractedRoute[] {
  if (!isTrpcRouterFile(content)) return [];

  const routes: ExtractedRoute[] = [];
  const seen = new Set<string>();
  const prefix = extractRouterPrefix(content, filePath);

  const lines = content.split('\n');
  const nestStack: NestFrame[] = [];
  const scanState: ScanState = { inString: null, inBlockComment: false };
  let depth = 0;
  // Set on a router-open line; the first '{' scanned afterwards opens the
  // router's object literal and pushes the frame (handles both
  // 'user: t.router({' and the rare '{' on the following line).
  let pendingRouterName: string | null = null;
  let currentProcedure: { name: string; line: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A router-open line is a router key, not a procedure key — check it first
    // so 'admin: adminProcedure.router(' does not also match the procedure
    // pattern below and poison currentProcedure (the double-prefix bug).
    const routerOpenMatch = line.match(ROUTER_OPEN_RE);
    const keyMatch = routerOpenMatch
      ? null
      : line.match(/^\s+(\w+)\s*:\s*(\w*Procedure|t\.procedure)\b/);
    if (routerOpenMatch) {
      pendingRouterName = routerOpenMatch[1];
    } else if (keyMatch) {
      currentProcedure = { name: keyMatch[1], line: i + 1 };
    }

    const terminalMatch = line.match(/\.\s*(query|mutation|subscription)\s*\(/);
    if (terminalMatch && currentProcedure) {
      const method = terminalMatch[1];
      // Nested routers compose the full path ('user.admin.list'): without the
      // stack, same-named procedures in sibling routers deduped to ONE route
      // and the survivor carried the wrong path.
      const parts = [...nestStack.map((frame) => frame.name), currentProcedure.name];
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
          methodName: currentProcedure.name,
          middleware: [],
          prefix: null,
          lineNumber: currentProcedure.line,
        });
      }
      currentProcedure = null;
    } else if (
      currentProcedure !== null &&
      !keyMatch &&
      // Chained '.input(...)' / '.use(...)' continuations keep the key alive —
      // the common multi-line 'list: protectedProcedure / .input(...) /
      // .query(...)' formatting puts key and terminal on different lines.
      !/^\s*\.\s*\w+\s*\(/.test(line) &&
      // Otherwise the statement is clearly over: the enclosing object closed
      // (a '})' or '});' line) or the line terminated with a semicolon.
      (/^\s*\}/.test(line) || /;\s*$/.test(line))
    ) {
      currentProcedure = null;
    }

    scanLineBraces(
      line,
      scanState,
      () => {
        depth++;
        if (pendingRouterName !== null) {
          nestStack.push({ name: pendingRouterName, openDepth: depth });
          pendingRouterName = null;
        }
      },
      () => {
        depth--;
        while (nestStack.length > 0 && nestStack[nestStack.length - 1].openDepth > depth) {
          nestStack.pop();
        }
      },
    );
  }

  return routes;
}

export { isTrpcRouterFile };
