import type { AnalysisFeatureDescriptor } from '../../../analysis-features.js';
import { isSpringBeanCandidateSourceFile } from './bean-catalog.js';

/** Durable completeness contract for Java/Kotlin Spring Bean evidence. */
export const SPRING_BEAN_INVENTORY_FEATURE: AnalysisFeatureDescriptor = {
  id: 'spring.bean-inventory',
  version: 1,
  appliesTo: (filePaths) => filePaths.some(isSpringBeanCandidateSourceFile),
};
