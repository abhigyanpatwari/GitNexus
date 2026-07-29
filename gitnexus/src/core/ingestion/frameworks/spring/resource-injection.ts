import type { DiInjectionMatch } from '../../di-extractors/index.js';
import {
  normalizeSpringBeanType,
  parseSpringAnnotationArguments,
  parseStaticClassLiteral,
  parseStaticStringValues,
} from './annotation-arguments.js';

export const SPRING_RESOURCE_ANNOTATIONS = new Set([
  'jakarta.annotation.Resource',
  'javax.annotation.Resource',
]);

function singleNamedArgument(
  annotationText: string,
  name: string,
): { readonly present: boolean; readonly value?: string } | null {
  const argumentsList = parseSpringAnnotationArguments(annotationText);
  if (argumentsList === null || argumentsList.some((argument) => argument.name === undefined)) {
    return null;
  }
  const matches = argumentsList.filter((argument) => argument.name === name);
  if (matches.length > 1) return null;
  return matches.length === 0 ? { present: false } : { present: true, value: matches[0].value };
}

function staticSingleString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const values = parseStaticStringValues(value);
  return values !== null && values.length === 1 ? values[0] : null;
}

function javaBeansDecapitalize(value: string): string {
  if (value.length === 0) return value;
  if (
    value.length > 1 &&
    value[0] !== value[0].toLowerCase() &&
    value[1] !== value[1].toLowerCase()
  ) {
    return value;
  }
  return value[0].toLowerCase() + value.slice(1);
}

export function springResourceDefaultName(
  siteKind: string,
  memberName: string,
  dependencyCount: number,
): string | null {
  if (siteKind !== 'method') return memberName;
  if (dependencyCount !== 1 || !/^set[A-Z_$]/.test(memberName) || memberName.length <= 3) {
    return null;
  }
  return javaBeansDecapitalize(memberName.slice(3));
}

/** Build the conservative name-first Resource match shared by Java and Kotlin. */
export function springResourceInjectionMatch(
  annotationText: string,
  defaultName: string,
  rawDeclaredType: string,
  location: string,
): DiInjectionMatch | null {
  const nameArgument = singleNamedArgument(annotationText, 'name');
  const typeArgument = singleNamedArgument(annotationText, 'type');
  const lookupArgument = singleNamedArgument(annotationText, 'lookup');
  const mappedNameArgument = singleNamedArgument(annotationText, 'mappedName');
  if (
    nameArgument === null ||
    typeArgument === null ||
    lookupArgument === null ||
    mappedNameArgument === null
  ) {
    return null;
  }

  for (const runtimeArgument of [lookupArgument, mappedNameArgument]) {
    if (!runtimeArgument.present) continue;
    const value = staticSingleString(runtimeArgument.value);
    if (value === null || value.length > 0) return null;
  }

  const declaredType = normalizeSpringBeanType(rawDeclaredType);
  if (declaredType === null) return null;
  let targetTypeName = declaredType;
  if (typeArgument.present) {
    const override = parseStaticClassLiteral(typeArgument.value ?? '');
    if (override === null) return null;
    if (override.length > 0) targetTypeName = override;
  }

  let selectedName = defaultName;
  let explicitName = false;
  if (nameArgument.present) {
    const parsedName = staticSingleString(nameArgument.value);
    if (parsedName === null) return null;
    if (parsedName.length > 0) {
      selectedName = parsedName;
      explicitName = true;
    }
  }

  return {
    targetTypeName,
    cardinality: 'single',
    namedSelection: {
      name: selectedName,
      reason: `${explicitName ? 'resource name' : 'default resource name'} "${selectedName}"`,
      ...(!explicitName && !rawDeclaredType.includes('<') ? { fallbackToType: true } : {}),
    },
    reason: `Spring DI: @Resource ${location}: ${targetTypeName}`,
  };
}
