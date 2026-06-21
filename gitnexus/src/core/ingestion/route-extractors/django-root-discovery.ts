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

/** Reader callback resolving a repo-relative path to file content (or null). */
type DjangoFileReader = (relativePath: string) => string | null;

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
    const moduleName = m[1];
    if (moduleName.startsWith('.')) {
      // Relative import — caller needs to resolve based on current module
      modules.push(moduleName);
    } else {
      modules.push(moduleName);
    }
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
 * Discover the Django root URL file by following:
 *   manage.py → DJANGO_SETTINGS_MODULE → settings → ROOT_URLCONF → urls.py
 *
 * @param files Array of file paths (content optional — when absent, `reader`
 *   resolves it on demand).
 * @param contentMap Optional pre-built map of file path → content.
 * @param reader Optional disk-backed reader for files not present in the map.
 * @returns The relative path to the root URL file, or null.
 */
export function discoverDjangoRootUrl(
  files: Array<{ path: string; content?: string }>,
  contentMap?: Map<string, string>,
  reader?: DjangoFileReader,
): string | null {
  const map = contentMap ?? new Map<string, string>();
  for (const f of files) if (f.content != null) map.set(f.path, f.content);

  const managePy = files.find((f) => f.path === 'manage.py' || f.path.endsWith('/manage.py'));
  if (!managePy) return null;

  const manageContent = managePy.content ?? tryReadFile(managePy.path, map, reader);
  if (!manageContent) return null;

  const settingsModule = extractDjangoSettingsModule(manageContent);
  if (!settingsModule) return null;

  // Find the settings file
  const settingsPaths = djangoModuleToFilePaths(settingsModule);
  let settingsContent: string | null = null;
  let resolvedSettingsPath: string | null = null;
  for (const sp of settingsPaths) {
    const c = tryReadFile(sp, map, reader);
    if (c !== null) {
      settingsContent = c;
      resolvedSettingsPath = settingsModule.replace(/\./g, '/');
      break;
    }
  }
  if (!settingsContent) return null;

  // Check ROOT_URLCONF in the main settings and any base settings (star imports)
  let rootUrlConf = extractPythonStringAssignment(settingsContent, 'ROOT_URLCONF');
  if (!rootUrlConf) {
    // Check star-imported base settings
    const starImports = extractStarImports(settingsContent);
    for (const imp of starImports) {
      let baseModule: string | null = null;
      if (imp.startsWith('.')) {
        const resolved = resolveRelativeImport(resolvedSettingsPath!, imp);
        if (resolved) baseModule = resolved;
      } else {
        baseModule = imp;
      }
      if (!baseModule) continue;

      const basePaths: string[] = [];
      if (baseModule.startsWith('.')) {
        const resolved = resolveRelativeImport(resolvedSettingsPath!, baseModule);
        if (resolved) {
          basePaths.push(`${resolved.replace(/\./g, '/')}.py`);
          basePaths.push(`${resolved.replace(/\./g, '/')}/__init__.py`);
        }
      } else {
        basePaths.push(`${baseModule.replace(/\./g, '/')}.py`);
        basePaths.push(`${baseModule.replace(/\./g, '/')}/__init__.py`);
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

  // Convert ROOT_URLCONF module path to file path
  const urlPaths = djangoModuleToFilePaths(rootUrlConf);
  for (const up of urlPaths) {
    if (tryReadFile(up, map, reader) !== null) return up;
  }

  // Also try relative to the settings module's directory
  if (resolvedSettingsPath && resolvedSettingsPath.includes('/')) {
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
