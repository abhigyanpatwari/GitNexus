import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { collectEsmExportEvidence } from '../../ts-js-export-marker.js';
import { getJsParser } from '../javascript/query.js';
import { getTsParser } from './query.js';

/** Certify only modules whose exports the graph's syntactic checker can see. */
export function hasFilePrivateExportSemantics(filePath: string, content: string): boolean {
  // File.content is FTS-normalized: newlines become spaces. A line comment
  // could therefore hide a later export from this parse. Never certify it.
  if (
    !content ||
    content.includes('//') ||
    content.includes('[truncated]') ||
    /\.d\.[cm]?ts$/i.test(filePath)
  )
    return false;
  try {
    const parser = /\.[cm]?jsx?$/i.test(filePath) ? getJsParser(filePath) : getTsParser(filePath);
    const tree = parseSourceSafe(parser, content, undefined, {
      bufferSize: getTreeSitterBufferSize(content),
    });
    if (tree.rootNode.hasError) return false;
    const evidence = collectEsmExportEvidence(tree.rootNode, filePath);
    if (!evidence || evidence.commonJs) return false;
    let isModule = false;
    for (const statement of tree.rootNode.namedChildren) {
      // Ambient modules and global augmentations publish otherwise unexported types.
      if (statement.type === 'ambient_declaration') return false;
      if (statement.type === 'import_statement') isModule = true;
      if (statement.type !== 'export_statement') continue;
      isModule = true;
      // `export { T }`, `export default T`, and `export = T` may publish a
      // declaration stored as false. Type aliases can do the same without a
      // graph edge to the underlying type. Retain the file seed for the whole file.
      const declaration = statement.childForFieldName('declaration');
      if (!declaration || declaration.type === 'type_alias_declaration') return false;
    }
    // Script declarations may be global across files without any exports.
    return isModule;
  } catch {
    // Unreadable or unsupported source is no proof of privacy.
    return false;
  }
}
