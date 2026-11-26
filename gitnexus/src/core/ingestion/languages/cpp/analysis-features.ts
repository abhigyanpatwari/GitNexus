import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import type { AnalysisFeatureDescriptor } from '../../../analysis-features.js';

/**
 * Member node ids for namespaced and nested C++ types changed shape.
 * Incremental analyze must rebuild every repository that contains C++ so
 * unchanged files do not keep the old tail-only ids beside the new ones.
 *
 * `.h` is included because the extension map classifies headers as C++ and
 * header-only templates are where these members live. A C project that only
 * has `.h` files rebuilds once; its member ids do not move.
 */
export const CPP_MEMBER_SCOPE_IDENTITY_FEATURE: AnalysisFeatureDescriptor = {
  id: 'cpp.member-scope-identity',
  version: 1,
  appliesTo: (filePaths) =>
    filePaths.some(
      (filePath) => getLanguageFromFilename(filePath) === SupportedLanguages.CPlusPlus,
    ),
};
