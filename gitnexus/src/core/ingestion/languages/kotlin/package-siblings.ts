import { createJvmPackageSiblingVisibility } from '../jvm/package-siblings.js';
import { getKotlinPackageFact } from './package-facts.js';

const kotlinPackageSiblingVisibility = createJvmPackageSiblingVisibility({
  languageLabel: 'kotlin',
  getPackageFact: getKotlinPackageFact,
});

export const populateKotlinPackageSiblings =
  kotlinPackageSiblingVisibility.populateNamespaceSiblings;

export const isKotlinPackageSiblingVisibilityIncomplete =
  kotlinPackageSiblingVisibility.isVisibilityIncomplete;
