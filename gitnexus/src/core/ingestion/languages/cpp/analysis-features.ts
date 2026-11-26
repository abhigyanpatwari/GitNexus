import type { AnalysisFeatureDescriptor } from '../../../analysis-features.js';

const CPP_EXTENSION_PATTERN = /\.(?:cpp|cc|cxx|h|hpp|hxx|hh|cu|cuh)$/i;

/** Durable completeness contract for qualified C++ member and out-of-line method node IDs (#2874). */
export const CPP_MEMBER_SCOPE_IDENTITY_FEATURE: AnalysisFeatureDescriptor = {
  id: 'cpp.member-scope-identity',
  version: 1,
  appliesTo: (filePaths) => filePaths.some((filePath) => CPP_EXTENSION_PATTERN.test(filePath)),
};
