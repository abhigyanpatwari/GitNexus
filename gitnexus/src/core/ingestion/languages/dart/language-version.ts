import type { ParsedFile } from 'gitnexus-shared';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

/** Wildcard-variable answer for one parsed tree during one capture. */
interface DartLanguageVersionState {
  /** Answer when the file carries no leading `// @dart=` override. */
  readonly defaultWildcards: boolean;
  /** Resolved answer. Undefined until a `_` binder first asks. */
  wildcards?: boolean;
  /** A `_` binder asked and no file override answered: the capture depends on
   * the language version supplied by the caller. */
  packageSensitive: boolean;
}

const stateByTree = new WeakMap<object, DartLanguageVersionState>();

/** The most recent capture. One slot, so direct emitter callers that never
 * collect a side channel (benchmarks, tests) retain nothing per file. */
let latestCapture: { readonly filePath: string; readonly state: DartLanguageVersionState } | null =
  null;

/** Plain data carried on `ParsedFile.captureSideChannel`. Present only for a
 * file whose capture depends on its package's language version. */
export interface DartCaptureSideChannel {
  readonly kind: 'dart';
  readonly packageLanguageVersionSensitive: true;
}

/** `_` declares a parameter or local before Dart 3.7 and nothing from 3.7 on. */
export function dartLanguageVersionHasWildcardVariables(major: number, minor: number): boolean {
  return major > 3 || (major === 3 && minor >= 7);
}

/** The same question for a `major.minor` string; a missing part reads as 3.7. */
export function dartVersionHasWildcardVariables(version: string): boolean {
  const [major = 3, minor = 7] = version.split('.').map(Number);
  return dartLanguageVersionHasWildcardVariables(major, minor);
}

export function setDartDefaultLanguageVersion(
  node: SyntaxNode,
  version: string,
  filePath?: string,
): void {
  const state: DartLanguageVersionState = {
    defaultWildcards: dartVersionHasWildcardVariables(version),
    packageSensitive: false,
  };
  stateByTree.set(node.tree, state);
  latestCapture = filePath === undefined ? null : { filePath, state };
}

/** The capture grammar targets Dart 3.7+. A leading language-version override
 * preserves older `_` parameter/local semantics. Patterns always remain wildcards.
 *
 * Callers ask only for a non-pattern binder named `_`, so the first question
 * is also the record that this file has a version-sensitive binder.
 */
export function dartUsesWildcardVariables(node: SyntaxNode): boolean {
  const tree = node.tree;
  let state = stateByTree.get(tree);
  if (state === undefined) {
    state = { defaultWildcards: true, packageSensitive: false };
    stateByTree.set(tree, state);
  }
  if (state.wildcards !== undefined) return state.wildcards;
  let enabled = state.defaultWildcards;
  let overridden = false;
  for (const child of tree.rootNode.namedChildren) {
    if (child.type === 'script_tag') continue;
    if (child.type !== 'comment' && child.type !== 'documentation_comment') break;
    const version = /^\/\/\s*@dart\s*=\s*(\d+)\.(\d+)\s*$/.exec(child.text);
    if (version !== null) {
      enabled = dartLanguageVersionHasWildcardVariables(Number(version[1]), Number(version[2]));
      overridden = true;
      break;
    }
  }
  state.wildcards = enabled;
  state.packageSensitive = !overridden;
  return enabled;
}

/** Worker-side snapshot for `LanguageProvider.collectCaptureSideChannel`:
 * called immediately after the capture of `filePath`. Undefined for a file
 * with no `_` parameter/local, or with a file-level override, whose capture is
 * the same under every package language version. */
export function collectDartCaptureSideChannel(
  filePath: string,
): DartCaptureSideChannel | undefined {
  if (latestCapture === null || latestCapture.filePath !== filePath) return undefined;
  return latestCapture.state.packageSensitive
    ? { kind: 'dart', packageLanguageVersionSensitive: true }
    : undefined;
}

/** Whether a reused `ParsedFile` must be captured again when its package
 * selects a language version other than the capture default. An absent record
 * is unknown, so it is answered conservatively. */
export function dartCaptureDependsOnPackageLanguageVersion(
  parsed: ParsedFile | undefined,
): boolean {
  if (parsed === undefined) return true;
  const payload: unknown = parsed.captureSideChannel;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as Partial<DartCaptureSideChannel>).kind === 'dart' &&
    (payload as Partial<DartCaptureSideChannel>).packageLanguageVersionSensitive === true
  );
}
