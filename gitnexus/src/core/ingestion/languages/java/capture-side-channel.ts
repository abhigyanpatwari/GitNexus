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

export type JavaClassAnnotationFact = ClassAnnotationFact;

export interface JavaCaptureSideChannel {
  readonly kind: 'java';
  readonly packageFact: JvmPackageFact;
  readonly classAnnotations: readonly JavaClassAnnotationFact[];
}

const classAnnotations = createClassAnnotationFactStore();

/** Clear facts retained by a prior workspace pass in a long-lived process. */
export function clearJavaClassAnnotationFacts(): void {
  classAnnotations.clear();
}

/** Store the annotation syntax collected by Java's existing scope-query traversal. */
export function setJavaClassAnnotationFacts(
  filePath: string,
  facts: readonly JavaClassAnnotationFact[],
): void {
  classAnnotations.set(filePath, facts);
}

/** Snapshot worker-local Java annotation facts for ParsedFile serialization. */
export function collectJavaCaptureSideChannel(
  filePath: string,
): JavaCaptureSideChannel | undefined {
  const facts = classAnnotations.get(filePath);
  const packageFact = getJavaPackageFact(filePath);
  if (facts.length === 0 && packageFact === undefined) return undefined;
  return {
    kind: 'java',
    packageFact: packageFact ?? UNKNOWN_JVM_PACKAGE_FACT,
    classAnnotations: facts,
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
    setJavaPackageFact(parsed.filePath, UNKNOWN_JVM_PACKAGE_FACT);
    return;
  }
  setJavaClassAnnotationFacts(parsed.filePath, data.classAnnotations);
  setJavaPackageFact(
    parsed.filePath,
    isJvmPackageFact(data.packageFact) ? data.packageFact : UNKNOWN_JVM_PACKAGE_FACT,
  );
}
