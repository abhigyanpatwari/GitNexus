import type { ParsedFile } from 'gitnexus-shared';
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
import type { JavaSpringDiClassFact } from './spring-di.js';

export type JavaClassAnnotationFact = ClassAnnotationFact;

export interface JavaCaptureSideChannel {
  readonly kind: 'java';
  readonly packageFact: JvmPackageFact;
  readonly classAnnotations: readonly JavaClassAnnotationFact[];
  readonly springConfigConsumers?: readonly JavaSpringConfigConsumerFact[];
  readonly springDiFacts?: readonly JavaSpringDiClassFact[];
}

const classAnnotations = createClassAnnotationFactStore();
const springConfigConsumers = new Map<string, readonly JavaSpringConfigConsumerFact[]>();
const springDiFacts = new Map<string, readonly JavaSpringDiClassFact[]>();

/** Clear facts retained by a prior workspace pass in a long-lived process. */
export function clearJavaClassAnnotationFacts(): void {
  classAnnotations.clear();
  springConfigConsumers.clear();
  springDiFacts.clear();
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

/** Snapshot worker-local Java annotation facts for ParsedFile serialization. */
export function collectJavaCaptureSideChannel(
  filePath: string,
): JavaCaptureSideChannel | undefined {
  const facts = classAnnotations.get(filePath);
  const configConsumers = springConfigConsumers.get(filePath) ?? [];
  const diFacts = springDiFacts.get(filePath) ?? [];
  const packageFact = getJavaPackageFact(filePath);
  if (
    facts.length === 0 &&
    configConsumers.length === 0 &&
    diFacts.length === 0 &&
    packageFact === undefined
  ) {
    return undefined;
  }
  return {
    kind: 'java',
    packageFact: packageFact ?? UNKNOWN_JVM_PACKAGE_FACT,
    classAnnotations: facts,
    ...(configConsumers.length > 0 ? { springConfigConsumers: configConsumers } : {}),
    ...(diFacts.length > 0 ? { springDiFacts: diFacts } : {}),
  };
}

export function getJavaClassAnnotationFacts(filePath: string): readonly JavaClassAnnotationFact[] {
  return classAnnotations.get(filePath);
}

/** Restore worker-collected facts before Java's post-resolution hook runs. */
export function applyJavaCaptureSideChannel(parsed: ParsedFile): void {
  const data = parsed.captureSideChannel as JavaCaptureSideChannel | undefined;
  if (
    data === undefined ||
    data === null ||
    typeof data !== 'object' ||
    data.kind !== 'java' ||
    !Array.isArray(data.classAnnotations)
  ) {
    setJavaClassAnnotationFacts(parsed.filePath, []);
    setJavaSpringConfigConsumerFacts(parsed.filePath, []);
    setJavaSpringDiFacts(parsed.filePath, []);
    setJavaPackageFact(parsed.filePath, UNKNOWN_JVM_PACKAGE_FACT);
    return;
  }
  setJavaClassAnnotationFacts(parsed.filePath, data.classAnnotations);
  setJavaSpringConfigConsumerFacts(
    parsed.filePath,
    Array.isArray(data.springConfigConsumers) ? data.springConfigConsumers : [],
  );
  setJavaSpringDiFacts(
    parsed.filePath,
    Array.isArray(data.springDiFacts) ? data.springDiFacts : [],
  );
  setJavaPackageFact(
    parsed.filePath,
    isJvmPackageFact(data.packageFact) ? data.packageFact : UNKNOWN_JVM_PACKAGE_FACT,
  );
}
