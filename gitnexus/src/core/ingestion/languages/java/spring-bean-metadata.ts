import { createSpringBeanCandidateAttacher } from '../../frameworks/spring/bean-candidates.js';
import { getJavaClassAnnotationFacts } from './capture-side-channel.js';
import { isJavaPackageSiblingVisibilityIncomplete } from './package-siblings.js';

/** Java wiring for the language-neutral Spring candidate engine. */
export const attachSpringBeanCandidateMetadata = createSpringBeanCandidateAttacher({
  getClassAnnotationFacts: getJavaClassAnnotationFacts,
  isPackageVisibilityIncomplete: isJavaPackageSiblingVisibilityIncomplete,
});
