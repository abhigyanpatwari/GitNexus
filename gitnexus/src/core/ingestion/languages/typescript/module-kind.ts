import type { CaptureMatch } from 'gitnexus-shared';
import type { LanguageProvider } from '../../language-provider.js';
import { syntheticCapture, type SyntaxNode } from '../../utils/ast-helpers.js';
import { assertCloneable } from '../../workers/clone-safety.js';
import { isCommonJsModule } from './cjs-export-assignment.js';
import { canonicalTypeScriptName } from './identifiers.js';
import { boundNames } from './local-loaders.js';
import { hasEsmSyntax, type ConditionalEsmExports } from '../../ts-js-export-marker.js';
import type { CallEvidence } from './argument-evidence.js';
import type { EnumValues } from './enum-arguments.js';

type CaptureEmitter = NonNullable<LanguageProvider['emitScopeCaptures']>;

type DeclarationScope = {
  kind: 'typescript-declarations';
  commonJs: boolean;
  script: boolean;
  globalNames: string[];
  scriptNames?: string[];
  containsJsx?: boolean;
  referencePaths?: string[];
  callArguments?: CallEvidence;
  enumValues?: EnumValues;
  possibleCommonJsDefaults?: string[];
  conditionalEsmExports?: ConditionalEsmExports;
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

type PendingDeclarations = { filePath: string; value: boolean | DeclarationScope };
let pending: PendingDeclarations | undefined;

function ensureDeclarationScope(entry: PendingDeclarations): DeclarationScope {
  if (typeof entry.value === 'boolean') {
    entry.value = {
      kind: 'typescript-declarations',
      commonJs: entry.value,
      script: false,
      globalNames: [],
    };
  }
  return entry.value;
}

function pendingDeclarations(filePath: string): DeclarationScope | undefined {
  if (pending?.filePath === filePath) return ensureDeclarationScope(pending);
}

/** An import-bearing .ts file may emit a Node wrapper under its project's module setting. */
export function recordPossibleCommonJsDefault(filePath: string, node: SyntaxNode): void {
  const scope = pendingDeclarations(filePath);
  if (!scope) return;
  scope.possibleCommonJsDefaults ??= [];
  scope.possibleCommonJsDefaults.push(`${node.startPosition.row + 1}:${node.startPosition.column}`);
}

/** Workers serialize only explicit ESM publications for files with conflicting CommonJS evidence. */
export function recordConditionalEsmExports(
  filePath: string,
  evidence: ConditionalEsmExports | undefined,
  captures: readonly CaptureMatch[],
): void {
  // A file with no local declarations publishes the same empty local surface in either format.
  if (!evidence || !captures.some((match) => match['@declaration.name'])) return;
  const scope = pendingDeclarations(filePath);
  if (scope) scope.conditionalEsmExports = evidence;
}

export function withCommonJsModuleKind(emit: CaptureEmitter): CaptureEmitter {
  return (...args) => {
    pending = undefined;
    return emit(...args);
  };
}

function leadingReferencePaths(statements: readonly SyntaxNode[], sourceText?: string): string[] {
  const paths: string[] = [];
  if (!sourceText?.includes('<reference')) return paths;
  for (const statement of statements) {
    if (statement?.type !== 'comment' && statement?.type !== 'hash_bang_line') break;
    const directive = /^\/\/\/\s*<reference\s+path\s*=\s*(?:"([^"]+)"|'([^']+)')\s*\/>/i.exec(
      statement.text,
    );
    if (directive) paths.push(directive[1] ?? directive[2]);
  }
  return paths;
}

function importedBindingPositions(captures?: CaptureMatch[]): Set<string> {
  const positions = new Set<string>();
  for (const match of captures ?? []) {
    const range = match['@import.alias']?.range;
    if (range) positions.add(`${range.startLine}:${range.startCol}`);
  }
  return positions;
}

class DeclarationNames {
  readonly globalNames: string[] = [];
  readonly scriptNames: string[] = [];
  private importedBindings?: Set<string>;

  constructor(private readonly captures?: CaptureMatch[]) {}

  private recordBinding(name: SyntaxNode | null, names: string[], kind?: string) {
    if (name?.type === 'identifier' || name?.type === 'type_identifier') {
      names.push(`${name.startPosition.row + 1}:${name.startPosition.column}`);
      return;
    }
    if (!kind || (name?.type !== 'object_pattern' && name?.type !== 'array_pattern')) return;
    // A destructured loader already binds its local name to the imported definition.
    this.importedBindings ??= importedBindingPositions(this.captures);
    for (const binding of boundNames(name)) {
      const text = canonicalTypeScriptName(binding.text);
      const position = `${binding.startPosition.row + 1}:${binding.startPosition.column}`;
      names.push(position);
      if (this.importedBindings.has(position)) continue;
      this.captures?.push({
        '@declaration.variable': syntheticCapture(
          '@declaration.variable',
          binding,
          kind + ' ' + text,
        ),
        '@declaration.name': syntheticCapture('@declaration.name', binding, text),
      });
    }
  }

  private recordDeclaration(node: SyntaxNode | null, names: string[]) {
    if (!node) return;
    if (
      node.type === 'ambient_declaration' ||
      node.type === 'lexical_declaration' ||
      node.type === 'variable_declaration'
    ) {
      for (const child of node.namedChildren) this.recordDeclaration(child, names);
      return;
    }
    this.recordBinding(
      node.childForFieldName('name'),
      names,
      node.type === 'variable_declarator' ? node.parent?.firstChild?.type : undefined,
    );
  }
  // Only statements can hoist var into a script. Function, class and namespace
  // bodies have their own var scopes and must not contribute declarations.
  private recordNestedVars(node: SyntaxNode, names: string[]) {
    if (node.type === 'variable_declaration') {
      this.recordDeclaration(node, names);
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
        this.recordBinding(node.childForFieldName('left'), names, 'var');
      }
      for (const child of node.namedChildren) this.recordNestedVars(child, names);
    }
  }

  recordStatement(
    statement: SyntaxNode,
    script: boolean,
    declarationFile: boolean,
    hasScriptVars: boolean,
  ) {
    if (!statement) return;
    if (script) {
      const declaration =
        statement.type === 'expression_statement' &&
        statement.firstNamedChild?.type === 'internal_module'
          ? statement.firstNamedChild
          : statement;
      this.recordDeclaration(declaration, declarationFile ? this.globalNames : this.scriptNames);
    }
    if (hasScriptVars && statement.type !== 'variable_declaration')
      this.recordNestedVars(statement, this.scriptNames);
    if (
      (!script || !declarationFile) &&
      statement.type === 'ambient_declaration' &&
      statement.children.some((child) => child?.type === 'global')
    ) {
      const block = statement.namedChildren.find((child) => child?.type === 'statement_block');
      for (const declaration of block?.namedChildren ?? [])
        this.recordDeclaration(declaration, this.globalNames);
    }
  }
}

function collectModuleDeclarations(
  root: SyntaxNode,
  filePath: string,
  sourceText?: string,
  captures?: CaptureMatch[],
) {
  const ordinarySource = /\.[cm]?tsx?$/.test(filePath);
  const mayDeclareGlobals = sourceText?.includes('global');
  if (!ordinarySource && !mayDeclareGlobals) return;
  const statements = root.namedChildren;
  const referencePaths = leadingReferencePaths(statements, sourceText);
  const externalModule = hasEsmSyntax(root, sourceText);
  if (externalModule && !referencePaths.length && !mayDeclareGlobals) return;
  const script = !externalModule && ordinarySource;
  if (!script && !externalModule) return;

  const declarationFile = /\.d\.[cm]?ts$/.test(filePath);
  const hasScriptVars = script && !declarationFile && (!sourceText || /\bvar\b/.test(sourceText));
  const names = new DeclarationNames(captures);
  for (const statement of statements)
    names.recordStatement(statement, script, declarationFile, hasScriptVars);
  const { globalNames, scriptNames } = names;
  if (
    !(script && (declarationFile || scriptNames.length)) &&
    !globalNames.length &&
    !referencePaths.length
  )
    return;
  return {
    script,
    globalNames,
    ...(referencePaths.length && { referencePaths }),
    ...(script && !declarationFile && { scriptNames }),
    ...(script &&
      filePath.endsWith('.tsx') &&
      root.descendantsOfType(['jsx_element', 'jsx_self_closing_element']).length && {
        containsJsx: true,
      }),
  };
}

export function recordCommonJsModuleKind(
  root: SyntaxNode,
  filePath: string,
  sourceText?: string,
  captures?: CaptureMatch[],
  callArguments?: CallEvidence,
  enumValues?: EnumValues,
): void {
  pending = { filePath, value: isCommonJsModule(root, filePath) };
  if (callArguments || enumValues) {
    const scope = ensureDeclarationScope(pending);
    if (callArguments) scope.callArguments = callArguments;
    if (enumValues) scope.enumValues = enumValues;
  }
  const metadata = collectModuleDeclarations(root, filePath, sourceText, captures);
  if (metadata) Object.assign(ensureDeclarationScope(pending), metadata);
}

export function collectCommonJsModuleKind(
  filePath: string,
): boolean | DeclarationScope | undefined {
  const captured = pending;
  pending = undefined;
  return captured?.filePath === filePath ? assertCloneable(captured.value) : undefined;
}
