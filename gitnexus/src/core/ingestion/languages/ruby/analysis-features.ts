import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import type { AnalysisFeatureDescriptor } from '../../../analysis-features.js';

/**
 * Member node ids for nested Ruby modules and classes, including compact
 * `class A::B`, changed shape. Extensionless Ruby sources (`Rakefile`,
 * `Gemfile`, and the other names language detection already recognizes) are
 * included so a repository that contains only those files still rebuilds.
 */
export const RUBY_MEMBER_SCOPE_IDENTITY_FEATURE: AnalysisFeatureDescriptor = {
  id: 'ruby.member-scope-identity',
  version: 1,
  appliesTo: (filePaths) =>
    filePaths.some((filePath) => getLanguageFromFilename(filePath) === SupportedLanguages.Ruby),
};
