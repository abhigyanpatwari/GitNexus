import { treeParseContext } from '../../file-parse-context.js';
import { nodePackageIsEsm, type NodeWorkspacePackages } from '../typescript/workspace-packages.js';

// A lexical prefilter avoids tagging a file for ordinary digits inside modern
// numbers or identifiers. Comments and strings can match; AST capture still
// requires an actual legacy numeric property before publishing any evidence.
const possibleLegacyNumber = /(?<![\p{ID_Continue}$\u200c\u200d.])0\d/u;

/** Only a legacy decimal/octal token can make a parse result depend on package format. */
export function javascriptParseContext(
  filePath: string,
  source: string,
  config: unknown,
): string | undefined {
  if (!filePath.endsWith('.js') || !possibleLegacyNumber.test(source) || !config) return undefined;
  const { nodeWorkspacePackages } = config as {
    nodeWorkspacePackages: NodeWorkspacePackages | null;
  };
  return nodePackageIsEsm(filePath, nodeWorkspacePackages) ? undefined : 'sloppy-script-candidate';
}

export function javascriptFileAllowsLegacyNumericKeys(filePath: string, tree: object): boolean {
  return filePath.endsWith('.cjs') || treeParseContext(tree) === 'sloppy-script-candidate';
}
