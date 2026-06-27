import type { ExtractedRoute } from './laravel.js';

const HTTP_METHOD_MAP: Record<string, string> = {
  query: 'GET',
  mutation: 'POST',
  subscription: 'WS',
};

interface TrpcRouterInfo {
  routerName: string | null;
  prefix: string | null;
}

function extractRouterPrefix(content: string, filePath: string): string | null {
  const mergeMatch = content.match(/\.merge\s*\(\s*(?:"([^"]+)"|'([^']+)')\s*,/);
  if (mergeMatch) return mergeMatch[1] ?? mergeMatch[2];

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

function extractRouterInfo(content: string, filePath: string): TrpcRouterInfo {
  const routerMatch = content.match(
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:t\.|tRPC|trpc|publicProcedure|protectedProcedure|privateProcedure|appRouter|baseProcedure|\w+Procedure)\s*\.router\s*\(/,
  );
  const routerName = routerMatch?.[1] ?? null;

  const prefix = extractRouterPrefix(content, filePath);

  return { routerName, prefix };
}

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
    /\b\w*Procedure\w*\b/.test(content)
  );
}

export function extractTrpcRoutes(filePath: string, content: string): ExtractedRoute[] {
  if (!isTrpcRouterFile(content)) return [];

  const routes: ExtractedRoute[] = [];
  const seen = new Set<string>();
  const { routerName, prefix } = extractRouterInfo(content, filePath);

  const lines = content.split('\n');
  let currentProcedure: { name: string; line: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const keyMatch = line.match(/^\s{2,4}(\w+)\s*:\s*(\w*Procedure|t\.procedure)\b/);
    if (keyMatch) {
      currentProcedure = { name: keyMatch[1], line: i + 1 };
    }

    const terminalMatch = line.match(/\.\s*(query|mutation|subscription)\s*\(/);
    if (terminalMatch && currentProcedure) {
      const method = terminalMatch[1];
      const procedureName = currentProcedure.name;
      const procedurePath = prefix ? `${prefix}.${procedureName}` : procedureName;

      if (!seen.has(procedurePath)) {
        seen.add(procedurePath);
        routes.push({
          filePath,
          httpMethod: HTTP_METHOD_MAP[method] ?? 'POST',
          routePath: `/trpc/${procedurePath}`,
          routeName: procedurePath,
          controllerName: routerName,
          methodName: procedureName,
          middleware: [],
          prefix: null,
          lineNumber: currentProcedure.line,
        });
      }
      currentProcedure = null;
    }
  }

  return routes;
}

export { isTrpcRouterFile };
