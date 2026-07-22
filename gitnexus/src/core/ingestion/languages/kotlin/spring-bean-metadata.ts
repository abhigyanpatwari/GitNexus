import { createSpringBeanCandidateAttacher } from '../../frameworks/spring/bean-candidates.js';
import { getKotlinClassAnnotationFacts } from './capture-side-channel.js';
import { isKotlinPackageSiblingVisibilityIncomplete } from './package-siblings.js';

/** Kotlin wiring for the language-neutral Spring candidate engine. */
export const attachKotlinSpringBeanCandidateMetadata = createSpringBeanCandidateAttacher({
  getClassAnnotationFacts: getKotlinClassAnnotationFacts,
  isPackageVisibilityIncomplete: isKotlinPackageSiblingVisibilityIncomplete,
});
