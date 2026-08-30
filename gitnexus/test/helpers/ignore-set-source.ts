/**
 * Reads the bare-name sets in `src/config/ignore-service.ts` out of source.
 *
 * Those sets are module-private, and exporting them purely to be testable would
 * widen a production surface to satisfy a test — the call
 * `receiver-twin-list-drift.test.ts` documents. So the guards read the source
 * instead, through the TypeScript parser the repo already vendors and already
 * uses this way (`literal-collectors.ts`, `query-determinism-guard.test.ts`,
 * `cli-index-help.test.ts`).
 *
 * Using the real parser is what makes the guards trustworthy. A text scanner has
 * to decide whether a delimiter opens a comment or sits inside a string, and it
 * gets that wrong in both directions here: the ignore-list comments quote paths
 * and carry an apostrophe (`Next.js's`), while a glob string such as `'** / *'`
 * contains a comment-open sequence. It also has to guess which bracket belongs
 * to the declaration rather than to a type annotation. Each of those is a way to
 * silently read fewer members — and a guard that quietly stops seeing members is
 * the exact defect these guards exist to catch.
 *
 * `setEntries` therefore refuses anything that is not a plain list of string
 * literals, rather than skipping the members it cannot resolve.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The analyzer's ignore rules — the sets every guard in this family reads. */
export const IGNORE_SERVICE_PATH = path.join(
  REPO_ROOT,
  'gitnexus',
  'src',
  'config',
  'ignore-service.ts',
);

/** The browser upload pre-filter, whose excluded-directory set must not drift from the above. */
export const UPLOAD_FILTER_PATH = path.join(
  REPO_ROOT,
  'gitnexus-web',
  'src',
  'lib',
  'upload-filter.ts',
);

export const readSource = (file: string): string => readFileSync(file, 'utf8');

/**
 * The string literals `setName` is constructed from, in declaration order.
 *
 * Throws — never returns a short list — when the declaration is missing or holds
 * anything other than plain string literals (a spread, an interpolation, a
 * concatenation, a computed value).
 */
export const setEntries = (source: string, setName: string): string[] => {
  const sourceFile = ts.createSourceFile(
    'ignore-set-source.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  let elements: ts.NodeArray<ts.Expression> | undefined;
  const visit = (node: ts.Node): void => {
    if (
      elements === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === setName &&
      node.initializer !== undefined &&
      ts.isNewExpression(node.initializer) &&
      node.initializer.arguments?.length === 1 &&
      ts.isArrayLiteralExpression(node.initializer.arguments[0])
    ) {
      elements = node.initializer.arguments[0].elements;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (elements === undefined) {
    throw new Error(`${setName} is not declared as \`new Set([...])\` — update this test`);
  }

  const unresolvable = elements.filter((element) => !ts.isStringLiteral(element));
  if (unresolvable.length > 0) {
    throw new Error(
      `${setName} holds ${unresolvable.length} member(s) that are not plain string literals ` +
        `(first: \`${unresolvable[0].getText(sourceFile)}\`). A source-reading guard cannot resolve ` +
        `those, so switch this set to a runtime assertion rather than letting the guard see fewer members.`,
    );
  }

  return elements.map((element) => (element as ts.StringLiteral).text);
};

/**
 * True when `setName` is mutated by `.add(...)` anywhere in `source`.
 *
 * `setEntries` reads the declaration only, so a member appended afterwards would
 * be invisible to it. The guards assert this is false rather than under-reporting.
 */
export const hasRuntimeAdd = (source: string, setName: string): boolean =>
  new RegExp(`\\b${setName}\\s*\\.\\s*add\\s*\\(`).test(source);
