import {
  createJvmPackageFactStore,
  type JvmPackageFact,
  type JvmPackageSyntaxNode,
} from '../jvm/package-facts.js';

const kotlinPackageFacts = createJvmPackageFactStore({
  packageNodeType: 'package_header',
  packageNameNodeTypes: ['identifier'],
});

export const clearKotlinPackageFacts = (): void => kotlinPackageFacts.clear();
export const captureKotlinPackageFact = (filePath: string, root: JvmPackageSyntaxNode): void =>
  kotlinPackageFacts.capture(filePath, root);
export const setKotlinPackageFact = (filePath: string, fact: JvmPackageFact): void =>
  kotlinPackageFacts.set(filePath, fact);
export const getKotlinPackageFact = (filePath: string): JvmPackageFact | undefined =>
  kotlinPackageFacts.get(filePath);
