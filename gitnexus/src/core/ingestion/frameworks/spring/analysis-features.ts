import type { AnalysisFeatureDescriptor } from '../../../analysis-features.js';
import { isSpringBeanCandidateSourceFile } from './bean-catalog.js';

/** Durable completeness contract for Java/Kotlin Spring Bean evidence. */
export const SPRING_BEAN_INVENTORY_FEATURE: AnalysisFeatureDescriptor = {
  id: 'spring.bean-inventory',
  version: 2,
  appliesTo: (filePaths) => filePaths.some(isSpringBeanCandidateSourceFile),
};

function isSpringConditionOrAutoConfigurationFile(filePath: string): boolean {
  const normalized = `/${filePath.replaceAll('\\', '/')}`.toLowerCase();
  return (
    normalized.endsWith('.java') ||
    normalized.endsWith('.kt') ||
    normalized.endsWith('.kts') ||
    normalized.endsWith('/meta-inf/spring.factories') ||
    normalized.endsWith(
      '/meta-inf/spring/org.springframework.boot.autoconfigure.autoconfiguration.imports',
    )
  );
}

/** Durable completeness contract for conditional and auto-configuration evidence. */
export const SPRING_CONDITIONALS_FEATURE: AnalysisFeatureDescriptor = {
  id: 'spring.conditionals-auto-configuration',
  version: 1,
  appliesTo: (filePaths) => filePaths.some(isSpringConditionOrAutoConfigurationFile),
};

/**
 * Candidate-language approximation, not a claim that the file contains AOP.
 * Kotlin scripts are included because `.kts` is a supported Kotlin input.
 */
function isJvmSourceFile(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase();
  return normalized.endsWith('.java') || normalized.endsWith('.kt') || normalized.endsWith('.kts');
}

/** Durable completeness contract for Spring proxy/advice evidence (#2416). */
export const SPRING_AOP_FEATURE: AnalysisFeatureDescriptor = {
  id: 'spring.aop-advice',
  version: 1,
  appliesTo: (filePaths) => filePaths.some(isJvmSourceFile),
};
