import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { simpleQualifiedName } from '../../scope-resolution/graph-bridge/ids.js';

type MethodSet = ReadonlyMap<string, readonly SymbolDefinition[]>;
type MutableMethodSet = Map<string, SymbolDefinition[]>;
type GoMethodDefinition = SymbolDefinition & { readonly goReceiverKind?: 'value' | 'pointer' };
type SignatureContext = {
  readonly packageQualifier: string | undefined;
  readonly importQualifiers: ReadonlyMap<string, string>;
};

export function detectGoInterfaceImplementations(
  parsedFiles: readonly ParsedFile[],
  _indexes: ScopeResolutionIndexes,
  _model: SemanticModel,
): Map<string, string[]> {
  const interfaces: SymbolDefinition[] = [];
  const structs: SymbolDefinition[] = [];
  const methodsByOwner = new Map<string, Map<string, SymbolDefinition[]>>();
  const interfaceById = new Map<string, SymbolDefinition>();
  const signatureContextByDefId = new Map<string, SignatureContext>();

  for (const parsed of parsedFiles) {
    const signatureContext = signatureContextForFile(parsed, _indexes);
    for (const def of parsed.localDefs) {
      signatureContextByDefId.set(def.nodeId, signatureContext);
      if (def.type === 'Interface') {
        interfaces.push(def);
        interfaceById.set(def.nodeId, def);
        continue;
      }
      if (def.type === 'Struct') {
        structs.push(def);
        continue;
      }
      if (def.type !== 'Method' && def.type !== 'Function') continue;
      if (def.ownerId === undefined) continue;
      if (isPointerReceiverMethod(def)) continue;
      const methodName = simpleQualifiedName(def);
      if (methodName === undefined || methodName.length === 0) continue;

      let methods = methodsByOwner.get(def.ownerId);
      if (methods === undefined) {
        methods = new Map<string, SymbolDefinition[]>();
        methodsByOwner.set(def.ownerId, methods);
      }
      const overloads = methods.get(methodName) ?? [];
      overloads.push(def);
      methods.set(methodName, overloads);
    }
  }

  const implementations = new Map<string, string[]>();
  for (const iface of interfaces) {
    const required = collectInterfaceMethodSet(
      iface,
      parsedFiles,
      methodsByOwner,
      interfaceById,
      new Set(),
    );
    if (required === undefined || required.size === 0) continue;
    if (!methodSetHasVerifiableSignatures(required)) continue;

    const implementors: string[] = [];
    for (const struct of structs) {
      const actual = methodsByOwner.get(struct.nodeId);
      if (actual === undefined) continue;
      if (methodSetSatisfies(actual, required, signatureContextByDefId)) {
        implementors.push(struct.nodeId);
      }
    }
    if (implementors.length > 0) implementations.set(iface.nodeId, implementors);
  }

  return implementations;
}

function collectInterfaceScopeMethods(
  iface: SymbolDefinition,
  parsedFiles: readonly ParsedFile[],
): MutableMethodSet | undefined {
  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      if (!scope.ownedDefs.some((def) => def.nodeId === iface.nodeId)) continue;
      const methods = new Map<string, SymbolDefinition[]>();
      for (const childScope of parsed.scopes) {
        if (childScope.parent !== scope.id) continue;
        for (const def of childScope.ownedDefs) {
          if (def.type !== 'Method' && def.type !== 'Function') continue;
          const methodName = simpleQualifiedName(def);
          if (methodName === undefined || methodName.length === 0) continue;
          const overloads = methods.get(methodName) ?? [];
          overloads.push(def);
          methods.set(methodName, overloads);
        }
      }
      return methods;
    }
  }
  return undefined;
}

function collectInterfaceMethodSet(
  iface: SymbolDefinition,
  parsedFiles: readonly ParsedFile[],
  methodsByOwner: ReadonlyMap<string, MethodSet>,
  interfaceById: ReadonlyMap<string, SymbolDefinition>,
  visiting: Set<string>,
): MutableMethodSet | undefined {
  if (visiting.has(iface.nodeId)) return undefined;
  visiting.add(iface.nodeId);

  const ownMethods =
    methodsByOwner.get(iface.nodeId) ?? collectInterfaceScopeMethods(iface, parsedFiles);
  const merged = cloneMethodSet(ownMethods);

  const embeddedInterfaces = embeddedInterfacesFor(iface, parsedFiles, interfaceById);
  if (embeddedInterfaces === undefined) {
    visiting.delete(iface.nodeId);
    return undefined;
  }

  for (const embeddedIface of embeddedInterfaces) {
    const embeddedMethods = collectInterfaceMethodSet(
      embeddedIface,
      parsedFiles,
      methodsByOwner,
      interfaceById,
      visiting,
    );
    if (embeddedMethods === undefined) {
      visiting.delete(iface.nodeId);
      return undefined;
    }
    mergeMethodSet(merged, embeddedMethods);
  }

  visiting.delete(iface.nodeId);
  return merged;
}

function embeddedInterfacesFor(
  iface: SymbolDefinition,
  parsedFiles: readonly ParsedFile[],
  interfaceById: ReadonlyMap<string, SymbolDefinition>,
): SymbolDefinition[] | undefined {
  const ifaceScopes = new Set<string>();
  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      if (scope.ownedDefs.some((def) => def.nodeId === iface.nodeId)) {
        ifaceScopes.add(scope.id);
      }
    }
  }
  if (ifaceScopes.size === 0) return [];

  const embedded: SymbolDefinition[] = [];
  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'inherits') continue;
      if (!ifaceScopes.has(site.inScope)) continue;
      const resolved = resolveEmbeddedInterface(site.name, interfaceById);
      if (resolved === undefined) return undefined;
      embedded.push(resolved);
    }
  }
  return embedded;
}

function resolveEmbeddedInterface(
  name: string,
  interfaceById: ReadonlyMap<string, SymbolDefinition>,
): SymbolDefinition | undefined {
  const simpleName = simpleTypeName(name);
  const matches: SymbolDefinition[] = [];
  for (const iface of interfaceById.values()) {
    if (iface.qualifiedName === name || iface.qualifiedName === simpleName) {
      matches.push(iface);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function simpleTypeName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

function cloneMethodSet(methods: MethodSet | undefined): MutableMethodSet {
  const clone = new Map<string, SymbolDefinition[]>();
  if (methods === undefined) return clone;
  for (const [name, overloads] of methods) {
    clone.set(name, [...overloads]);
  }
  return clone;
}

function mergeMethodSet(target: MutableMethodSet, source: MethodSet): void {
  for (const [name, overloads] of source) {
    const existing = target.get(name) ?? [];
    existing.push(...overloads);
    target.set(name, existing);
  }
}

function methodSetSatisfies(
  actual: MethodSet,
  required: MethodSet,
  signatureContextByDefId: ReadonlyMap<string, SignatureContext>,
): boolean {
  for (const [name, requiredOverloads] of required) {
    const actualOverloads = actual.get(name);
    if (actualOverloads === undefined) return false;
    for (const requiredMethod of requiredOverloads) {
      if (!hasCompatibleMethod(actualOverloads, requiredMethod, signatureContextByDefId)) {
        return false;
      }
    }
  }
  return true;
}

function hasCompatibleMethod(
  actualOverloads: readonly SymbolDefinition[],
  requiredMethod: SymbolDefinition,
  signatureContextByDefId: ReadonlyMap<string, SignatureContext>,
): boolean {
  if (!hasVerifiableSignature(requiredMethod)) return false;
  return actualOverloads.some((actualMethod) =>
    signaturesCompatible(actualMethod, requiredMethod, signatureContextByDefId),
  );
}

function methodSetHasVerifiableSignatures(methods: MethodSet): boolean {
  for (const overloads of methods.values()) {
    if (!overloads.some(hasVerifiableSignature)) return false;
  }
  return true;
}

function isPointerReceiverMethod(def: SymbolDefinition): boolean {
  return (def as GoMethodDefinition).goReceiverKind === 'pointer';
}

function hasVerifiableSignature(def: SymbolDefinition): boolean {
  return (
    def.parameterCount !== undefined ||
    def.requiredParameterCount !== undefined ||
    (def.parameterTypes !== undefined && def.parameterTypes.length > 0) ||
    def.returnType !== undefined
  );
}

function signaturesCompatible(
  actual: SymbolDefinition,
  required: SymbolDefinition,
  signatureContextByDefId: ReadonlyMap<string, SignatureContext>,
): boolean {
  const actualContext = signatureContextByDefId.get(actual.nodeId);
  const requiredContext = signatureContextByDefId.get(required.nodeId);
  return (
    countsCompatible(actual.parameterCount, required.parameterCount) &&
    countsCompatible(actual.requiredParameterCount, required.requiredParameterCount) &&
    parameterTypesCompatible(
      actual.parameterTypes,
      required.parameterTypes,
      actualContext,
      requiredContext,
    ) &&
    returnTypesCompatible(actual.returnType, required.returnType, actualContext, requiredContext)
  );
}

function countsCompatible(actual: number | undefined, required: number | undefined): boolean {
  return actual === undefined || required === undefined || actual === required;
}

function parameterTypesCompatible(
  actual: readonly string[] | undefined,
  required: readonly string[] | undefined,
  actualContext: SignatureContext | undefined,
  requiredContext: SignatureContext | undefined,
): boolean {
  if (actual === undefined || required === undefined) return true;
  if (actual.length !== required.length) return false;
  return actual.every(
    (type, index) =>
      normalizeSignatureType(type, actualContext) ===
      normalizeSignatureType(required[index]!, requiredContext),
  );
}

function returnTypesCompatible(
  actual: string | undefined,
  required: string | undefined,
  actualContext: SignatureContext | undefined,
  requiredContext: SignatureContext | undefined,
): boolean {
  if (required === undefined) return actual === undefined;
  if (actual === undefined) return false;
  return (
    normalizeSignatureType(actual, actualContext) ===
    normalizeSignatureType(required, requiredContext)
  );
}

function normalizeSignatureType(typeName: string, context?: SignatureContext): string {
  // Go type identity includes pointer/slice/map/variadic shape and package
  // qualifiers. Only erase whitespace and qualify bare local type names; stripping
  // `*`, `[]`, `...`, or `pkg.` would make non-identical signatures compare equal.
  const compact = typeName.replace(/\s+/g, '');
  if (context === undefined) return compact;
  return qualifyGoSignatureTypes(compact, context);
}

function qualifyGoSignatureTypes(typeName: string, context: SignatureContext): string {
  return typeName.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (token, offset, source) => {
    if (GO_BUILTIN_TYPES.has(token)) return token;
    if (source[offset - 1] === '.') return token;
    if (source[offset + token.length] === '.') {
      return context.importQualifiers.get(token) ?? token;
    }
    if (context.packageQualifier === undefined) return token;
    return `${context.packageQualifier}.${token}`;
  });
}

function signatureContextForFile(
  parsed: ParsedFile,
  indexes: ScopeResolutionIndexes,
): SignatureContext {
  const importQualifiers = new Map<string, string>();
  const importEdges = indexes.imports?.get(parsed.moduleScope) ?? [];
  for (const edge of importEdges) {
    if (edge.kind !== 'namespace' || edge.targetFile === null) continue;
    const qualifier = packageQualifierForFile(edge.targetFile);
    if (qualifier !== undefined) importQualifiers.set(edge.localName, qualifier);
  }
  return {
    packageQualifier: packageQualifierForFile(parsed.filePath),
    importQualifiers,
  };
}

function packageQualifierForFile(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  if (slash === -1) return undefined;
  const packageDir = normalized.slice(0, slash);
  return packageDir.length === 0 ? undefined : packageDir;
}

const GO_BUILTIN_TYPES = new Set([
  'any',
  'bool',
  'byte',
  'comparable',
  'complex64',
  'complex128',
  'error',
  'float32',
  'float64',
  'func',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'interface',
  'map',
  'rune',
  'string',
  'struct',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'chan',
]);
