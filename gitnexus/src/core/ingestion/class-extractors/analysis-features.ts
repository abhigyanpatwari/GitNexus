import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import type { AnalysisFeatureDescriptor } from '../../analysis-features.js';

const QUALIFIED_MEMBER_ID_LANGUAGES: ReadonlySet<SupportedLanguages> = new Set([
  SupportedLanguages.CPlusPlus,
  SupportedLanguages.Ruby,
]);

/**
 * Durable metadata stamp for member ids keyed by the owner's fully-qualified
 * path (`qualifiedMemberIds`, #2874). The change moves the id of every member
 * whose owner sits inside a namespace or module, so an index written before it
 * must be rebuilt: an incremental run would keep the old ids for unchanged
 * files and leave the graph holding both id shapes at once.
 *
 * Bump `version` when another language opts into `qualifiedMemberIds`.
 */
export const QUALIFIED_MEMBER_IDS_FEATURE: AnalysisFeatureDescriptor = {
  id: 'graph.qualified-member-ids',
  version: 1,
  appliesTo: (filePaths) =>
    filePaths.some((filePath) => {
      const language = getLanguageFromFilename(filePath);
      return language !== null && QUALIFIED_MEMBER_ID_LANGUAGES.has(language);
    }),
};
