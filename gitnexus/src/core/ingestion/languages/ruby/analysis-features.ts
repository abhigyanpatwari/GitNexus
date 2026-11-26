import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import type { AnalysisFeatureDescriptor } from '../../../analysis-features.js';

/** Durable completeness contract for qualified Ruby member node IDs (#2874). */
export const RUBY_MEMBER_SCOPE_IDENTITY_FEATURE: AnalysisFeatureDescriptor = {
  id: 'ruby.member-scope-identity',
  version: 1,
  appliesTo: (filePaths) =>
    filePaths.some(
      (filePath) =>
        getLanguageFromFilename(filePath.replaceAll('\\', '/')) === SupportedLanguages.Ruby,
    ),
};
