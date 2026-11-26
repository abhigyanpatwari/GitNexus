import type { AnalysisFeatureDescriptor } from '../../../analysis-features.js';

const RUBY_EXTENSION_PATTERN = /\.(?:rb|rake|gemspec)$/i;

/** Durable completeness contract for qualified Ruby member node IDs (#2874). */
export const RUBY_MEMBER_SCOPE_IDENTITY_FEATURE: AnalysisFeatureDescriptor = {
  id: 'ruby.member-scope-identity',
  version: 1,
  appliesTo: (filePaths) => filePaths.some((filePath) => RUBY_EXTENSION_PATTERN.test(filePath)),
};
