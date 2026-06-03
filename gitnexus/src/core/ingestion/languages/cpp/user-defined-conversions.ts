import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeId } from 'gitnexus-shared';
import { normalizeCppParamType } from './arity-metadata.js';

const userDefinedConversions = new Set<string>();
const pendingUserDefinedConversions: PendingUserDefinedConversion[] = [];
const classIdentitiesBySimpleName = new Map<string, Set<string>>();

interface PendingUserDefinedConversion {
  readonly argType: string;
  readonly paramType: string;
  readonly ownerClassName: string;
}

export function clearCppUserDefinedConversions(): void {
  userDefinedConversions.clear();
  pendingUserDefinedConversions.length = 0;
  classIdentitiesBySimpleName.clear();
}

export function hasCppUserDefinedConversion(argType: string, paramType: string): boolean {
  return userDefinedConversions.has(conversionKey(argType, paramType));
}

export function populateCppUserDefinedConversions(parsed: ParsedFile): void {
  const scopesById = new Map<ScopeId, (typeof parsed.scopes)[number]>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  for (const classScope of parsed.scopes) {
    if (classScope.kind !== 'Class') continue;
    const classDef = classScope.ownedDefs.find(isClassLike);
    if (classDef !== undefined) recordClassIdentity(classDef);
  }

  for (const classScope of parsed.scopes) {
    if (classScope.kind !== 'Class') continue;
    const classDef = classScope.ownedDefs.find(isClassLike);
    if (classDef === undefined) continue;
    const className = normalizedSimpleName(classDef);
    if (className === '') continue;

    const methodDefs = collectClassMethodDefs(classScope.id, parsed, scopesById);
    for (const def of methodDefs) {
      const simpleName = simpleNameOf(def);
      if (simpleName === className && def.parameterTypes?.length === 1) {
        if (def.isExplicit === true) continue;
        registerPendingCppUserDefinedConversion(def.parameterTypes[0], className, className);
      }
    }
  }

  rebuildCppUserDefinedConversions();
}

export function registerCppUserDefinedConversion(argType: string, paramType: string): void {
  if (argType === '' || paramType === '') return;
  if (argType === paramType) return;
  userDefinedConversions.add(conversionKey(argType, paramType));
}

function collectClassMethodDefs(
  classScopeId: ScopeId,
  parsed: ParsedFile,
  scopesById: ReadonlyMap<ScopeId, (typeof parsed.scopes)[number]>,
): SymbolDefinition[] {
  const methods: SymbolDefinition[] = [];
  const classScope = scopesById.get(classScopeId);
  if (classScope === undefined) return methods;

  for (const def of classScope.ownedDefs) {
    if (isCallableMember(def)) methods.push(def);
  }
  for (const scope of parsed.scopes) {
    if (scope.parent !== classScopeId) continue;
    if (scope.kind === 'Class') continue;
    for (const def of scope.ownedDefs) {
      if (isCallableMember(def)) methods.push(def);
    }
  }
  return methods;
}

function conversionKey(argType: string, paramType: string): string {
  return `${argType}\0${paramType}`;
}

function registerPendingCppUserDefinedConversion(
  argType: string,
  paramType: string,
  ownerClassName: string,
): void {
  if (argType === '' || paramType === '') return;
  if (argType === paramType) return;
  pendingUserDefinedConversions.push({ argType, paramType, ownerClassName });
}

function rebuildCppUserDefinedConversions(): void {
  userDefinedConversions.clear();
  for (const conversion of pendingUserDefinedConversions) {
    if (isAmbiguousClassName(conversion.ownerClassName)) continue;
    userDefinedConversions.add(conversionKey(conversion.argType, conversion.paramType));
  }
}

function recordClassIdentity(def: SymbolDefinition): void {
  const simpleName = normalizedSimpleName(def);
  if (simpleName === '') return;
  const identities = classIdentitiesBySimpleName.get(simpleName) ?? new Set<string>();
  identities.add(normalizedQualifiedClassName(def));
  classIdentitiesBySimpleName.set(simpleName, identities);
}

function isAmbiguousClassName(simpleName: string): boolean {
  return (classIdentitiesBySimpleName.get(simpleName)?.size ?? 0) > 1;
}

function normalizedQualifiedClassName(def: SymbolDefinition): string {
  const qualifiedName = def.qualifiedName ?? simpleNameOf(def);
  if (qualifiedName === '' || !qualifiedName.includes('.')) return `${def.filePath}:${def.nodeId}`;
  return qualifiedName
    .split('.')
    .map((part) => normalizeCppParamType(part))
    .join('.');
}

function normalizedSimpleName(def: SymbolDefinition): string {
  return normalizeCppParamType(simpleNameOf(def));
}

function simpleNameOf(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
}

function isClassLike(def: SymbolDefinition): boolean {
  return def.type === 'Class' || def.type === 'Struct' || def.type === 'Interface';
}

function isCallableMember(def: SymbolDefinition): boolean {
  return def.type === 'Method' || def.type === 'Constructor';
}
