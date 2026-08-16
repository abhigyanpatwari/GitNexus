import type { AnalysisFeatureDescriptor } from '../../../analysis-features.js';

function isSpringApplicationConfig(filePath: string): boolean {
  const base = filePath.replaceAll('\\', '/').split('/').pop() ?? '';
  return /^application(?:-[^.]+)?\.(?:properties|ya?ml)$/i.test(base);
}

/** Durable completeness contract for Java Spring configuration bindings. */
export const SPRING_CONFIG_BINDINGS_FEATURE: AnalysisFeatureDescriptor = {
  id: 'spring.config-bindings',
  version: 1,
  // Java sources need consumer extraction even without config files (missing
  // placeholders still get unresolved markers). Config-only repositories also
  // need a one-time rebuild to backfill language-agnostic Property nodes.
  appliesTo: (filePaths) =>
    filePaths.some(
      (filePath) => filePath.toLowerCase().endsWith('.java') || isSpringApplicationConfig(filePath),
    ),
};

/** Durable completeness contract for implicit Java record-component accessors. */
export const JAVA_RECORD_COMPONENT_ACCESSORS_FEATURE: AnalysisFeatureDescriptor = {
  id: 'java.record-component-accessors',
  version: 1,
  appliesTo: (filePaths) => filePaths.some((filePath) => filePath.toLowerCase().endsWith('.java')),
};

/** Durable completeness contract for Java heritage captures. */
export const JAVA_ENUM_INTERFACE_HERITAGE_FEATURE: AnalysisFeatureDescriptor = {
  id: 'java.heritage-captures',
  version: 1,
  appliesTo: (filePaths) => filePaths.some((filePath) => filePath.toLowerCase().endsWith('.java')),
};
