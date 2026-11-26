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
  scriptNames?: string[];
  containsJsx?: boolean;
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
  const declarationFile = /\.d\.[cm]?ts$/.test(filePath);
  const ordinarySource = /\.[cm]?tsx?$/.test(filePath);
  if (!ordinarySource && !sourceText?.includes('global')) return;
  const statements = root.namedChildren;
  const externalModule =
    commonJs ||
    /\.[cm]ts$/.test(filePath) ||
    statements.some(
      (statement) =>
        statement?.type === 'import_statement' || statement?.type === 'export_statement',
    ) ||
    (sourceText?.includes('import') &&
      root.descendantsOfType('meta_property').some((node) => node.firstChild?.type === 'import'));
  if (externalModule && !sourceText?.includes('global')) return;
  const script = !externalModule && ordinarySource;
  if (!script && !externalModule) return;
  const globalNames: string[] = [];
  const scriptNames: string[] = [];
  function recordDeclaration(node: SyntaxNode | null, names: string[]) {
    if (!node) return;
    if (
      node.type === 'ambient_declaration' ||
      node.type === 'lexical_declaration' ||
      node.type === 'variable_declaration'
    ) {
      for (const child of node.namedChildren) recordDeclaration(child, names);
      return;
    }
    const name = node.childForFieldName('name');
    if (name?.type === 'identifier' || name?.type === 'type_identifier') {
      names.push(`${name.startPosition.row + 1}:${name.startPosition.column}`);
    }
  }
  // Only statements can hoist var into a script. Function, class and namespace
  // bodies have their own var scopes and must not contribute declarations.
  function recordNestedVars(node: SyntaxNode, names: string[]) {
    if (node.type === 'variable_declaration') {
      recordDeclaration(node, names);
    } else if (
      node.type === 'statement_block' ||
      node.type.endsWith('_statement') ||
      node.type === 'switch_body' ||
      node.type === 'switch_case' ||
      node.type === 'switch_default' ||
      node.type === 'else_clause' ||
      node.type === 'catch_clause' ||
      node.type === 'finally_clause'
    ) {
      if (node.type === 'for_in_statement' && node.childForFieldName('kind')?.type === 'var') {
        const left = node.childForFieldName('left');
        if (left?.type === 'identifier')
          names.push(`${left.startPosition.row + 1}:${left.startPosition.column}`);
      }
      for (const child of node.namedChildren) recordNestedVars(child, names);
    }
  }
  const hasScriptVars = script && !declarationFile && (!sourceText || /\bvar\b/.test(sourceText));
  for (const statement of statements) {
    if (!statement) continue;
    if (script) recordDeclaration(statement, declarationFile ? globalNames : scriptNames);
    if (hasScriptVars && statement.type !== 'variable_declaration')
      recordNestedVars(statement, scriptNames);
    if (
      (!script || !declarationFile) &&
      statement.type === 'ambient_declaration' &&
      statement.children.some((child) => child?.type === 'global')
    ) {
      const block = statement.namedChildren.find((child) => child?.type === 'statement_block');
      for (const declaration of block?.namedChildren ?? [])
        recordDeclaration(declaration, globalNames);
    }
  }
  if (script || globalNames.length) {
    pending.value = {
      kind: 'typescript-declarations',
      commonJs,
      script,
      globalNames,
      ...(script && !declarationFile ? { scriptNames } : {}),
      ...(script &&
      /\.tsx$/.test(filePath) &&
      root.descendantsOfType(['jsx_element', 'jsx_self_closing_element']).length
        ? { containsJsx: true }
        : {}),
    };
  }
}

export function collectCommonJsModuleKind(
  filePath: string,
): boolean | DeclarationScope | undefined {
  const captured = pending;
  pending = undefined;
  return captured?.filePath === filePath ? assertCloneable(captured.value) : undefined;
}
