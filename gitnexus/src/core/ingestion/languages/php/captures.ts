import type { Capture, CaptureMatch } from 'gitnexus-shared';
import Parser from 'tree-sitter';

import Php from 'tree-sitter-php';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { nodeToCapture } from '../../utils/ast-helpers.js';
import { getTreeSitterBufferSize } from '../../constants.js';

let _parser: Parser | null = null;
let _query: Parser.Query | null = null;

function getPhpParser(): Parser {
  if (_parser === null) {
    _parser = new Parser();
    // Some versions of tree-sitter-php export { php, html }, some just the language.
    const lang = Php.php ? Php.php : Php;
    _parser.setLanguage(lang as Parameters<Parser['setLanguage']>[0]);
  }
  return _parser;
}

function getPhpScopeQuery(): Parser.Query {
  if (_query === null) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const queryStr = readFileSync(join(__dirname, 'scopes.scm'), 'utf8');
    const lang = Php.php ? Php.php : Php;
    _query = new Parser.Query(lang as Parameters<Parser['setLanguage']>[0], queryStr);
  }
  return _query;
}

export function emitPhpScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getPhpParser>['parse']> | undefined;
  
  if (tree === undefined) {
    tree = getPhpParser().parse(sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }
  
  const rawMatches = getPhpScopeQuery().matches(tree.rootNode);

  const out: CaptureMatch[] = [];
  for (const m of rawMatches) {
    // Group captures by their tag name. 
    // Tree-sitter strips the leading `@`; we put it back so the engine's lookups work.
    const grouped: Record<string, Capture> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
    }
    if (Object.keys(grouped).length === 0) continue;
    
    out.push(grouped);
  }

  return out;
}
