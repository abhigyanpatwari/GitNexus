/**
 * Run the R rename provider's safety check on real parsed sources and a real knowledge graph.
 * `localDefs` are read off the sources the way the indexer would list plain top-level functions
 * (`name <- function`), so a function defined in another file is visible to the checks.
 */
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { SupportedLanguages } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

export interface RVerdictInput {
  /** File path to source text. The first file holds the target unless `targetFile` is given. */
  readonly files: Readonly<Record<string, string>>;
  /** Spelling of the target as the index keeps it (`helper`, `` `%+%` ``). */
  readonly target?: string;
  readonly newName: string;
  readonly targetFile?: string;
}

const FUNCTION_DEF = /^(`[^`\n]+`|[A-Za-z.][A-Za-z0-9._]*)\s*<-\s*function/gm;

/** The issue the provider reports (`code`, `message`), or null when it accepts the rename. */
export function rIssue(input: RVerdictInput): { code: string; message: string } | null {
  const target = input.target ?? 'helper';
  const targetFile = input.targetFile ?? Object.keys(input.files)[0];
  const graph = createKnowledgeGraph();
  const files = new Map(
    Object.entries(input.files).map(([path, source]) => {
      const localDefs = [...source.matchAll(FUNCTION_DEF)].map((match) => ({
        qualifiedName: match[1],
        type: 'Function',
      }));
      for (const def of localDefs) {
        graph.addNode({
          id: `Function:${path}:${def.qualifiedName}`,
          label: 'Function',
          properties: {
            name: def.qualifiedName,
            filePath: path,
            language: SupportedLanguages.R,
            isExported: false,
          },
        });
      }
      return [path, { tree: parser.parse(source), parsed: { localDefs } }] as const;
    }),
  );
  const issue = rRenameProvider.checkSafety?.({
    target: { type: 'Function', qualifiedName: target, filePath: targetFile },
    newName: input.newName,
    files,
    graph,
  } as never);
  return issue ? { code: issue.code, message: issue.message } : null;
}

/** The issue code, or `'ok'`. */
export const rVerdict = (input: RVerdictInput): string => rIssue(input)?.code ?? 'ok';
