import { createJvmPackageSiblingVisibility } from '../jvm/package-siblings.js';
import { getJavaPackageFact } from './package-facts.js';

const javaPackageSiblingVisibility = createJvmPackageSiblingVisibility({
  languageLabel: 'java',
  getPackageFact: getJavaPackageFact,
  // Java hoists method return types to module scope, so the copy is files x
  // files x methods per package. Inherited field types, the one thing it
  // supplied, go through the superclass chain instead
  // (`populateJavaInheritedFieldTypes`).
  mergeSiblingTypeBindings: false,
});

export const populateJavaPackageSiblings = javaPackageSiblingVisibility.populateNamespaceSiblings;

export const isJavaPackageSiblingVisibilityIncomplete =
  javaPackageSiblingVisibility.isVisibilityIncomplete;

export const hasJavaSamePackageType = javaPackageSiblingVisibility.hasSamePackageType;

export const resolveJavaSamePackageBase =
  javaPackageSiblingVisibility.resolveImplicitInheritanceBase;
