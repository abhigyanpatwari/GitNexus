import type { SyntaxNode } from './utils/ast-helpers.js';

const KNOWN_REQUEST_LIKE_MODULES = new Set(['umi-request']);
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

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

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
  if (KNOWN_REQUEST_LIKE_MODULES.has(normalized)) return true;
  return REQUEST_LIKE_LOCAL_BASENAMES.has(moduleBasename(normalized));
}

function addIdentifier(target: Set<string>, raw: string): void {
  const candidate = raw.trim().replace(/^type\s+/, '');
  if (IDENT_RE.test(candidate)) target.add(candidate);
}

function parseImportClause(clause: string, target: Set<string>): void {
  const trimmed = clause.trim();
  if (!trimmed) return;

  const namedMatch = trimmed.match(/\{([^}]+)\}/);
  if (namedMatch) {
    for (const part of namedMatch[1].split(',')) {
      const item = part.trim();
      if (!item) continue;
      const aliasMatch = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliasMatch) {
        addIdentifier(target, aliasMatch[2]);
      } else {
        addIdentifier(target, item);
      }
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
    if (!isRequestLikeImportSource(source)) continue;
    parseImportClause(clause, bindings);
  }

  return bindings;
}

function nodeTextStartsWithPath(node: SyntaxNode): boolean {
  return node.text.startsWith('/') || node.text.startsWith('`/');
}

function isRequestLikeBinding(
  node: SyntaxNode | undefined,
  requestLikeBindings: ReadonlySet<string>,
): boolean {
  return !!node && requestLikeBindings.has(node.text);
}

export function getRequestLikeCapturedUrl(
  captureMap: Record<string, SyntaxNode>,
  requestLikeBindings: ReadonlySet<string>,
): string | null {
  const fnNode = captureMap['request_like_client.fn'];
  const urlNode =
    captureMap['request_like_client.url'] ?? captureMap['request_like_client.template_url'];
  if (!fnNode || !urlNode) return null;
  if (!requestLikeBindings.has(fnNode.text)) return null;
  if (!nodeTextStartsWithPath(urlNode)) return null;
  return urlNode.text;
}

export function getRequestLikeMemberCapturedUrl(
  captureMap: Record<string, SyntaxNode>,
  requestLikeBindings: ReadonlySet<string>,
): string | null {
  const receiverNode = captureMap['http_client.receiver'] ?? captureMap['express_route.receiver'];
  const methodNode = captureMap['http_client.method'] ?? captureMap['express_route.method'];
  const urlNode = captureMap['http_client.url'] ?? captureMap['express_route.path'];

  if (!isRequestLikeBinding(receiverNode, requestLikeBindings) || !methodNode || !urlNode) {
    return null;
  }
  if (!REQUEST_LIKE_MEMBER_METHODS.has(methodNode.text)) return null;
  if (!nodeTextStartsWithPath(urlNode)) return null;
  return urlNode.text;
}
