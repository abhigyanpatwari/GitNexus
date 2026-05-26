import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeId } from 'gitnexus-shared';
import { normalizeCppParamType } from './arity-metadata.js';

const userDefinedConversions = new Set<string>();

export function clearCppUserDefinedConversions(): void {
  userDefinedConversions.clear();
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
    if (classDef === undefined) continue;
    const className = normalizedSimpleName(classDef);
    if (className === '') continue;

    const methodDefs = collectClassMethodDefs(classScope.id, parsed, scopesById);
    for (const def of methodDefs) {
      const simpleName = simpleNameOf(def);
      if (simpleName === className && def.parameterTypes?.length === 1) {
        registerCppUserDefinedConversion(def.parameterTypes[0], className);
        continue;
      }

      const operatorTarget = conversionOperatorTarget(simpleName);
      if (operatorTarget !== undefined && def.parameterTypes?.length === 0) {
        registerCppUserDefinedConversion(className, operatorTarget);
      }
    }
  }
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

function conversionOperatorTarget(simpleName: string): string | undefined {
  const match = /^operator\s+(.+)$/.exec(simpleName);
  if (match === null) return undefined;
  const target = normalizeCppParamType(match[1]);
  return target.length > 0 ? target : undefined;
}

function conversionKey(argType: string, paramType: string): string {
  return `${argType}\0${paramType}`;
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
