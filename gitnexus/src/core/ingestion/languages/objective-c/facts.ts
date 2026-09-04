import type { Capture, CaptureMatch, NodeLabel, ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import type Parser from 'tree-sitter';
import { generateId } from '../../../../lib/utils.js';
import type {
  ProviderSemanticGraph,
  ProviderSemanticNode,
  ProviderSemanticRelationship,
  ProviderSemanticSymbol,
} from '../../language-provider.js';
import { nodeToCapture, walkNamedTree, type SyntaxNode } from '../../utils/ast-helpers.js';

export const OBJECTIVE_C_PROVIDER_VERSION = '0.1.1';
export const OBJECTIVE_C_GRAMMAR_PACKAGE = 'tree-sitter-objc';
export const OBJECTIVE_C_GRAMMAR_VERSION = '3.0.2';

export type ObjCMethodKind = '-' | '+';
export type ObjCContainerKind = 'class' | 'protocol' | 'category' | 'extension';

export interface ObjCTypeInfo {
  readonly kind: 'class' | 'protocol' | 'dynamic' | 'class-object' | 'unknown';
  readonly name?: string;
  readonly raw: string;
}

export interface ObjCContainerFact {
  readonly kind: ObjCContainerKind;
  readonly declarationRole: 'interface' | 'implementation';
  readonly name: string;
  readonly qualifiedName: string;
  readonly nodeId: string;
  readonly label: 'Class' | 'Protocol' | 'Category';
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly superclass?: string;
  readonly protocols: readonly string[];
  readonly hostClass?: string;
  readonly categoryName?: string;
}

export interface ObjCMethodFact {
  readonly name: string;
  readonly selector: string;
  readonly methodKind: ObjCMethodKind;
  readonly ownerQualifiedName: string;
  readonly ownerName: string;
  readonly ownerKind: ObjCContainerKind;
  readonly hostClass?: string;
  readonly qualifiedName: string;
  readonly nodeId: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly declarationRole: 'declaration' | 'implementation';
  readonly returnType?: string;
  readonly parameterTypes: readonly string[];
  readonly parameterNames: readonly string[];
}

export interface ObjCMemberFact {
  readonly kind: 'property' | 'ivar';
  readonly name: string;
  readonly qualifiedName: string;
  readonly nodeId: string;
  readonly ownerQualifiedName: string;
  readonly ownerName: string;
  readonly ownerKind: ObjCContainerKind;
  readonly ownerLabel: 'Class' | 'Protocol' | 'Category';
  readonly hostClass?: string;
  readonly declaredType?: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ObjCFunctionFact {
  readonly name: string;
  readonly qualifiedName: string;
  readonly nodeId: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly returnType?: string;
  readonly parameterTypes: readonly string[];
}

export interface ObjCImportFact {
  readonly kind: 'import' | 'include' | 'module';
  readonly raw: string;
  readonly targetRaw: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ObjCMessageFact {
  readonly selector: string;
  readonly receiverText: string;
  readonly receiverKind:
    | 'self'
    | 'super'
    | 'class'
    | 'local'
    | 'property'
    | 'ivar'
    | 'dynamic'
    | 'unknown';
  readonly receiverType?: ObjCTypeInfo;
  readonly sourceMethodQualifiedName: string;
  readonly sourceMethodId: string;
  readonly sourceOwnerQualifiedName: string;
  readonly sourceOwnerName: string;
  readonly sourceMethodKind: ObjCMethodKind;
  readonly filePath: string;
  readonly startLine: number;
  readonly startCol: number;
}

export interface ObjCUnresolvedMessageFact {
  readonly selector: string;
  readonly receiverText: string;
  readonly reason: string;
  readonly sourceMethodQualifiedName: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly startCol: number;
}

export interface ObjCFileFacts {
  readonly providerVersion: string;
  readonly grammarPackage: string;
  readonly grammarVersion: string;
  readonly filePath: string;
  readonly containers: readonly ObjCContainerFact[];
  readonly methods: readonly ObjCMethodFact[];
  readonly members: readonly ObjCMemberFact[];
  readonly functions: readonly ObjCFunctionFact[];
  readonly imports: readonly ObjCImportFact[];
  readonly messages: readonly ObjCMessageFact[];
  readonly unresolvedMessages: readonly ObjCUnresolvedMessageFact[];
}

export interface ObjCCaptureSideChannel {
  readonly kind: 'objective-c';
  readonly facts: ObjCFileFacts;
}

const factsByFile = new Map<string, ObjCFileFacts>();

export function setObjectiveCFileFacts(facts: ObjCFileFacts): void {
  factsByFile.set(facts.filePath, facts);
}

export function getObjectiveCFileFacts(filePath: string): ObjCFileFacts | undefined {
  return factsByFile.get(filePath);
}

export function collectObjectiveCCaptureSideChannel(
  filePath: string,
): ObjCCaptureSideChannel | undefined {
  const facts = factsByFile.get(filePath);
  return facts === undefined ? undefined : { kind: 'objective-c', facts };
}

export function applyObjectiveCCaptureSideChannel(parsed: ParsedFile): void {
  const payload = parsed.captureSideChannel;
  if (!isObjectiveCSideChannel(payload)) return;
  factsByFile.set(payload.facts.filePath, payload.facts);
}

export function objectiveCFactsFromParsedFiles(
  parsedFiles: readonly ParsedFile[],
): ObjCFileFacts[] {
  const facts: ObjCFileFacts[] = [];
  const seen = new Set<string>();
  for (const parsed of parsedFiles) {
    const payload = parsed.captureSideChannel;
    const fromPayload = isObjectiveCSideChannel(payload) ? payload.facts : undefined;
    const fact = fromPayload ?? factsByFile.get(parsed.filePath);
    if (fact === undefined || seen.has(fact.filePath)) continue;
    seen.add(fact.filePath);
    facts.push(fact);
  }
  return facts;
}

function isObjectiveCSideChannel(value: unknown): value is ObjCCaptureSideChannel {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'objective-c' && record.facts !== null && typeof record.facts === 'object';
}

export const objcClassQualifiedName = (name: string): string => `objc:class:${name}`;
export const objcProtocolQualifiedName = (name: string): string => `objc:protocol:${name}`;
export const objcCategoryQualifiedName = (hostClass: string, categoryName: string): string =>
  `objc:category:${hostClass}:${categoryName}`;
export const objcMethodQualifiedName = (
  ownerQualifiedName: string,
  methodKind: ObjCMethodKind,
  selector: string,
): string => `objc:method:${ownerQualifiedName}:${methodKind}:${selector}`;
export const objcPropertyQualifiedName = (ownerQualifiedName: string, name: string): string =>
  `objc:property:${ownerQualifiedName}:${name}`;
export const objcIvarQualifiedName = (ownerQualifiedName: string, name: string): string =>
  `objc:ivar:${ownerQualifiedName}:${name}`;
export const objcFunctionQualifiedName = (name: string): string => `objc:function:${name}`;

const graphNodeId = (label: NodeLabel, qualifiedName: string): string =>
  generateId(label, qualifiedName);

function ownerLabel(kind: ObjCContainerKind): 'Class' | 'Protocol' | 'Category' {
  return kind === 'class' ? 'Class' : kind === 'protocol' ? 'Protocol' : 'Category';
}

const range = (node: SyntaxNode) => ({
  startLine: node.startPosition.row,
  endLine: node.endPosition.row,
});

function directNamedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null) out.push(child);
  }
  return out;
}

function directChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null) out.push(child);
  }
  return out;
}

function directIdentifiers(node: SyntaxNode): SyntaxNode[] {
  return directNamedChildren(node).filter((child) => child.type === 'identifier');
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('<') && trimmed.endsWith('>'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isSystemHeaderSpelling(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>');
}

function cleanType(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw
    .replace(/^\(/, '')
    .replace(/\)$/, '')
    .replace(/\b(?:nullable|nonnull|__nullable|__nonnull|_Nullable|_Nonnull|const)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return undefined;
  return text;
}

export function parseObjCType(raw: string | undefined): ObjCTypeInfo | undefined {
  const text = cleanType(raw);
  if (text === undefined) return undefined;
  if (text === 'id' || text === 'instancetype') return { kind: 'dynamic', raw: text };
  if (text === 'Class') return { kind: 'class-object', raw: text };

  const protocolMatch = text.match(/^id\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>/);
  if (protocolMatch !== null) {
    return { kind: 'protocol', name: protocolMatch[1], raw: text };
  }

  const classMatch = text.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]+>)?\s*\*?$/);
  if (classMatch !== null) {
    return { kind: 'class', name: classMatch[1], raw: text };
  }
  return { kind: 'unknown', raw: text };
}

function methodKind(node: SyntaxNode): ObjCMethodKind {
  const first = node.child(0)?.text;
  return first === '+' ? '+' : '-';
}

function methodTypeText(node: SyntaxNode): string | undefined {
  const typeNode = directNamedChildren(node).find((child) => child.type === 'method_type');
  return cleanType(typeNode?.text);
}

function methodSelector(node: SyntaxNode): string {
  const children = directChildren(node);
  const keywordDeclarators = children.filter((child) => child.type === 'keyword_declarator');
  if (keywordDeclarators.length > 0) {
    return keywordDeclarators
      .map((declarator) => directIdentifiers(declarator)[0]?.text)
      .filter((name): name is string => name !== undefined)
      .map((name) => `${name}:`)
      .join('');
  }

  const pieces: string[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type !== 'identifier') continue;
    const next = children[i + 1];
    if (next?.type === 'method_parameter') {
      pieces.push(`${child.text}:`);
      continue;
    }
    if (pieces.length === 0) pieces.push(child.text);
  }
  return pieces.join('');
}

function messageSelector(node: SyntaxNode): string {
  const children = directChildren(node);
  const pieces: string[] = [];
  for (let i = 2; i < children.length; i++) {
    const child = children[i];
    if (child.type !== 'identifier' && child.type !== 'field_identifier') continue;
    const next = children[i + 1];
    if (next?.text === ':') pieces.push(`${child.text}:`);
    else if (pieces.length === 0 && next?.text === ']') pieces.push(child.text);
  }
  return pieces.join('');
}

function methodParameterInfo(node: SyntaxNode): {
  parameterTypes: string[];
  parameterNames: string[];
  typeBindings: Map<string, ObjCTypeInfo>;
} {
  const parameterTypes: string[] = [];
  const parameterNames: string[] = [];
  const typeBindings = new Map<string, ObjCTypeInfo>();
  for (const child of directNamedChildren(node)) {
    if (child.type !== 'method_parameter' && child.type !== 'keyword_declarator') continue;
    const named = directNamedChildren(child);
    const typeNode = named.find((n) => n.type === 'method_type');
    const nameNode = [...named].reverse().find((n) => n.type === 'identifier');
    const typeText = cleanType(typeNode?.text);
    if (typeText !== undefined) parameterTypes.push(typeText);
    if (nameNode !== undefined) {
      parameterNames.push(nameNode.text);
      const parsed = parseObjCType(typeText);
      if (parsed !== undefined) typeBindings.set(nameNode.text, parsed);
    }
  }
  return { parameterTypes, parameterNames, typeBindings };
}

function propertyInfo(node: SyntaxNode): { name: string; type?: string } | null {
  const structDecl = directNamedChildren(node).find((child) => child.type === 'struct_declaration');
  if (structDecl === undefined) return null;
  return declarationNameAndType(structDecl);
}

function declarationNameAndType(node: SyntaxNode): { name: string; type?: string } | null {
  const name = declaratorName(node);
  if (name === undefined) return null;
  return { name, type: cleanType(firstTypeNode(node)?.text) };
}

function declaratorName(node: SyntaxNode): string | undefined {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'init_declarator') {
    for (const child of directNamedChildren(node)) {
      const name = declaratorName(child);
      if (name !== undefined) return name;
    }
    return undefined;
  }
  if (
    node.type === 'pointer_declarator' ||
    node.type === 'array_declarator' ||
    node.type === 'function_declarator' ||
    node.type === 'parenthesized_declarator' ||
    node.type === 'struct_declarator'
  ) {
    for (const child of directNamedChildren(node)) {
      const name = declaratorName(child);
      if (name !== undefined) return name;
    }
    return undefined;
  }

  for (const child of directNamedChildren(node)) {
    if (
      child.type === 'init_declarator' ||
      child.type === 'pointer_declarator' ||
      child.type === 'array_declarator' ||
      child.type === 'function_declarator' ||
      child.type === 'parenthesized_declarator' ||
      child.type === 'struct_declarator' ||
      child.type === 'struct_declaration'
    ) {
      const name = declaratorName(child);
      if (name !== undefined) return name;
    }
  }
  return undefined;
}

function firstTypeNode(node: SyntaxNode): SyntaxNode | undefined {
  if (
    node.type === 'type_identifier' ||
    node.type === 'primitive_type' ||
    node.type === 'typedefed_specifier'
  ) {
    return node;
  }
  for (const child of directNamedChildren(node)) {
    const found = firstTypeNode(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function functionInfo(node: SyntaxNode): {
  name: string;
  returnType?: string;
  parameterTypes: string[];
} | null {
  let declarator: SyntaxNode | undefined;
  walkNamedTree(node, (child) => {
    if (declarator === undefined && child.type === 'function_declarator') declarator = child;
  });
  if (declarator === undefined) return null;
  // `int (*callback)(int)` is a function pointer declaration, not a callable
  // definition. A pointer return (`int *func(void)`) remains a C function.
  if (declarator.childForFieldName('declarator')?.type === 'parenthesized_declarator') {
    return null;
  }
  const name = declaratorName(declarator);
  if (name === undefined) return null;
  const returnType = cleanType(
    directNamedChildren(node).find(
      (child) =>
        child.type === 'type_identifier' ||
        child.type === 'primitive_type' ||
        child.type === 'typedefed_specifier',
    )?.text,
  );
  const parameterTypes: string[] = [];
  walkNamedTree(declarator, (child) => {
    if (child.type !== 'parameter_declaration') return;
    const typeNode = directNamedChildren(child).find(
      (n) =>
        n.type === 'type_identifier' ||
        n.type === 'primitive_type' ||
        n.type === 'typedefed_specifier',
    );
    const typeText = cleanType(typeNode?.text);
    if (typeText !== undefined) parameterTypes.push(typeText);
  });
  return { name, returnType, parameterTypes };
}

function directProtocolNames(node: SyntaxNode): string[] {
  const out: string[] = [];
  for (const child of directNamedChildren(node)) {
    if (child.type === 'protocol_reference_list') {
      out.push(...directIdentifiers(child).map((id) => id.text));
    } else if (child.type === 'parameterized_arguments') {
      for (const named of directNamedChildren(child)) {
        if (named.type !== 'type_name') continue;
        const id = directNamedChildren(named).find((n) => n.type === 'type_identifier');
        if (id !== undefined) out.push(id.text);
      }
    }
  }
  return Array.from(new Set(out));
}

function parseContainer(node: SyntaxNode, filePath: string): ObjCContainerFact | null {
  if (
    node.type !== 'class_interface' &&
    node.type !== 'class_implementation' &&
    node.type !== 'protocol_declaration'
  ) {
    return null;
  }
  const ids = directIdentifiers(node);
  const first = ids[0];
  if (first === undefined) return null;
  const { startLine, endLine } = range(node);
  if (node.type === 'protocol_declaration') {
    const qualifiedName = objcProtocolQualifiedName(first.text);
    return {
      kind: 'protocol',
      declarationRole: 'interface',
      name: first.text,
      qualifiedName,
      nodeId: graphNodeId('Protocol', qualifiedName),
      label: 'Protocol',
      filePath,
      startLine,
      endLine,
      protocols: directProtocolNames(node).filter((name) => name !== first.text),
    };
  }

  const children = directChildren(node);
  const openParenIndex = children.findIndex((child) => child.text === '(');
  if (openParenIndex !== -1) {
    const categoryIdentifier = children
      .slice(openParenIndex + 1)
      .find((child) => child.type === 'identifier');
    const categoryName = categoryIdentifier?.text ?? '__extension__';
    const kind: ObjCContainerKind = categoryIdentifier === undefined ? 'extension' : 'category';
    const qualifiedName = objcCategoryQualifiedName(first.text, categoryName);
    return {
      kind,
      declarationRole: node.type === 'class_interface' ? 'interface' : 'implementation',
      name: `${first.text} (${categoryIdentifier?.text ?? ''})`,
      qualifiedName,
      nodeId: graphNodeId('Category', qualifiedName),
      label: 'Category',
      filePath,
      startLine,
      endLine,
      protocols: directProtocolNames(node),
      hostClass: first.text,
      categoryName,
    };
  }

  const colonIndex = children.findIndex((child) => child.text === ':');
  const superclass =
    colonIndex !== -1
      ? children.slice(colonIndex + 1).find((child) => child.type === 'identifier')?.text
      : undefined;
  const qualifiedName = objcClassQualifiedName(first.text);
  return {
    kind: 'class',
    declarationRole: node.type === 'class_interface' ? 'interface' : 'implementation',
    name: first.text,
    qualifiedName,
    nodeId: graphNodeId('Class', qualifiedName),
    label: 'Class',
    filePath,
    startLine,
    endLine,
    ...(superclass !== undefined ? { superclass } : {}),
    protocols: directProtocolNames(node),
  };
}

function collectLocalTypes(methodNode: SyntaxNode): Map<string, ObjCTypeInfo> {
  const locals = new Map<string, ObjCTypeInfo>();
  walkNamedTree(methodNode, (node) => {
    if (node.type !== 'declaration' && node.type !== 'parameter_declaration') return;
    const info = declarationNameAndType(node);
    if (info === null) return;
    const typeInfo = parseObjCType(info.type);
    if (typeInfo !== undefined) locals.set(info.name, typeInfo);
  });
  return locals;
}

function isReflectionSelector(selector: string, receiverText: string): boolean {
  return (
    selector.startsWith('performSelector:') ||
    selector === 'methodForSelector:' ||
    selector === 'forwardInvocation:' ||
    receiverText === 'NSInvocation'
  );
}

function isPascalCaseLike(text: string): boolean {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(text)) return false;
  return text.length === 1 || /[a-z0-9]/.test(text.slice(1));
}

function messageReceiver(node: SyntaxNode): SyntaxNode | null {
  return directNamedChildren(node)[0] ?? null;
}

function macroName(node: SyntaxNode): string | undefined {
  return node.childForFieldName('name')?.text ?? directIdentifiers(node)[0]?.text;
}

function classifyReceiver(
  receiver: SyntaxNode,
  selector: string,
  method: ObjCMethodFact,
  methodTypes: ReadonlyMap<string, ObjCTypeInfo>,
  membersByOwner: ReadonlyMap<string, Map<string, ObjCTypeInfo>>,
  macroNames: ReadonlySet<string>,
  classNames: ReadonlySet<string>,
): {
  kind: ObjCMessageFact['receiverKind'];
  type?: ObjCTypeInfo;
  unresolvedReason?: string;
} {
  const text = receiver.text;
  if (isReflectionSelector(selector, text)) {
    return {
      kind: 'dynamic',
      unresolvedReason: 'reflection selector dispatch is dynamic',
    };
  }
  const receiverMacroName =
    receiver.type === 'call_expression'
      ? receiver.childForFieldName('function')?.text
      : receiver.type === 'identifier'
        ? text
        : undefined;
  if (receiverMacroName !== undefined && macroNames.has(receiverMacroName)) {
    return {
      kind: 'dynamic',
      type: { kind: 'dynamic', raw: text },
      unresolvedReason: `macro receiver ${receiverMacroName} is dynamic`,
    };
  }
  if (receiver.type === 'identifier') {
    if (text === 'self') return { kind: 'self' };
    if (text === 'super') return { kind: 'super' };
    const bound = methodTypes.get(text);
    if (bound !== undefined) {
      if (bound.kind === 'dynamic' || bound.kind === 'class-object') {
        return {
          kind: 'dynamic',
          type: bound,
          unresolvedReason: `${bound.raw} receiver is dynamic`,
        };
      }
      return { kind: 'local', type: bound };
    }
    const hostOwner =
      method.hostClass !== undefined
        ? objcClassQualifiedName(method.hostClass)
        : method.ownerQualifiedName;
    const memberType = membersByOwner.get(hostOwner)?.get(text);
    if (memberType !== undefined) return { kind: 'ivar', type: memberType };
    if (classNames.has(text) || isPascalCaseLike(text)) {
      return { kind: 'class', type: { kind: 'class', name: text, raw: text } };
    }
    return { kind: 'unknown', unresolvedReason: 'receiver type is unknown' };
  }

  if (receiver.type === 'field_expression') {
    const parts = directNamedChildren(receiver);
    const base = parts[0];
    const field = parts[1];
    if (base?.text === 'self' && field !== undefined) {
      const hostOwner =
        method.hostClass !== undefined
          ? objcClassQualifiedName(method.hostClass)
          : method.ownerQualifiedName;
      const memberType = membersByOwner.get(hostOwner)?.get(field.text);
      if (memberType !== undefined) return { kind: 'property', type: memberType };
      return {
        kind: 'property',
        unresolvedReason: `property ${field.text} has no static type`,
      };
    }
  }
  return {
    kind: 'unknown',
    unresolvedReason: 'receiver expression is not statically typed',
  };
}

export function collectObjectiveCFacts(tree: Parser.Tree, filePath: string): ObjCFileFacts {
  const containers: ObjCContainerFact[] = [];
  const methods: ObjCMethodFact[] = [];
  const members: ObjCMemberFact[] = [];
  const functions: ObjCFunctionFact[] = [];
  const imports: ObjCImportFact[] = [];
  const messages: ObjCMessageFact[] = [];
  const unresolvedMessages: ObjCUnresolvedMessageFact[] = [];
  const membersByOwner = new Map<string, Map<string, ObjCTypeInfo>>();
  const macroNames = new Set<string>();
  const classNames = new Set<string>();

  const addFunctionFact = (node: SyntaxNode): void => {
    const info = functionInfo(node);
    if (info === null) return;
    const qualifiedName = objcFunctionQualifiedName(info.name);
    const { startLine, endLine } = range(node);
    functions.push({
      name: info.name,
      qualifiedName,
      nodeId: graphNodeId('Function', qualifiedName),
      filePath,
      startLine,
      endLine,
      ...(info.returnType !== undefined ? { returnType: info.returnType } : {}),
      parameterTypes: info.parameterTypes,
    });
  };

  walkNamedTree(tree.rootNode, (node) => {
    if (node.type !== 'preproc_def' && node.type !== 'preproc_function_def') return;
    const name = macroName(node);
    if (name !== undefined) macroNames.add(name);
  });

  walkNamedTree(tree.rootNode, (node) => {
    const container = parseContainer(node, filePath);
    if (container?.kind === 'class') classNames.add(container.name);
  });

  const addMemberType = (
    ownerQualifiedName: string,
    name: string,
    typeText: string | undefined,
  ) => {
    const typeInfo = parseObjCType(typeText);
    if (typeInfo === undefined) return;
    let byName = membersByOwner.get(ownerQualifiedName);
    if (byName === undefined) {
      byName = new Map<string, ObjCTypeInfo>();
      membersByOwner.set(ownerQualifiedName, byName);
    }
    byName.set(name, typeInfo);
  };

  const collectContainerMemberTypes = (
    containerNode: Parser.SyntaxNode,
    container: ObjCContainerFact,
  ): void => {
    for (const inner of directNamedChildren(containerNode)) {
      if (inner.type === 'property_declaration') {
        const prop = propertyInfo(inner);
        if (prop === null) continue;
        addMemberType(container.qualifiedName, prop.name, prop.type);
        if (container.hostClass !== undefined) {
          addMemberType(objcClassQualifiedName(container.hostClass), prop.name, prop.type);
        }
      } else if (inner.type === 'instance_variables') {
        walkNamedTree(inner, (ivarNode) => {
          if (ivarNode.type !== 'instance_variable') return;
          const ivar = declarationNameAndType(ivarNode);
          if (ivar === null) return;
          addMemberType(container.qualifiedName, ivar.name, ivar.type);
          if (container.hostClass !== undefined) {
            addMemberType(objcClassQualifiedName(container.hostClass), ivar.name, ivar.type);
          }
        });
      }
    }
  };

  for (const child of directNamedChildren(tree.rootNode)) {
    const container = parseContainer(child, filePath);
    if (container !== null) collectContainerMemberTypes(child, container);
  }

  for (const child of directNamedChildren(tree.rootNode)) {
    if (child.type === 'preproc_include') {
      const rawNode = directNamedChildren(child).find(
        (n) => n.type === 'string_literal' || n.type === 'system_lib_string',
      );
      if (rawNode !== undefined) {
        const raw = rawNode.text;
        const directive = child.text.trimStart().startsWith('#include') ? 'include' : 'import';
        const { startLine, endLine } = range(child);
        imports.push({
          kind: directive,
          raw,
          targetRaw: stripQuotes(raw),
          filePath,
          startLine,
          endLine,
        });
      }
      continue;
    }
    if (child.type === 'module_import') {
      const moduleName = directIdentifiers(child)
        .map((n) => n.text)
        .join('.');
      const { startLine, endLine } = range(child);
      imports.push({
        kind: 'module',
        raw: moduleName,
        targetRaw: moduleName,
        filePath,
        startLine,
        endLine,
      });
      continue;
    }

    const container = parseContainer(child, filePath);
    if (container !== null) {
      containers.push(container);
      for (const inner of directNamedChildren(child)) {
        if (inner.type === 'method_declaration' || inner.type === 'method_definition') {
          const selector = methodSelector(inner);
          const { parameterTypes, parameterNames, typeBindings } = methodParameterInfo(inner);
          const kind = methodKind(inner);
          const qualifiedName = objcMethodQualifiedName(container.qualifiedName, kind, selector);
          const { startLine, endLine } = range(inner);
          const method: ObjCMethodFact = {
            name: selector,
            selector,
            methodKind: kind,
            ownerQualifiedName: container.qualifiedName,
            ownerName: container.name,
            ownerKind: container.kind,
            ...(container.hostClass !== undefined ? { hostClass: container.hostClass } : {}),
            qualifiedName,
            nodeId: graphNodeId('Method', qualifiedName),
            filePath,
            startLine,
            endLine,
            declarationRole: inner.type === 'method_definition' ? 'implementation' : 'declaration',
            ...(methodTypeText(inner) !== undefined ? { returnType: methodTypeText(inner) } : {}),
            parameterTypes,
            parameterNames,
          };
          methods.push(method);

          const methodTypes = new Map<string, ObjCTypeInfo>([
            ...typeBindings,
            ...collectLocalTypes(inner),
          ]);
          walkNamedTree(inner, (messageNode) => {
            if (messageNode.type !== 'message_expression') return;
            const receiver = messageReceiver(messageNode);
            if (receiver === null) return;
            const messageSel = messageSelector(messageNode);
            if (messageSel.length === 0) return;
            const classified = classifyReceiver(
              receiver,
              messageSel,
              method,
              methodTypes,
              membersByOwner,
              macroNames,
              classNames,
            );
            const fact: ObjCMessageFact = {
              selector: messageSel,
              receiverText: receiver.text,
              receiverKind: classified.kind,
              ...(classified.type !== undefined ? { receiverType: classified.type } : {}),
              sourceMethodQualifiedName: method.qualifiedName,
              sourceMethodId: method.nodeId,
              sourceOwnerQualifiedName: method.ownerQualifiedName,
              sourceOwnerName: method.ownerName,
              sourceMethodKind: method.methodKind,
              filePath,
              startLine: messageNode.startPosition.row,
              startCol: messageNode.startPosition.column,
            };
            if (classified.unresolvedReason !== undefined) {
              unresolvedMessages.push({
                selector: messageSel,
                receiverText: receiver.text,
                reason: classified.unresolvedReason,
                sourceMethodQualifiedName: method.qualifiedName,
                filePath,
                startLine: messageNode.startPosition.row,
                startCol: messageNode.startPosition.column,
              });
            }
            messages.push(fact);
          });
        } else if (inner.type === 'property_declaration') {
          const prop = propertyInfo(inner);
          if (prop === null) continue;
          const qualifiedName = objcPropertyQualifiedName(container.qualifiedName, prop.name);
          const { startLine, endLine } = range(inner);
          members.push({
            kind: 'property',
            name: prop.name,
            qualifiedName,
            nodeId: graphNodeId('Property', qualifiedName),
            ownerQualifiedName: container.qualifiedName,
            ownerName: container.name,
            ownerKind: container.kind,
            ownerLabel: ownerLabel(container.kind),
            ...(container.hostClass !== undefined ? { hostClass: container.hostClass } : {}),
            ...(prop.type !== undefined ? { declaredType: prop.type } : {}),
            filePath,
            startLine,
            endLine,
          });
        } else if (inner.type === 'instance_variables') {
          walkNamedTree(inner, (ivarNode) => {
            if (ivarNode.type !== 'instance_variable') return;
            const ivar = declarationNameAndType(ivarNode);
            if (ivar === null) return;
            const qualifiedName = objcIvarQualifiedName(container.qualifiedName, ivar.name);
            const { startLine, endLine } = range(ivarNode);
            members.push({
              kind: 'ivar',
              name: ivar.name,
              qualifiedName,
              nodeId: graphNodeId('Variable', qualifiedName),
              ownerQualifiedName: container.qualifiedName,
              ownerName: container.name,
              ownerKind: container.kind,
              ownerLabel: ownerLabel(container.kind),
              ...(container.hostClass !== undefined ? { hostClass: container.hostClass } : {}),
              ...(ivar.type !== undefined ? { declaredType: ivar.type } : {}),
              filePath,
              startLine,
              endLine,
            });
          });
        } else if (inner.type === 'implementation_definition') {
          const functionNode = directNamedChildren(inner).find(
            (node) => node.type === 'function_definition',
          );
          if (functionNode !== undefined) {
            addFunctionFact(functionNode);
            continue;
          }
          const methodNode = directNamedChildren(inner).find((n) => n.type === 'method_definition');
          if (methodNode !== undefined) {
            const selector = methodSelector(methodNode);
            const { parameterTypes, parameterNames, typeBindings } =
              methodParameterInfo(methodNode);
            const kind = methodKind(methodNode);
            const qualifiedName = objcMethodQualifiedName(container.qualifiedName, kind, selector);
            const { startLine, endLine } = range(methodNode);
            const method: ObjCMethodFact = {
              name: selector,
              selector,
              methodKind: kind,
              ownerQualifiedName: container.qualifiedName,
              ownerName: container.name,
              ownerKind: container.kind,
              ...(container.hostClass !== undefined ? { hostClass: container.hostClass } : {}),
              qualifiedName,
              nodeId: graphNodeId('Method', qualifiedName),
              filePath,
              startLine,
              endLine,
              declarationRole: 'implementation',
              ...(methodTypeText(methodNode) !== undefined
                ? { returnType: methodTypeText(methodNode) }
                : {}),
              parameterTypes,
              parameterNames,
            };
            methods.push(method);
            const methodTypes = new Map<string, ObjCTypeInfo>([
              ...typeBindings,
              ...collectLocalTypes(methodNode),
            ]);
            walkNamedTree(methodNode, (messageNode) => {
              if (messageNode.type !== 'message_expression') return;
              const receiver = messageReceiver(messageNode);
              if (receiver === null) return;
              const messageSel = messageSelector(messageNode);
              if (messageSel.length === 0) return;
              const classified = classifyReceiver(
                receiver,
                messageSel,
                method,
                methodTypes,
                membersByOwner,
                macroNames,
                classNames,
              );
              const fact: ObjCMessageFact = {
                selector: messageSel,
                receiverText: receiver.text,
                receiverKind: classified.kind,
                ...(classified.type !== undefined ? { receiverType: classified.type } : {}),
                sourceMethodQualifiedName: method.qualifiedName,
                sourceMethodId: method.nodeId,
                sourceOwnerQualifiedName: method.ownerQualifiedName,
                sourceOwnerName: method.ownerName,
                sourceMethodKind: method.methodKind,
                filePath,
                startLine: messageNode.startPosition.row,
                startCol: messageNode.startPosition.column,
              };
              if (classified.unresolvedReason !== undefined) {
                unresolvedMessages.push({
                  selector: messageSel,
                  receiverText: receiver.text,
                  reason: classified.unresolvedReason,
                  sourceMethodQualifiedName: method.qualifiedName,
                  filePath,
                  startLine: messageNode.startPosition.row,
                  startCol: messageNode.startPosition.column,
                });
              }
              messages.push(fact);
            });
          }
        }
      }
      continue;
    }

    if (child.type === 'function_definition' || child.type === 'declaration') {
      addFunctionFact(child);
    }
  }

  return {
    providerVersion: OBJECTIVE_C_PROVIDER_VERSION,
    grammarPackage: OBJECTIVE_C_GRAMMAR_PACKAGE,
    grammarVersion: OBJECTIVE_C_GRAMMAR_VERSION,
    filePath,
    containers,
    methods,
    members,
    functions,
    imports,
    messages,
    unresolvedMessages,
  };
}

function semanticNode(
  label: NodeLabel,
  id: string,
  name: string,
  qualifiedName: string,
  filePath: string,
  startLine: number,
  endLine: number,
  extras: Record<string, unknown> = {},
): ProviderSemanticNode {
  return {
    id,
    label,
    properties: {
      name,
      filePath,
      startLine,
      endLine,
      language: SupportedLanguages.ObjectiveC,
      isExported: true,
      qualifiedName,
      objectiveCProviderVersion: OBJECTIVE_C_PROVIDER_VERSION,
      objectiveCGrammar: `${OBJECTIVE_C_GRAMMAR_PACKAGE}@${OBJECTIVE_C_GRAMMAR_VERSION}`,
      ...extras,
    },
  };
}

function relationship(
  type: 'DEFINES' | 'DECLARES' | 'HAS_METHOD' | 'HAS_PROPERTY',
  sourceId: string,
  targetId: string,
  reason: string,
): ProviderSemanticRelationship {
  return {
    id: generateId(type, `${sourceId}->${targetId}:${reason}`),
    sourceId,
    targetId,
    type,
    confidence: 1,
    reason,
  };
}

function implementationEvidenceNode(
  qualifiedName: string,
  name: string,
  filePath: string,
  startLine: number,
  endLine: number,
  extras: Record<string, unknown>,
): ProviderSemanticNode {
  return semanticNode(
    'CodeElement',
    graphNodeId('CodeElement', qualifiedName),
    name,
    qualifiedName,
    filePath,
    startLine,
    endLine,
    {
      objectiveCKind: 'implementation-evidence',
      ...extras,
    },
  );
}

export function buildObjectiveCSemanticGraph(facts: ObjCFileFacts): ProviderSemanticGraph {
  const nodes: ProviderSemanticNode[] = [];
  const relationships: ProviderSemanticRelationship[] = [];
  const symbols: ProviderSemanticSymbol[] = [];
  const fileId = generateId('File', facts.filePath);

  for (const container of facts.containers) {
    nodes.push(
      semanticNode(
        container.label,
        container.nodeId,
        container.name,
        container.qualifiedName,
        facts.filePath,
        container.startLine,
        container.endLine,
        {
          objectiveCKind: container.kind,
          declarationRole: container.declarationRole,
          ...(container.superclass !== undefined ? { superclass: container.superclass } : {}),
          ...(container.protocols.length > 0 ? { protocols: [...container.protocols] } : {}),
          ...(container.hostClass !== undefined ? { hostClass: container.hostClass } : {}),
          ...(container.categoryName !== undefined ? { categoryName: container.categoryName } : {}),
        },
      ),
    );
    relationships.push(relationship('DEFINES', fileId, container.nodeId, 'objc-definition'));
    if (container.declarationRole === 'implementation') {
      const qualifiedName = `objc:implementation:${container.qualifiedName}:${facts.filePath}:${container.startLine}`;
      const evidenceId = graphNodeId('CodeElement', qualifiedName);
      nodes.push(
        implementationEvidenceNode(
          qualifiedName,
          `@implementation ${container.name}`,
          facts.filePath,
          container.startLine,
          container.endLine,
          {
            implementationKind: container.kind,
            targetQualifiedName: container.qualifiedName,
          },
        ),
      );
      relationships.push(
        relationship('DEFINES', fileId, evidenceId, 'objc: implementation evidence'),
      );
      relationships.push(
        relationship(
          'DECLARES',
          evidenceId,
          container.nodeId,
          'objc: implementation of merged symbol',
        ),
      );
    }
    symbols.push({
      filePath: facts.filePath,
      name: container.name,
      nodeId: container.nodeId,
      type: container.label,
      qualifiedName: container.qualifiedName,
    });
  }

  for (const method of facts.methods) {
    nodes.push(
      semanticNode(
        'Method',
        method.nodeId,
        method.selector,
        method.qualifiedName,
        facts.filePath,
        method.startLine,
        method.endLine,
        {
          selector: method.selector,
          methodKind: method.methodKind,
          objectiveCOwner: method.ownerQualifiedName,
          objectiveCOwnerName: method.ownerName,
          description: `${method.ownerName} ${method.methodKind}${method.selector}`,
          declarationRole: method.declarationRole,
          parameterCount: method.parameterTypes.length,
          parameterTypes: [...method.parameterTypes],
          ...(method.returnType !== undefined ? { returnType: method.returnType } : {}),
          ...(method.hostClass !== undefined ? { hostClass: method.hostClass } : {}),
        },
      ),
    );
    const ownerId = graphNodeId(
      method.ownerKind === 'class'
        ? 'Class'
        : method.ownerKind === 'protocol'
          ? 'Protocol'
          : 'Category',
      method.ownerQualifiedName,
    );
    relationships.push(relationship('HAS_METHOD', ownerId, method.nodeId, 'objc-owner-method'));
    if (method.declarationRole === 'implementation') {
      const qualifiedName = `objc:method-implementation:${method.qualifiedName}:${facts.filePath}:${method.startLine}`;
      const evidenceId = graphNodeId('CodeElement', qualifiedName);
      nodes.push(
        implementationEvidenceNode(
          qualifiedName,
          `${method.methodKind}[${method.ownerName} ${method.selector}] implementation`,
          facts.filePath,
          method.startLine,
          method.endLine,
          {
            implementationKind: 'method',
            targetQualifiedName: method.qualifiedName,
            selector: method.selector,
            methodKind: method.methodKind,
            objectiveCOwner: method.ownerQualifiedName,
          },
        ),
      );
      relationships.push(
        relationship('DEFINES', fileId, evidenceId, 'objc: implementation evidence'),
      );
      relationships.push(
        relationship(
          'DECLARES',
          evidenceId,
          method.nodeId,
          'objc: implementation of merged symbol',
        ),
      );
    }
    if (method.hostClass !== undefined) {
      relationships.push(
        relationship(
          'HAS_METHOD',
          graphNodeId('Class', objcClassQualifiedName(method.hostClass)),
          method.nodeId,
          'objc-category-host-method',
        ),
      );
    }
    symbols.push({
      filePath: facts.filePath,
      name: method.selector,
      nodeId: method.nodeId,
      type: 'Method',
      qualifiedName: method.qualifiedName,
      parameterCount: method.parameterTypes.length,
      requiredParameterCount: method.parameterTypes.length,
      parameterTypes: [...method.parameterTypes],
      ...(method.returnType !== undefined ? { returnType: method.returnType } : {}),
      ownerId,
      isStatic: method.methodKind === '+',
    });
  }

  for (const member of facts.members) {
    const label: NodeLabel = member.kind === 'property' ? 'Property' : 'Variable';
    nodes.push(
      semanticNode(
        label,
        member.nodeId,
        member.name,
        member.qualifiedName,
        facts.filePath,
        member.startLine,
        member.endLine,
        {
          objectiveCKind: member.kind,
          ...(member.declaredType !== undefined ? { declaredType: member.declaredType } : {}),
        },
      ),
    );
    relationships.push(
      relationship(
        member.kind === 'property' ? 'HAS_PROPERTY' : 'HAS_PROPERTY',
        graphNodeId(member.ownerLabel, member.ownerQualifiedName),
        member.nodeId,
        `objc-${member.kind}`,
      ),
    );
    if (member.hostClass !== undefined) {
      relationships.push(
        relationship(
          'HAS_PROPERTY',
          graphNodeId('Class', objcClassQualifiedName(member.hostClass)),
          member.nodeId,
          `objc-category-host-${member.kind}`,
        ),
      );
    }
    symbols.push({
      filePath: facts.filePath,
      name: member.name,
      nodeId: member.nodeId,
      type: label,
      qualifiedName: member.qualifiedName,
      ...(member.declaredType !== undefined ? { declaredType: member.declaredType } : {}),
      ownerId: graphNodeId(member.ownerLabel, member.ownerQualifiedName),
    });
  }

  for (const fn of facts.functions) {
    nodes.push(
      semanticNode(
        'Function',
        fn.nodeId,
        fn.name,
        fn.qualifiedName,
        facts.filePath,
        fn.startLine,
        fn.endLine,
        {
          parameterCount: fn.parameterTypes.length,
          parameterTypes: [...fn.parameterTypes],
          ...(fn.returnType !== undefined ? { returnType: fn.returnType } : {}),
        },
      ),
    );
    relationships.push(relationship('DEFINES', fileId, fn.nodeId, 'objc-c-function'));
    symbols.push({
      filePath: facts.filePath,
      name: fn.name,
      nodeId: fn.nodeId,
      type: 'Function',
      qualifiedName: fn.qualifiedName,
      parameterCount: fn.parameterTypes.length,
      parameterTypes: [...fn.parameterTypes],
      ...(fn.returnType !== undefined ? { returnType: fn.returnType } : {}),
    });
  }

  for (const imp of facts.imports) {
    const qualifiedName = `objc:import:${facts.filePath}:${imp.startLine}:${imp.kind}:${imp.targetRaw}`;
    const id = graphNodeId('Import', qualifiedName);
    nodes.push(
      semanticNode(
        'Import',
        id,
        imp.targetRaw,
        qualifiedName,
        facts.filePath,
        imp.startLine,
        imp.endLine,
        {
          objectiveCKind: 'import',
          importKind: imp.kind,
          raw: imp.raw,
          targetRaw: imp.targetRaw,
        },
      ),
    );
    relationships.push(relationship('DEFINES', fileId, id, 'objc-import'));
    symbols.push({
      filePath: facts.filePath,
      name: imp.targetRaw,
      nodeId: id,
      type: 'Import',
      qualifiedName,
    });
  }

  for (const unresolved of facts.unresolvedMessages) {
    const qn = `objc:unresolved:${facts.filePath}:${unresolved.startLine}:${unresolved.startCol}:${unresolved.selector}`;
    const id = graphNodeId('CodeElement', qn);
    nodes.push(
      semanticNode(
        'CodeElement',
        id,
        `[${unresolved.receiverText} ${unresolved.selector}]`,
        qn,
        facts.filePath,
        unresolved.startLine,
        unresolved.startLine,
        {
          objectiveCKind: 'unresolved-message',
          selector: unresolved.selector,
          receiver: unresolved.receiverText,
          resolution: 'unresolved',
          reason: unresolved.reason,
          sourceMethod: unresolved.sourceMethodQualifiedName,
        },
      ),
    );
    relationships.push(relationship('DEFINES', fileId, id, 'objc-unresolved-message'));
    symbols.push({
      filePath: facts.filePath,
      name: `[${unresolved.receiverText} ${unresolved.selector}]`,
      nodeId: id,
      type: 'CodeElement',
      qualifiedName: qn,
    });
  }

  return { nodes, relationships, symbols };
}

function captureAt(name: string, text: string, startLine: number, endLine: number): Capture {
  return {
    name,
    text,
    range: {
      startLine: startLine + 1,
      startCol: 0,
      endLine: endLine + 1,
      endCol: 0,
    },
  };
}

export function buildObjectiveCScopeCaptures(
  facts: ObjCFileFacts,
  root: SyntaxNode,
): readonly CaptureMatch[] {
  const captures: CaptureMatch[] = [
    {
      '@scope.module': nodeToCapture('@scope.module', root),
    },
  ];

  for (const imp of facts.imports) {
    const anchor = captureAt('@import.statement', imp.raw, imp.startLine, imp.endLine);
    const sourceText = isSystemHeaderSpelling(imp.raw) ? imp.raw : imp.targetRaw;
    captures.push({
      '@import.statement': anchor,
      '@import.source': {
        ...anchor,
        name: '@import.source',
        text: sourceText,
      },
      '@import.name': { ...anchor, name: '@import.name', text: sourceText },
      '@import.kind': { ...anchor, name: '@import.kind', text: imp.kind },
    });
  }

  return captures;
}
