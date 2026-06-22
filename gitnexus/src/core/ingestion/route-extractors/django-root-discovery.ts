import type { DjangoFileReader } from './django.js';

/**
 * Given a `manage.py` file content, extract the Django settings module.
 * e.g. `os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'cmrMngt.settings')`
 * returns `'cmrMngt.settings'`
 */
function extractDjangoSettingsModule(manageContent: string): string | null {
  const m = manageContent.match(/DJANGO_SETTINGS_MODULE\s*['"]?[,= ]\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

/**
 * Given a dotted Python module path, produce possible file paths.
 * e.g. `cmrMngt.settings` → `['cmrMngt/settings.py', 'cmrMngt/settings/__init__.py']`
 */
export function djangoModuleToFilePaths(modulePath: string): string[] {
  const base = modulePath.replace(/\./g, '/');
  return [`${base}.py`, `${base}/__init__.py`];
}

/**
 * Read a file, trying first the in-memory content map, then the optional
 * reader (typically a disk-backed reader on the main thread). The map keeps
 * already-loaded content cheap; the reader lets discovery reach files that
 * were never pre-loaded — critical because the relevant files (manage.py,
 * settings, the root urls.py) can be scattered across parse chunks.
 */
function tryReadFile(
  relativePath: string,
  contentMap: Map<string, string>,
  reader?: DjangoFileReader,
): string | null {
  return contentMap.get(relativePath) ?? reader?.(relativePath) ?? null;
}

/**
 * Extract a module-level string assignment value from Python source.
 * e.g. `content` contains `ROOT_URLCONF = 'cmrMngt.urls'`
 * returns `'cmrMngt.urls'`
 */
function extractPythonStringAssignment(content: string, varName: string): string | null {
  const regex = new RegExp(`^${varName}\\s*=\\s*['"]([^'"]+)['"]`, 'm');
  const m = content.match(regex);
  return m ? m[1] : null;
}

/**
 * Extract `from <module> import *` statements from Python source.
 * e.g. `from .settings_base import *` → `settings_base`
 *      `from cmrMngt.settings_base import *` → `cmrMngt.settings_base`
 */
function extractStarImports(content: string): string[] {
  const modules: string[] = [];
  const regex = /^from\s+(\.?[\w.]+)\s+import\s+\*/gm;
  let m;
  while ((m = regex.exec(content)) !== null) {
    // Relative (leading-dot) and absolute module names are both pushed verbatim;
    // the caller resolves relative ones against the current module path.
    modules.push(m[1]);
  }
  return modules;
}

/**
 * Resolve a relative Python import path.
 * `from .settings_base import *` in `cmrMngt/settings.py`
 * → `cmrMngt/settings_base.py`
 */
function resolveRelativeImport(currentModulePath: string, importPath: string): string | null {
  if (!importPath.startsWith('.')) return null;

  const currentDir = currentModulePath.includes('/')
    ? currentModulePath.substring(0, currentModulePath.lastIndexOf('/'))
    : '';

  let relPath = importPath;
  let dir = currentDir;
  while (relPath.startsWith('.')) {
    if (relPath.startsWith('..')) {
      dir = dir.includes('/') ? dir.substring(0, dir.lastIndexOf('/')) : '';
      relPath = relPath.substring(2);
    } else {
      relPath = relPath.substring(1);
      break;
    }
  }

  return dir ? `${dir}/${relPath}` : relPath;
}

/**
 * Resolve the root URL file for a SINGLE Django project rooted at `managePyPath`.
 *
 * Module paths in `manage.py`/`settings.py` are written relative to the
 * project directory (the one containing `manage.py`), NOT the repo root — so a
 * project under `backend/` declares `myproj.settings`, with the file living at
 * `backend/myproj/settings.py`. We therefore resolve every candidate against
 * the project directory first and the repo root second. `resolvedSettingsPath`
 * is kept project-dir-aware so the downstream star-import and urls-dir
 * resolution anchor correctly.
 */
function resolveDjangoProjectRoot(
  managePyPath: string,
  manageContent: string,
  map: Map<string, string>,
  reader?: DjangoFileReader,
): string | null {
  const projectDir = managePyPath.includes('/')
    ? managePyPath.substring(0, managePyPath.lastIndexOf('/'))
    : '';
  // Try the project dir first (the common subdir case), then the repo root.
  const bases = projectDir ? [`${projectDir}/`, ''] : [''];

  const settingsModule = extractDjangoSettingsModule(manageContent);
  if (!settingsModule) return null;
  const settingsSlash = settingsModule.replace(/\./g, '/');

  // Find the settings file, recording which base it resolved under so relative
  // imports and the urls-dir fallback stay anchored to the right directory.
  let settingsContent: string | null = null;
  let resolvedSettingsPath: string | null = null;
  for (const base of bases) {
    for (const sp of djangoModuleToFilePaths(settingsModule)) {
      const c = tryReadFile(base + sp, map, reader);
      if (c !== null) {
        settingsContent = c;
        resolvedSettingsPath = base + settingsSlash;
        break;
      }
    }
    if (settingsContent) break;
  }
  if (!settingsContent || resolvedSettingsPath === null) return null;

  // Check ROOT_URLCONF in the main settings and any base settings (star imports)
  let rootUrlConf = extractPythonStringAssignment(settingsContent, 'ROOT_URLCONF');
  if (!rootUrlConf) {
    // Check star-imported base settings
    const starImports = extractStarImports(settingsContent);
    for (const imp of starImports) {
      let baseModule: string | null = null;
      if (imp.startsWith('.')) {
        const resolved = resolveRelativeImport(resolvedSettingsPath, imp);
        if (resolved) baseModule = resolved;
      } else {
        baseModule = imp;
      }
      if (!baseModule) continue;

      // `baseModule` is always a slash-path here: a relative import is resolved
      // by `resolveRelativeImport` (which never returns a leading-dot path), and
      // an absolute import is the bare module name. So there is no remaining
      // dot-prefixed case to handle.
      const basePaths: string[] = [];
      const baseSlash = baseModule.replace(/\./g, '/');
      // A relative import (`imp` started with `.`) is already anchored under
      // the project dir via `resolvedSettingsPath`; an absolute module name
      // may live under the project dir OR the repo root.
      const candidateBases = imp.startsWith('.') ? [''] : bases;
      for (const cb of candidateBases) {
        basePaths.push(`${cb}${baseSlash}.py`);
        basePaths.push(`${cb}${baseSlash}/__init__.py`);
      }

      for (const bp of basePaths) {
        const bc = tryReadFile(bp, map, reader);
        if (bc) {
          rootUrlConf = extractPythonStringAssignment(bc, 'ROOT_URLCONF');
          if (rootUrlConf) break;
        }
      }
      if (rootUrlConf) break;
    }
  }

  if (!rootUrlConf) return null;

  // Convert ROOT_URLCONF module path to a file path, trying project dir then root.
  const urlPaths = djangoModuleToFilePaths(rootUrlConf);
  for (const base of bases) {
    for (const up of urlPaths) {
      if (tryReadFile(base + up, map, reader) !== null) return base + up;
    }
  }

  // Also try relative to the settings module's directory (project-dir-aware).
  if (resolvedSettingsPath.includes('/')) {
    const settingsDir = resolvedSettingsPath.substring(
      0,
      resolvedSettingsPath.lastIndexOf('/') + 1,
    );
    for (const up of urlPaths) {
      const tryPath = settingsDir + up;
      if (tryReadFile(tryPath, map, reader) !== null) return tryPath;
    }
  }

  return null;
}

/**
 * Discover the Django root URL file(s) by following, for EVERY `manage.py` in
 * the file set:
 *   manage.py → DJANGO_SETTINGS_MODULE → settings → ROOT_URLCONF → urls.py
 *
 * Returns one root urls path per discoverable Django project, so a monorepo
 * with several `manage.py` files (e.g. `serviceA/manage.py`, `serviceB/manage.py`)
 * yields every project's routes rather than only the first.
 *
 * @param files Array of file paths (content optional — when absent, `reader`
 *   resolves it on demand).
 * @param contentMap Optional pre-built map of file path → content.
 * @param reader Optional disk-backed reader for files not present in the map.
 * @returns De-duplicated relative paths to each project's root URL file (empty if none).
 */
export function discoverDjangoRootUrls(
  files: Array<{ path: string; content?: string }>,
  contentMap?: Map<string, string>,
  reader?: DjangoFileReader,
): string[] {
  const map = contentMap ?? new Map<string, string>();
  for (const f of files) if (f.content != null) map.set(f.path, f.content);

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (f.path !== 'manage.py' && !f.path.endsWith('/manage.py')) continue;
    const manageContent = f.content ?? tryReadFile(f.path, map, reader);
    if (!manageContent) continue;
    const root = resolveDjangoProjectRoot(f.path, manageContent, map, reader);
    if (root !== null && !seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}
