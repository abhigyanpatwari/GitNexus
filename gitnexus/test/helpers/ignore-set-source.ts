/**
 * Reads the bare-name sets in `src/config/ignore-service.ts` out of source.
 *
 * Those sets are module-private, and exporting them purely to be testable would
 * widen a production surface to satisfy a test — the call
 * `receiver-twin-list-drift.test.ts` documents. So the guards read the source
 * instead, through `@babel/parser` (`parse-typescript-source.ts`).
 *
 * Using an AST parser for TypeScript syntax is what makes the guards
 * trustworthy. A text scanner has to decide whether a delimiter opens a comment
 * or sits inside a string, and it gets that wrong in both directions here: the
 * ignore-list comments quote paths and carry an apostrophe (`Next.js's`), while
 * a glob string such as `'** / *'` contains a comment-open sequence. It also
 * has to guess which bracket belongs to the declaration rather than to a type
 * annotation. Each of those is a way to silently read fewer members — and a
 * guard that quietly stops seeing members is the exact defect these guards
 * exist to catch.
 *
 * `setEntries` therefore refuses anything that is not a plain list of string
 * literals, rather than skipping the members it cannot resolve.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as t from '@babel/types';
import { forEachChild, nodeText, parseTypeScript } from './parse-typescript-source.js';

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
  const { ast } = parseTypeScript('ignore-set-source.ts', source);

  let elements: t.ArrayExpression['elements'] | undefined;
  const visit = (node: t.Node): void => {
    if (
      elements === undefined &&
      t.isVariableDeclarator(node) &&
      t.isIdentifier(node.id) &&
      node.id.name === setName &&
      node.init !== undefined &&
      node.init !== null &&
      t.isNewExpression(node.init) &&
      node.init.arguments.length === 1 &&
      t.isArrayExpression(node.init.arguments[0])
    ) {
      elements = node.init.arguments[0].elements;
      return;
    }
    forEachChild(node, visit);
  };
  visit(ast);

  if (elements === undefined) {
    throw new Error(`${setName} is not declared as \`new Set([...])\` — update this test`);
  }

  const unresolvable = elements.filter((element) => !t.isStringLiteral(element));
  if (unresolvable.length > 0) {
    const first = unresolvable[0];
    const excerpt = first && typeof first === 'object' ? nodeText(source, first) : String(first);
    throw new Error(
      `${setName} holds ${unresolvable.length} member(s) that are not plain string literals ` +
        `(first: \`${excerpt}\`). A source-reading guard cannot resolve ` +
        `those, so switch this set to a runtime assertion rather than letting the guard see fewer members.`,
    );
  }

  return elements.map((element) => (element as t.StringLiteral).value);
};

/**
 * True when `setName` is mutated by `.add(...)` anywhere in `source`.
 *
 * `setEntries` reads the declaration only, so a member appended afterwards would
 * be invisible to it. The guards assert this is false rather than under-reporting.
 */
export const hasRuntimeAdd = (source: string, setName: string): boolean =>
  new RegExp(`\\b${setName}\\s*\\.\\s*add\\s*\\(`).test(source);
