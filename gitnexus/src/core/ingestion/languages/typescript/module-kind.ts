import type { LanguageProvider } from '../../language-provider.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { assertCloneable } from '../../workers/clone-safety.js';
import { isCommonJsModule } from './cjs-export-assignment.js';

type CaptureEmitter = NonNullable<LanguageProvider['emitScopeCaptures']>;

type DeclarationScope = {
  kind: 'typescript-declarations';
  commonJs: boolean;
  script: boolean;
  globalNames: string[];
};

export function declarationScope(channel: unknown): DeclarationScope | undefined {
  if (
    typeof channel === 'object' &&
    channel !== null &&
    'kind' in channel &&
    channel.kind === 'typescript-declarations'
  )
    return channel as DeclarationScope;
  return undefined;
}

let pending: { filePath: string; value: boolean | DeclarationScope } | undefined;

export function withCommonJsModuleKind(emit: CaptureEmitter): CaptureEmitter {
  return (...args) => {
    pending = undefined;
    return emit(...args);
  };
}

export function recordCommonJsModuleKind(
  root: SyntaxNode,
  filePath: string,
  sourceText?: string,
): void {
  const commonJs = isCommonJsModule(root, filePath);
  pending = { filePath, value: commonJs };
  const declarationFile = filePath.endsWith('.d.ts');
  if (!declarationFile && !sourceText?.includes('global')) return;
  const statements = root.namedChildren;
  const externalModule =
    commonJs ||
    /\.[cm]ts$/.test(filePath) ||
    statements.some(
      (statement) =>
        statement?.type === 'import_statement' || statement?.type === 'export_statement',
    );
  const script = declarationFile && !externalModule;
  if (!script && !externalModule) return;
  const globalNames: string[] = [];
  function recordDeclaration(node: SyntaxNode | null) {
    if (!node) return;
    if (
      node.type === 'ambient_declaration' ||
      node.type === 'lexical_declaration' ||
      node.type === 'variable_declaration'
    ) {
      for (const child of node.namedChildren) recordDeclaration(child);
      return;
    }
    const name = node.childForFieldName('name');
    if (name?.type === 'identifier' || name?.type === 'type_identifier') {
      globalNames.push(`${name.startPosition.row + 1}:${name.startPosition.column}`);
    }
  }
  for (const statement of statements) {
    if (!statement) continue;
    if (script) recordDeclaration(statement);
    else if (
      statement.type === 'ambient_declaration' &&
      statement.children.some((child) => child?.type === 'global')
    ) {
      const block = statement.namedChildren.find((child) => child?.type === 'statement_block');
      for (const declaration of block?.namedChildren ?? []) recordDeclaration(declaration);
    }
  }
  if (script || globalNames.length) {
    pending.value = { kind: 'typescript-declarations', commonJs, script, globalNames };
  }
}

export function collectCommonJsModuleKind(
  filePath: string,
): boolean | DeclarationScope | undefined {
  const captured = pending;
  pending = undefined;
  return captured?.filePath === filePath ? assertCloneable(captured.value) : undefined;
}
