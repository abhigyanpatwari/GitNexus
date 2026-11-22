import type { ParsedFile } from 'gitnexus-shared';
import type { JavaImportUses } from './import-use-facts.js';
import {
  createClassAnnotationFactStore,
  type ClassAnnotationFact,
} from '../../frameworks/spring/bean-candidates.js';
import {
  isJvmPackageFact,
  UNKNOWN_JVM_PACKAGE_FACT,
  type JvmPackageFact,
} from '../jvm/package-facts.js';
import { getJavaPackageFact, setJavaPackageFact } from './package-facts.js';
import type { JavaSpringConfigConsumerFact } from './spring-config-bindings.js';
import type { JavaSpringAopFact } from './spring-aop.js';
import type { JavaSpringConditionalFact } from './spring-conditionals.js';
import type { JavaSpringDiClassFact } from './spring-di.js';
import type { SpringDynamicLookupFact } from '../../frameworks/spring/dynamic-lookups.js';
import type { SpringMessageProducerFact } from '../../frameworks/spring/message-producers.js';
import type { JavaSpringNonHttpHandlerFact } from './spring-non-http-handlers.js';
import {
  clearJavaContainerProofs,
  getJavaContainerProofs,
  getJavaImportedSpellings,
  getJavaReturnElements,
  getJavaTypeFields,
  type JavaContainerProofFact,
  type JavaImportedSpellingFact,
  type JavaReturnElementFact,
  type JavaTypeFieldsFact,
} from './declared-type-captures.js';
import {
  clearJavaOverloadFacts,
  getJavaOverloadFacts,
  isJavaOverloadFileFacts,
  setJavaOverloadFacts,
  type JavaOverloadFileFacts,
} from './overload-argument-facts.js';

export type JavaClassAnnotationFact = ClassAnnotationFact;

export interface JavaCaptureSideChannel {
  readonly kind: 'java';
  readonly importUses?: JavaImportUses;
  readonly overloadFacts?: JavaOverloadFileFacts;
  /** JDK container identities that inferred element bindings depend on. */
  readonly containerProofs?: readonly JavaContainerProofFact[];
  /** Element types of declared JDK container returns, for call-result loops. */
  readonly returnElements?: readonly JavaReturnElementFact[];
  /** Dotted element spellings that are single-type imports' canonical names. */
  readonly importedSpellings?: readonly JavaImportedSpellingFact[];
  /** Supertypes and fields of this file's types; absent when not captured. */
  readonly typeFields?: readonly JavaTypeFieldsFact[];
  readonly packageFact: JvmPackageFact;
  readonly classAnnotations: readonly JavaClassAnnotationFact[];
  readonly springAopFacts?: readonly JavaSpringAopFact[];
  readonly springConfigConsumers?: readonly JavaSpringConfigConsumerFact[];
  readonly springConditionalFacts?: readonly JavaSpringConditionalFact[];
  readonly springDiFacts?: readonly JavaSpringDiClassFact[];
  readonly springDynamicLookupFacts?: readonly SpringDynamicLookupFact[];
  readonly springNonHttpHandlerFacts?: readonly JavaSpringNonHttpHandlerFact[];
  readonly springMessageProducerFacts?: readonly SpringMessageProducerFact[];
}

const classAnnotations = createClassAnnotationFactStore();
const importUses = new Map<string, JavaImportUses>();

export function setJavaImportUses(filePath: string, facts: JavaImportUses | undefined): void {
  if (facts === undefined) importUses.delete(filePath);
  else importUses.set(filePath, facts);
}

export function getJavaImportUses(filePath: string): JavaImportUses | undefined {
  return importUses.get(filePath);
}
const springAopFacts = new Map<string, readonly JavaSpringAopFact[]>();
const springConfigConsumers = new Map<string, readonly JavaSpringConfigConsumerFact[]>();
const springConditionalFacts = new Map<string, readonly JavaSpringConditionalFact[]>();
const springDiFacts = new Map<string, readonly JavaSpringDiClassFact[]>();
const springDynamicLookupFacts = new Map<string, readonly SpringDynamicLookupFact[]>();
const springNonHttpHandlerFacts = new Map<string, readonly JavaSpringNonHttpHandlerFact[]>();
const springMessageProducerFacts = new Map<string, readonly SpringMessageProducerFact[]>();

/** Clear facts retained by a prior workspace pass in a long-lived process. */
export function clearJavaClassAnnotationFacts(): void {
  importUses.clear();
  clearJavaOverloadFacts();
  clearJavaContainerProofs();
  classAnnotations.clear();
  springAopFacts.clear();
  springConfigConsumers.clear();
  springConditionalFacts.clear();
  springDiFacts.clear();
  springDynamicLookupFacts.clear();
  springNonHttpHandlerFacts.clear();
  springMessageProducerFacts.clear();
}

export function setJavaSpringAopFacts(filePath: string, facts: readonly JavaSpringAopFact[]): void {
  if (facts.length === 0) springAopFacts.delete(filePath);
  else springAopFacts.set(filePath, facts);
}

export function getJavaSpringAopFacts(filePath: string): readonly JavaSpringAopFact[] {
  return springAopFacts.get(filePath) ?? [];
}

/** Store the annotation syntax collected by Java's existing scope-query traversal. */
export function setJavaClassAnnotationFacts(
  filePath: string,
  facts: readonly JavaClassAnnotationFact[],
): void {
  classAnnotations.set(filePath, facts);
}

export function setJavaSpringConfigConsumerFacts(
  filePath: string,
  facts: readonly JavaSpringConfigConsumerFact[],
): void {
  if (facts.length === 0) springConfigConsumers.delete(filePath);
  else springConfigConsumers.set(filePath, facts);
}

export function getJavaSpringConfigConsumerFacts(
  filePath: string,
): readonly JavaSpringConfigConsumerFact[] {
  return springConfigConsumers.get(filePath) ?? [];
}

export function setJavaSpringConditionalFacts(
  filePath: string,
  facts: readonly JavaSpringConditionalFact[],
): void {
  if (facts.length === 0) springConditionalFacts.delete(filePath);
  else springConditionalFacts.set(filePath, facts);
}

export function getJavaSpringConditionalFacts(
  filePath: string,
): readonly JavaSpringConditionalFact[] {
  return springConditionalFacts.get(filePath) ?? [];
}

export function setJavaSpringDiFacts(
  filePath: string,
  facts: readonly JavaSpringDiClassFact[],
): void {
  if (facts.length === 0) springDiFacts.delete(filePath);
  else springDiFacts.set(filePath, facts);
}

export function getJavaSpringDiFacts(filePath: string): readonly JavaSpringDiClassFact[] {
  return springDiFacts.get(filePath) ?? [];
}

export function setJavaSpringDynamicLookupFacts(
  filePath: string,
  facts: readonly SpringDynamicLookupFact[],
): void {
  if (facts.length === 0) springDynamicLookupFacts.delete(filePath);
  else springDynamicLookupFacts.set(filePath, facts);
}

export function getJavaSpringDynamicLookupFacts(
  filePath: string,
): readonly SpringDynamicLookupFact[] {
  return springDynamicLookupFacts.get(filePath) ?? [];
}

export function setJavaSpringNonHttpHandlerFacts(
  filePath: string,
  facts: readonly JavaSpringNonHttpHandlerFact[],
): void {
  if (facts.length === 0) springNonHttpHandlerFacts.delete(filePath);
  else springNonHttpHandlerFacts.set(filePath, facts);
}

export function getJavaSpringNonHttpHandlerFacts(
  filePath: string,
): readonly JavaSpringNonHttpHandlerFact[] {
  return springNonHttpHandlerFacts.get(filePath) ?? [];
}

export function setJavaSpringMessageProducerFacts(
  filePath: string,
  facts: readonly SpringMessageProducerFact[],
): void {
  if (facts.length === 0) springMessageProducerFacts.delete(filePath);
  else springMessageProducerFacts.set(filePath, facts);
}

export function getJavaSpringMessageProducerFacts(
  filePath: string,
): readonly SpringMessageProducerFact[] {
  return springMessageProducerFacts.get(filePath) ?? [];
}

/** Snapshot worker-local Java annotation facts for ParsedFile serialization. */
export function collectJavaCaptureSideChannel(
  filePath: string,
): JavaCaptureSideChannel | undefined {
  const facts = classAnnotations.get(filePath);
  const overloadFacts = getJavaOverloadFacts(filePath);
  const aopFacts = springAopFacts.get(filePath) ?? [];
  const configConsumers = springConfigConsumers.get(filePath) ?? [];
  const conditionFacts = springConditionalFacts.get(filePath) ?? [];
  const diFacts = springDiFacts.get(filePath) ?? [];
  const dynamicLookupFacts = springDynamicLookupFacts.get(filePath) ?? [];
  const nonHttpHandlerFacts = springNonHttpHandlerFacts.get(filePath) ?? [];
  const messageProducerFacts = springMessageProducerFacts.get(filePath) ?? [];
  const packageFact = getJavaPackageFact(filePath);
  const containerProofs = getJavaContainerProofs(filePath);
  const returnElements = getJavaReturnElements(filePath);
  const importedSpellings = getJavaImportedSpellings(filePath);
  const typeFields = getJavaTypeFields(filePath);
  if (
    overloadFacts === undefined &&
    containerProofs.length === 0 &&
    returnElements.length === 0 &&
    importedSpellings.length === 0 &&
    typeFields === undefined &&
    facts.length === 0 &&
    aopFacts.length === 0 &&
    configConsumers.length === 0 &&
    conditionFacts.length === 0 &&
    diFacts.length === 0 &&
    dynamicLookupFacts.length === 0 &&
    nonHttpHandlerFacts.length === 0 &&
    messageProducerFacts.length === 0 &&
    packageFact === undefined
  ) {
    return undefined;
  }
  return {
    kind: 'java',
    importUses: importUses.get(filePath),
    ...(overloadFacts === undefined ? {} : { overloadFacts }),
    ...(containerProofs.length > 0 ? { containerProofs } : {}),
    ...(returnElements.length > 0 ? { returnElements } : {}),
    ...(importedSpellings.length > 0 ? { importedSpellings } : {}),
    // Kept when empty: an empty list proves this file's types declare no field.
    ...(typeFields === undefined ? {} : { typeFields }),
    packageFact: packageFact ?? UNKNOWN_JVM_PACKAGE_FACT,
    classAnnotations: facts,
    ...(aopFacts.length > 0 ? { springAopFacts: aopFacts } : {}),
    ...(configConsumers.length > 0 ? { springConfigConsumers: configConsumers } : {}),
    ...(conditionFacts.length > 0 ? { springConditionalFacts: conditionFacts } : {}),
    ...(diFacts.length > 0 ? { springDiFacts: diFacts } : {}),
    ...(dynamicLookupFacts.length > 0 ? { springDynamicLookupFacts: dynamicLookupFacts } : {}),
    ...(nonHttpHandlerFacts.length > 0 ? { springNonHttpHandlerFacts: nonHttpHandlerFacts } : {}),
    ...(messageProducerFacts.length > 0
      ? { springMessageProducerFacts: messageProducerFacts }
      : {}),
  };
}

/** Return element facts carried on a ParsedFile, keeping only well-formed ones. */
export function javaReturnElementFacts(parsed: ParsedFile): readonly JavaReturnElementFact[] {
  const data = parsed.captureSideChannel as JavaCaptureSideChannel | undefined;
  return data?.kind === 'java' && Array.isArray(data.returnElements)
    ? data.returnElements.filter(
        (fact) =>
          typeof fact === 'object' &&
          fact !== null &&
          Array.isArray(fact.proofs) &&
          Array.isArray(fact.elements),
      )
    : [];
}

/** Imported element spelling facts carried on a ParsedFile, well-formed ones only. */
export function javaImportedSpellingFacts(parsed: ParsedFile): readonly JavaImportedSpellingFact[] {
  const data = parsed.captureSideChannel as JavaCaptureSideChannel | undefined;
  return data?.kind === 'java' && Array.isArray(data.importedSpellings)
    ? data.importedSpellings.filter(
        (fact) =>
          typeof fact === 'object' &&
          fact !== null &&
          typeof fact.line === 'number' &&
          typeof fact.col === 'number' &&
          typeof fact.spelling === 'string' &&
          (fact.status === 'import' || fact.status === 'ambiguous'),
      )
    : [];
}

/** Type field facts carried on a ParsedFile; `undefined` when not captured. */
export function javaTypeFieldFacts(parsed: ParsedFile): readonly JavaTypeFieldsFact[] | undefined {
  const data = parsed.captureSideChannel as JavaCaptureSideChannel | undefined;
  return data?.kind === 'java' &&
    Array.isArray(data.typeFields) &&
    data.typeFields.every(
      (fact) =>
        typeof fact === 'object' &&
        fact !== null &&
        typeof fact.range === 'object' &&
        fact.range !== null &&
        Array.isArray(fact.bases) &&
        Array.isArray(fact.fields),
    )
    ? data.typeFields
    : undefined;
}

export function getJavaClassAnnotationFacts(filePath: string): readonly JavaClassAnnotationFact[] {
  return classAnnotations.get(filePath);
}

/** Restore worker-collected facts before Java's post-resolution hook runs. */
export function applyJavaCaptureSideChannel(parsed: ParsedFile): void {
  const data = parsed.captureSideChannel as JavaCaptureSideChannel | undefined;
  setJavaImportUses(parsed.filePath, data?.kind === 'java' ? data.importUses : undefined);
  if (
    data === undefined ||
    data === null ||
    typeof data !== 'object' ||
    data.kind !== 'java' ||
    !Array.isArray(data.classAnnotations)
  ) {
    setJavaOverloadFacts(parsed.filePath, undefined);
    setJavaClassAnnotationFacts(parsed.filePath, []);
    setJavaSpringAopFacts(parsed.filePath, []);
    setJavaSpringConfigConsumerFacts(parsed.filePath, []);
    setJavaSpringConditionalFacts(parsed.filePath, []);
    setJavaSpringDiFacts(parsed.filePath, []);
    setJavaSpringDynamicLookupFacts(parsed.filePath, []);
    setJavaSpringNonHttpHandlerFacts(parsed.filePath, []);
    setJavaSpringMessageProducerFacts(parsed.filePath, []);
    setJavaPackageFact(parsed.filePath, UNKNOWN_JVM_PACKAGE_FACT);
    return;
  }
  setJavaOverloadFacts(
    parsed.filePath,
    isJavaOverloadFileFacts(data.overloadFacts) ? data.overloadFacts : undefined,
  );
  setJavaClassAnnotationFacts(parsed.filePath, data.classAnnotations);
  setJavaSpringAopFacts(
    parsed.filePath,
    Array.isArray(data.springAopFacts) ? data.springAopFacts : [],
  );
  setJavaSpringConfigConsumerFacts(
    parsed.filePath,
    Array.isArray(data.springConfigConsumers) ? data.springConfigConsumers : [],
  );
  setJavaSpringConditionalFacts(
    parsed.filePath,
    Array.isArray(data.springConditionalFacts) ? data.springConditionalFacts : [],
  );
  setJavaSpringDiFacts(
    parsed.filePath,
    Array.isArray(data.springDiFacts) ? data.springDiFacts : [],
  );
  setJavaSpringDynamicLookupFacts(
    parsed.filePath,
    Array.isArray(data.springDynamicLookupFacts) ? data.springDynamicLookupFacts : [],
  );
  setJavaSpringNonHttpHandlerFacts(
    parsed.filePath,
    Array.isArray(data.springNonHttpHandlerFacts) ? data.springNonHttpHandlerFacts : [],
  );
  setJavaSpringMessageProducerFacts(
    parsed.filePath,
    Array.isArray(data.springMessageProducerFacts) ? data.springMessageProducerFacts : [],
  );
  setJavaPackageFact(
    parsed.filePath,
    isJvmPackageFact(data.packageFact) ? data.packageFact : UNKNOWN_JVM_PACKAGE_FACT,
  );
}
