/**
 * Python Language Provider
 *
 * Assembles all Python-specific ingestion capabilities into a single
 * LanguageProvider, following the Strategy pattern used by the pipeline.
 *
 * Key Python traits:
 *   - mroStrategy: 'c3' (Python C3 linearization for multiple inheritance)
 */

import type { NodeLabel } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { pythonClassConfig } from '../class-extractors/configs/python.js';
import { defineLanguage } from '../language-provider.js';
import type { AstFrameworkPatternConfig } from '../language-provider.js';
import { typeConfig as pythonConfig } from '../type-extractors/python.js';
import { pythonExportChecker } from '../export-detection.js';
import { PYTHON_QUERIES } from '../tree-sitter-queries.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { pythonConfig as pythonFieldConfig } from '../field-extractors/configs/python.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { pythonMethodConfig } from '../method-extractors/configs/python.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { pythonVariableConfig } from '../variable-extractors/configs/python.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { pythonCallConfig } from '../call-extractors/configs/python.js';
import { createPythonCfgVisitor } from '../cfg/visitors/python.js';
import type { CaptureMap } from '../language-provider.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import {
  emitPythonScopeCaptures,
  pythonFunctionDefinitionLabel,
  interpretPythonImport,
  interpretPythonTypeBinding,
  pythonArityCompatibility,
  pythonBindingScopeFor,
  pythonImportOwningScope,
  pythonMergeBindings,
  pythonReceiverBinding,
  resolvePythonImportTarget,
} from './python/index.js';
import { extractDjangoRoutes } from '../route-extractors/django.js';
import { discoverDjangoRootUrls } from '../route-extractors/django-root-discovery.js';
import { extractPythonModuleConstants } from '../route-extractors/python-const-resolver.js';
import { pythonDecoratorRouteHandlerName } from '../route-extractors/python-decorator-handler.js';
import { assertCloneable } from '../workers/clone-safety.js';
import { collectPythonCaptureSideChannel } from './python/module-accessors.js';
import { pythonRenameProvider } from './python/rename.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'print',
  'len',
  'range',
  'str',
  'int',
  'float',
  'list',
  'dict',
  'set',
  'tuple',
  'append',
  'extend',
  'update',
  'type',
  'isinstance',
  'issubclass',
  'getattr',
  'setattr',
  'hasattr',
  'enumerate',
  'zip',
  'sorted',
  'reversed',
  'min',
  'max',
  'sum',
  'abs',
]);

/**
 * Standard-library modules, for `LanguageProvider.isExternalModuleSpecifier`:
 * a name bound by `import os` or `from pathlib import Path` — when the import
 * resolved to no file in the program — is rooted in the interpreter's library,
 * so `os.environ.setdefault(...)` lost no in-program edge.
 *
 * Matched against the specifier's FIRST segment (`os.path` → `os`); a relative
 * specifier (`.compat`) has an empty one and never matches. Third-party
 * packages are not listed and cannot be: an unresolved `fastapi` import looks
 * exactly like an in-program module the resolver missed.
 *
 * Under-includes on purpose. The verdict already requires the import to have
 * resolved nowhere, so a local `os.py` that the resolver finds wins; what this
 * list guards against is a local module the resolver did NOT find. Generic
 * nouns an application plausibly names its own modules after — `types`,
 * `queue`, `signal`, `secrets`, `string`, `email`, `http`, `html`, `xml`,
 * `operator`, `platform`, `test` — are therefore left out even though the
 * standard library has them.
 */
const STDLIB_MODULES: ReadonlySet<string> = new Set([
  '__future__',
  'abc',
  'argparse',
  'ast',
  'asyncio',
  'atexit',
  'base64',
  'binascii',
  'bisect',
  'builtins',
  'bz2',
  'cmath',
  'codecs',
  'collections',
  'concurrent',
  'configparser',
  'contextlib',
  'contextvars',
  'copy',
  'csv',
  'ctypes',
  'dataclasses',
  'datetime',
  'decimal',
  'difflib',
  'enum',
  'errno',
  'fnmatch',
  'fractions',
  'functools',
  'gc',
  'getpass',
  'glob',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'keyword',
  'linecache',
  'locale',
  'logging',
  'lzma',
  'math',
  'mimetypes',
  'multiprocessing',
  'os',
  'pathlib',
  'pickle',
  'pkgutil',
  'pprint',
  'random',
  're',
  'shlex',
  'shutil',
  'socket',
  'sqlite3',
  'ssl',
  'stat',
  'statistics',
  'struct',
  'subprocess',
  'sys',
  'sysconfig',
  'tarfile',
  'tempfile',
  'textwrap',
  'threading',
  'time',
  'timeit',
  'traceback',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uuid',
  'warnings',
  'weakref',
  'zipfile',
  'zlib',
  'zoneinfo',
]);

const isPythonStdlibModule = (specifier: string): boolean =>
  STDLIB_MODULES.has(specifier.split('.', 1)[0] ?? '');

function pythonDescriptionExtractor(
  nodeLabel: NodeLabel,
  _nodeName: string,
  captureMap: CaptureMap,
): string | undefined {
  if (nodeLabel !== 'Function' && nodeLabel !== 'Method') return undefined;
  const functionNode = captureMap['definition.function'] ?? captureMap['definition.method'];
  if (functionNode === undefined) return undefined;
  return extractPythonDocstring(functionNode);
}

function extractPythonDocstring(functionNode: SyntaxNode): string | undefined {
  const body = functionNode.childForFieldName('body');
  const firstStatement = body?.namedChild(0);
  if (firstStatement?.type !== 'expression_statement') return undefined;

  const literal = firstStatement.namedChild(0);
  if (literal?.type !== 'string') return undefined;
  return normalizePythonStringLiteral(literal.text);
}

function normalizePythonStringLiteral(text: string): string | undefined {
  const match = text.match(/^[rRuUbBfF]*("""|'''|"|')([\s\S]*)\1$/);
  const raw = match?.[2]?.trim();
  if (!raw) return undefined;
  return raw.replace(/\s+/g, ' ');
}

export const pythonProvider = defineLanguage({
  id: SupportedLanguages.Python,
  rename: pythonRenameProvider,
  extensions: ['.py', '.ipynb'],
  entryPointPatterns: [/^app$/, /^(get|post|put|delete|patch)_/i, /^api_/, /^view_/],
  astFrameworkPatterns: [
    {
      framework: 'fastapi',
      entryPointMultiplier: 3.0,
      reason: 'fastapi-decorator',
      patterns: ['@app.get', '@app.post', '@app.put', '@app.delete', '@router.get'],
    },
    {
      framework: 'flask',
      entryPointMultiplier: 2.8,
      reason: 'flask-decorator',
      patterns: ['@app.route', '@blueprint.route'],
    },
  ] satisfies AstFrameworkPatternConfig[],
  treeSitterQueries: PYTHON_QUERIES,
  typeConfig: pythonConfig,
  exportChecker: pythonExportChecker,
  mroStrategy: 'c3',
  callExtractor: createCallExtractor(pythonCallConfig),
  fieldExtractor: createFieldExtractor(pythonFieldConfig),
  methodExtractor: createMethodExtractor(pythonMethodConfig),
  variableExtractor: createVariableExtractor(pythonVariableConfig),
  classExtractor: createClassExtractor(pythonClassConfig),
  descriptionExtractor: pythonDescriptionExtractor,
  builtInNames: BUILT_INS,
  isExternalModuleSpecifier: isPythonStdlibModule,
  // Django routing is whole-repo and cross-file (manage.py → settings →
  // ROOT_URLCONF → root urls.py, then include()s across files), so it runs as
  // a main-thread pass (see parse-impl's cross-file route extraction) rather
  // than the worker's single-file `isRouteFile` path. `reader` lets discovery
  // and extraction resolve any repo-relative file regardless of parse chunking.
  discoverRootRouteFiles: (files, contentMap, reader) =>
    discoverDjangoRootUrls(files, contentMap, reader),
  extractRoutes: (tree, filePath, reader, parser) =>
    parser ? extractDjangoRoutes(tree, filePath, parser, reader) : [],
  decoratorRouteHandlerName: pythonDecoratorRouteHandlerName,
  labelOverride: pythonFunctionDefinitionLabel,

  // ── RFC #909 Ring 3: scope-based resolution hooks (RFC §5) ──────────
  // Python is the first migration. See ./python/index.ts for the
  // full per-hook rationale and the canonical capture vocabulary in
  // ./python/query.ts (PYTHON_SCOPE_QUERY constant).
  emitScopeCaptures: emitPythonScopeCaptures,
  collectCaptureSideChannel: (filePath) =>
    assertCloneable(collectPythonCaptureSideChannel(filePath)),
  cfgVisitor: createPythonCfgVisitor(),
  interpretImport: interpretPythonImport,
  interpretTypeBinding: interpretPythonTypeBinding,
  bindingScopeFor: pythonBindingScopeFor,
  importOwningScope: pythonImportOwningScope,
  mergeBindings: (_scope, bindings) => pythonMergeBindings(bindings),
  receiverBinding: pythonReceiverBinding,
  arityCompatibility: pythonArityCompatibility,
  resolveImportTarget: resolvePythonImportTarget,

  // ── #2391 constant harvest, provider-hook form (#2980): module-level string
  // constants + from-imports for non-literal decorator route paths. Bare-name
  // refs fold through the shared resolver (no foldRoutePathOperands needed).
  // No `moduleConstantHeuristic`: Python harvests unconditionally, exactly as
  // #2391 shipped it. A content gate was tried here and removed on review — it
  // required `NAME` immediately followed by `=`, so it silently dropped the two
  // idiomatic typed-FastAPI shapes (`API: str = "/api"`,
  // `API: Final[str] = "/api"`) and every composed constant whose RHS starts
  // with an identifier (`USERS = BASE + "/users"`), i.e. it REGRESSED routes
  // that already resolve on main. The worker treats a missing heuristic as
  // default-open; only Java opts into a gate, where the cost actually bites.
  extractModuleConstants: extractPythonModuleConstants,
});
