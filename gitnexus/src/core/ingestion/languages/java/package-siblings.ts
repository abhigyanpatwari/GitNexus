import { createJvmPackageSiblingVisibility } from '../jvm/package-siblings.js';
import { getJavaPackageFact } from './package-facts.js';

const javaPackageSiblingVisibility = createJvmPackageSiblingVisibility({
  languageLabel: 'java',
  getPackageFact: getJavaPackageFact,
});

export const populateJavaPackageSiblings = javaPackageSiblingVisibility.populateNamespaceSiblings;

export const isJavaPackageSiblingVisibilityIncomplete =
  javaPackageSiblingVisibility.isVisibilityIncomplete;
