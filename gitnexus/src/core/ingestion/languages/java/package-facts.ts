import {
  createJvmPackageFactStore,
  type JvmPackageFact,
  type JvmPackageSyntaxNode,
} from '../jvm/package-facts.js';

const javaPackageFacts = createJvmPackageFactStore({
  packageNodeType: 'package_declaration',
  packageNameNodeTypes: ['scoped_identifier', 'identifier'],
});

export const clearJavaPackageFacts = (): void => javaPackageFacts.clear();
export const captureJavaPackageFact = (filePath: string, root: JvmPackageSyntaxNode): void =>
  javaPackageFacts.capture(filePath, root);
export const setJavaPackageFact = (filePath: string, fact: JvmPackageFact): void =>
  javaPackageFacts.set(filePath, fact);
export const getJavaPackageFact = (filePath: string): JvmPackageFact | undefined =>
  javaPackageFacts.get(filePath);
