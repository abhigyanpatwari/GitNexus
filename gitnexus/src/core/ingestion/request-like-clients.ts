import type { SyntaxNode } from './utils/ast-helpers.js';

const REQUEST_LIKE_IMPORT_SOURCES = new Set(['umi-request']);
const REQUEST_LIKE_LOCAL_BASENAMES = new Set(['request']);
const REQUEST_LIKE_MEMBER_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'request',
  'ajax',
]);

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

function stripExtension(specifier: string): string {
  return specifier.replace(/\.(?:[cm]?[jt]sx?)$/i, '');
}

function moduleBasename(specifier: string): string {
  const normalized = stripExtension(specifier.replace(/\\/g, '/')).toLowerCase();
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function isRequestLikeImportSource(specifier: string): boolean {
  const normalized = specifier.trim().replace(/\\/g, '/').toLowerCase();
  return (
    REQUEST_LIKE_IMPORT_SOURCES.has(normalized) ||
    REQUEST_LIKE_LOCAL_BASENAMES.has(moduleBasename(normalized))
  );
}

function addIdentifier(target: Set<string>, raw: string): void {
  const candidate = raw.trim().replace(/^type\s+/, '');
  if (IDENTIFIER_RE.test(candidate)) target.add(candidate);
}

function parseImportClause(clause: string, target: Set<string>): void {
  const trimmed = clause.trim();
  if (!trimmed) return;

  const namespaceMatch = trimmed.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (namespaceMatch) {
    addIdentifier(target, namespaceMatch[1]);
    return;
  }

  const namedMatch = trimmed.match(/\{([^}]+)\}/);
  if (namedMatch) {
    for (const part of namedMatch[1].split(',')) {
      const item = part.trim();
      if (!item) continue;
      const aliasMatch = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      addIdentifier(target, aliasMatch ? aliasMatch[2] : item);
    }
  }

  const defaultPart = trimmed.split(',')[0]?.trim() || '';
  if (defaultPart && !defaultPart.startsWith('{') && !defaultPart.startsWith('*')) {
    addIdentifier(target, defaultPart);
  }
}

export function collectRequestLikeImportBindings(content: string): Set<string> {
  const bindings = new Set<string>();
  const importRe = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRe.exec(content)) !== null) {
    const [, clause, source] = match;
    if (isRequestLikeImportSource(source)) parseImportClause(clause, bindings);
  }

  return bindings;
}

function getMemberCallReceiver(callNode: SyntaxNode | undefined): SyntaxNode | undefined {
  const functionNode = callNode?.childForFieldName?.('function') ?? callNode?.children?.[0];
  return functionNode?.childForFieldName?.('object') ?? functionNode?.children?.[0];
}

function nodeTextStartsWithPath(node: SyntaxNode): boolean {
  return node.text.startsWith('/') || node.text.startsWith('`/');
}

export function getRequestLikeMemberCallUrl(
  captureMap: Record<string, SyntaxNode>,
  requestLikeBindings: ReadonlySet<string>,
): string | null {
  const callNode = captureMap['http_client'] ?? captureMap['express_route'];
  const receiverNode = getMemberCallReceiver(callNode);
  const methodNode = captureMap['http_client.method'] ?? captureMap['express_route.method'];
  const urlNode = captureMap['http_client.url'] ?? captureMap['express_route.path'];

  if (!receiverNode || !methodNode || !urlNode) return null;
  if (!requestLikeBindings.has(receiverNode.text)) return null;
  if (!REQUEST_LIKE_MEMBER_METHODS.has(methodNode.text)) return null;
  if (!nodeTextStartsWithPath(urlNode)) return null;
  return urlNode.text;
}
