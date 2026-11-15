/**
 * Types and resolution for the value-flow check (U10, R9, KTD11 "Checker (TypeScript)", design
 * §5.3a step 2), through TypeScript 7's unstable native API (`typescript/unstable/sync`).
 *
 * The checker opens one project from a tsconfig path given by the caller: `gitnexus/tsconfig.test.json`
 * by default ({@link DEFAULT_TSCONFIG}; `tsconfig.json` covers `src/` only, so test files would get
 * no project), the fixture's own `tsconfig.json` in `controls` mode. It refuses to run unless
 * `typescript` resolves to exactly {@link PINNED_TYPESCRIPT}: the API is unstable and Dependabot
 * can bump the lockfile, so a mismatch is the run-level degraded flag `checker-version` and every
 * value-differing pair is unknown (pdg-walk.ts). Any other API failure, including a native panic
 * (the API throws on, for example, `getAliasedSymbol` of a non-alias symbol, so aliases are
 * checked by flag first), is unknown for that pair only.
 *
 * {@link ValueFlowChecker.resolveAt} resolves the identifier naming a callee (a test entry from
 * bind.ts, or a call inside production code during the walk) through import aliases
 * (`getAliasedSymbol`, re-exports included) to its declaration, and places it:
 *  - `repo`: a `.ts` source under the repo root, outside `node_modules`; the declaration's end
 *    offset locates the function for the walk (overloads: the one declaration with a body);
 *  - `declaration`: a repo `.d.ts` (such as `gitnexus-shared/dist/*.d.ts`): no body to walk;
 *  - `library`: `lib.*.d.ts`, `@types/node`, anything under `node_modules`;
 *  - `unresolved`: no symbol, a symbol of another name at the position, or an API failure.
 * The display name joins the declaring container (`Math.round`, `ReadonlySet.has`).
 * {@link ValueFlowChecker.resolveEntry} also reads the parameter at the entry's argument index
 * (the resolved signature when there are overloads), its type text, whether it is `any` or
 * `unknown` (an entry the design marks unknown), and its literal-union or enum members, which
 * are recorded for the reviewer.
 *
 * Positions are UTF-16 offsets (JavaScript string indices), the unit Babel uses; probed on
 * 2026-10-24: a file with two 2-byte characters before the callee resolves at its JS index.
 *
 * Library only; pdg-walk.ts opens one checker per run ({@link openChecker}).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Node } from 'typescript/unstable/ast';
import type {
  API,
  Checker,
  Project,
  Signature,
  Symbol as TsSymbol,
  Type,
} from 'typescript/unstable/sync';
import { readJsonFile } from '../../mutation/shared/fs.js';
import { toPosixRelative } from '../util.js';
import type { CalleeInfo } from './sinks.js';

/** The only TypeScript version the unstable API is trusted at. */
export const PINNED_TYPESCRIPT = '7.0.2';
/** Default project, relative to the repo root. */
export const DEFAULT_TSCONFIG = 'gitnexus/tsconfig.test.json';

export interface ParamInfo {
  index: number;
  name: string;
  /** The checker's type text. */
  type: string;
  /** `any` or `unknown`: an entry the design marks unknown. */
  anyOrUnknown: boolean;
  /** Members of a literal union or enum type (`"fast"`, `Color.Red`); empty otherwise. */
  literalMembers: string[];
}

export interface EntryResolution {
  callee: CalleeInfo;
  /** The parameter at the argument index; null when unresolved or when no signature fits. */
  param: ParamInfo | null;
  /** Why `param` is null; empty otherwise. */
  paramReason: string;
}

export interface ValueFlowChecker {
  readonly version: string;
  /** Repo path of the project's tsconfig. */
  readonly tsconfig: string;
  /** Resolves the identifier `name` at `offset` (UTF-16) in `file` (repo path). */
  resolveAt(file: string, offset: number, name: string): CalleeInfo;
  /** {@link resolveAt} plus the parameter that receives argument `argIndex`. */
  resolveEntry(
    file: string,
    offset: number,
    name: string,
    argIndex: number,
    isNew: boolean,
  ): EntryResolution;
  close(): void;
}

export type OpenCheckerResult =
  | { status: 'ready'; checker: ValueFlowChecker }
  | { status: 'checker-version'; version: string }
  | { status: 'error'; error: string };

export interface OpenCheckerOptions {
  /** Absolute repo root; repo paths resolve against it. */
  repoRoot: string;
  /** Repo path or absolute path of the tsconfig; default {@link DEFAULT_TSCONFIG}. */
  tsconfig?: string;
  /** The resolved `typescript` version; default `typescript/package.json` from `gitnexus/`. */
  version?: string;
}

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0];

const unresolved = (name: string, reason: string): CalleeInfo => ({
  origin: 'unresolved',
  name,
  container: null,
  file: null,
  declarationEnd: null,
  isClass: false,
  reason,
});

/** The `typescript` version resolved from the gitnexus package. */
export function installedTypescriptVersion(repoRoot: string): string {
  const require = createRequire(path.join(repoRoot, 'gitnexus', 'package.json'));
  const manifest = readJsonFile(require.resolve('typescript/package.json'));
  const version = (manifest as { version?: unknown }).version;
  return typeof version === 'string' ? version : 'unknown';
}

/** Opens the checker, or reports why it cannot run. */
export async function openChecker(options: OpenCheckerOptions): Promise<OpenCheckerResult> {
  const repoRoot = path.resolve(options.repoRoot);
  let version: string;
  try {
    version = options.version ?? installedTypescriptVersion(repoRoot);
  } catch (error) {
    return { status: 'error', error: `typescript not resolvable: ${errorText(error)}` };
  }
  if (version !== PINNED_TYPESCRIPT) return { status: 'checker-version', version };
  const tsconfig = path.resolve(repoRoot, options.tsconfig ?? DEFAULT_TSCONFIG);
  // Hoisted: a failure after the API started its checker server (a bad tsconfig, a project
  // that does not open) must close that server, or it outlives the run.
  let api: API | undefined;
  try {
    const require = createRequire(path.join(repoRoot, 'gitnexus', 'package.json'));
    const mod = (await import(
      require.resolve('typescript/unstable/sync')
    )) as typeof import('typescript/unstable/sync');
    const opened = new mod.API({ cwd: path.dirname(tsconfig) });
    api = opened;
    const snapshot = opened.updateSnapshot({ openProjects: [tsconfig] });
    const checker = new TsValueFlowChecker(
      repoRoot,
      version,
      toPosixRelative(path.relative(repoRoot, tsconfig)),
      opened,
      (file) => snapshot.getDefaultProjectForFile(file),
      mod,
    );
    return { status: 'ready', checker };
  } catch (error) {
    try {
      api?.close();
    } catch {
      // Closing a dead server is not a result.
    }
    return { status: 'error', error: `checker failed to open: ${errorText(error)}` };
  }
}

type SyncModule = typeof import('typescript/unstable/sync');

class TsValueFlowChecker implements ValueFlowChecker {
  constructor(
    private readonly repoRoot: string,
    readonly version: string,
    readonly tsconfig: string,
    private readonly api: API,
    private readonly projectOf: (file: string) => Project | undefined,
    private readonly mod: SyncModule,
  ) {}

  close(): void {
    try {
      this.api.close();
    } catch {
      // Closing a dead server is not a result.
    }
  }

  resolveAt(file: string, offset: number, name: string): CalleeInfo {
    return this.resolve(file, offset, name).callee;
  }

  resolveEntry(
    file: string,
    offset: number,
    name: string,
    argIndex: number,
    isNew: boolean,
  ): EntryResolution {
    const resolved = this.resolve(file, offset, name);
    if (resolved.symbol === null || resolved.project === null) {
      return { callee: resolved.callee, param: null, paramReason: resolved.callee.reason };
    }
    try {
      const { checker } = resolved.project;
      const type = checker.getTypeOfSymbol(resolved.symbol);
      if (type === undefined)
        return { callee: resolved.callee, param: null, paramReason: 'no type' };
      const kind = isNew ? this.mod.SignatureKind.Construct : this.mod.SignatureKind.Call;
      const signatures = checker.getSignaturesOfType(type, kind);
      // Overloads: the signature the checker resolved for this very call.
      const signature =
        signatures.length === 1
          ? signatures[0]
          : this.resolvedSignature(resolved.project, path.join(this.repoRoot, file), offset);
      if (signature === undefined) {
        return {
          callee: resolved.callee,
          param: null,
          paramReason: `${signatures.length} signatures, none resolved for the call`,
        };
      }
      const param = this.paramAt(checker, signature, argIndex);
      return {
        callee: resolved.callee,
        param,
        paramReason: param === null ? `no parameter at ${argIndex}` : '',
      };
    } catch (error) {
      return { callee: resolved.callee, param: null, paramReason: errorText(error) };
    }
  }

  /** The signature resolved for the call whose callee identifier starts at `offset`. */
  private resolvedSignature(
    project: Project,
    absolute: string,
    offset: number,
  ): Signature | undefined {
    const { checker } = project;
    const found = checker.getSymbolAtPosition(absolute, offset);
    if (found === undefined) return undefined;
    const hasArguments = (node: Node | undefined): boolean =>
      node !== undefined && (node as { arguments?: unknown }).arguments !== undefined;
    for (const reference of checker.getReferencesToSymbolInFile(absolute, found)) {
      const node = reference.resolve(project);
      if (node === undefined || node.getStart() !== offset) continue;
      // `f(x)`: the identifier's parent; `o.f(x)`: the property access's parent.
      const call = hasArguments(node.parent) ? node.parent : node.parent?.parent;
      return hasArguments(call) && call !== undefined
        ? checker.getResolvedSignature(call)
        : undefined;
    }
    return undefined;
  }

  private paramAt(checker: Checker, signature: Signature, argIndex: number): ParamInfo | null {
    const params = signature.getParameters();
    const index =
      signature.hasRestParameter && argIndex >= params.length - 1 ? params.length - 1 : argIndex;
    const param = params[index];
    if (param === undefined) return null;
    const type = checker.getTypeOfSymbol(param);
    if (type === undefined) return null;
    const members = type.isUnionType() ? type.getTypes() : [type];
    return {
      index: argIndex,
      name: param.name,
      type: checker.typeToString(type),
      anyOrUnknown: (type.flags & this.mod.TypeFlags.AnyOrUnknown) !== 0,
      literalMembers: members
        .filter((member: Type) => member.isLiteralType())
        .map((member: Type) => checker.typeToString(member)),
    };
  }

  private resolve(
    file: string,
    offset: number,
    name: string,
  ): { callee: CalleeInfo; symbol: TsSymbol | null; project: Project | null } {
    const absolute = path.join(this.repoRoot, file);
    try {
      const project = this.projectOf(absolute);
      if (project === undefined) {
        return { callee: unresolved(name, 'file not in the project'), symbol: null, project: null };
      }
      const { checker } = project;
      const found = checker.getSymbolAtPosition(absolute, offset);
      if (found === undefined) {
        return { callee: unresolved(name, 'no symbol'), symbol: null, project: null };
      }
      if (found.name !== name && found.name !== 'default') {
        return {
          callee: unresolved(name, `symbol ${found.name} at the position`),
          symbol: null,
          project: null,
        };
      }
      const symbol =
        (found.flags & this.mod.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(found) : found;
      return { callee: this.place(project, symbol, name), symbol, project };
    } catch (error) {
      return { callee: unresolved(name, errorText(error)), symbol: null, project: null };
    }
  }

  /** Where a resolved symbol is declared. */
  private place(project: Project, symbol: TsSymbol, name: string): CalleeInfo {
    const declarations = symbol.declarations;
    if (declarations.length === 0) return unresolved(name, 'no declaration');
    const parent = symbol.getParent();
    // Module symbols (`"/abs/file"`) and `declare global` (`__global`) name no container.
    const container =
      parent === undefined || parent.name.startsWith('"') || parent.name === '__global'
        ? null
        : parent.name;
    const display = container === null ? symbol.name : `${container}.${symbol.name}`;
    const isClass = (symbol.flags & this.mod.SymbolFlags.Class) !== 0;
    const files = declarations.map((declaration) => this.originOf(declaration.path));
    const base = { name: display, container, isClass, reason: '' };
    if (files.some((entry) => entry.origin === 'library')) {
      return { ...base, origin: 'library', file: null, declarationEnd: null };
    }
    if (files.some((entry) => entry.origin === 'declaration')) {
      return {
        ...base,
        origin: 'declaration',
        file: files.find((entry) => entry.origin === 'declaration')?.file ?? null,
        declarationEnd: null,
      };
    }
    const distinctFiles = [...new Set(files.map((entry) => entry.file))];
    if (distinctFiles.length !== 1) return unresolved(name, 'declared in several files');
    // Overloads: the one declaration with a body.
    const nodes = declarations.map((declaration) => declaration.resolve(project));
    const withBody =
      nodes.length === 1
        ? nodes
        : nodes.filter((node) => (node as { body?: unknown } | undefined)?.body !== undefined);
    const end = withBody.length === 1 ? withBody[0]?.end : undefined;
    if (end === undefined) return unresolved(name, `${nodes.length} declarations`);
    return { ...base, origin: 'repo', file: distinctFiles[0], declarationEnd: end };
  }

  private originOf(declarationPath: string): {
    origin: 'repo' | 'declaration' | 'library';
    file: string | null;
  } {
    const relative = toPosixRelative(path.relative(this.repoRoot, declarationPath));
    const outside = relative.startsWith('../') || path.isAbsolute(relative);
    const basename = path.posix.basename(relative);
    if (
      outside ||
      relative.split('/').includes('node_modules') ||
      /^lib\..*\.d\.ts$/.test(basename)
    ) {
      return { origin: 'library', file: null };
    }
    if (relative.endsWith('.d.ts')) return { origin: 'declaration', file: relative };
    return { origin: 'repo', file: relative };
  }
}
