import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { VENDOR_ROOT } from '../vendor-root.js';

/**
 * Resolve the packaged FTS extension for this process's Node platform tuple.
 *
 * Lives here (not in extension-loader) so the doctor startup probe can share
 * the same path without importing the loader, which statically pulls lbug-config.
 */
const DEFAULT_FILENAME = 'libfts.lbug_extension';

export const defaultVendorRoot = (): string => VENDOR_ROOT;

export const nodePlatformTuple = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string => `${platform}-${arch}`;

export interface FtsArtifactManifest {
  coreVersion?: string;
  extensionVersion?: string;
  filename?: string;
  unsupportedTuples?: Array<{ tuple: string; reason?: string }>;
}

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Drop non-array / non-object entries so `.some(entry => entry.tuple)` cannot throw. */
const asUnsupportedTuples = (value: unknown): FtsArtifactManifest['unsupportedTuples'] => {
  if (!Array.isArray(value)) return undefined;
  const entries: Array<{ tuple: string; reason?: string }> = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const tuple = (entry as { tuple?: unknown }).tuple;
    if (typeof tuple !== 'string' || tuple.length === 0) continue;
    const reason = (entry as { reason?: unknown }).reason;
    entries.push({
      tuple,
      ...(typeof reason === 'string' ? { reason } : {}),
    });
  }
  return entries;
};

export const readFtsArtifactManifest = (
  vendorRoot: string = defaultVendorRoot(),
): FtsArtifactManifest => {
  const manifestPath = path.join(vendorRoot, 'lbug-fts', 'manifest.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      return {
        coreVersion: asOptionalString(rec.coreVersion),
        extensionVersion: asOptionalString(rec.extensionVersion),
        filename: asOptionalString(rec.filename),
        unsupportedTuples: asUnsupportedTuples(rec.unsupportedTuples),
      };
    }
    return {};
  } catch {
    return {};
  }
};

export const isUnsupportedFtsTuple = (
  tuple: string,
  vendorRoot: string = defaultVendorRoot(),
): boolean =>
  (readFtsArtifactManifest(vendorRoot).unsupportedTuples ?? []).some(
    (entry) => entry.tuple === tuple,
  );

/** Relative-path containment — not a prefix match (rejects `vendor-evil`). */
export const isPathInsideRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative)) return false;
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..';
};

export const validateVendoredExtensionPath = (
  candidate: string,
  vendorRoot: string,
): string | null => {
  let realFile: string;
  let realRoot: string;
  try {
    realFile = realpathSync(candidate);
    realRoot = realpathSync(vendorRoot);
  } catch {
    return null;
  }
  if (!/\.lbug_extension$/i.test(realFile)) return null;
  if (!isPathInsideRoot(realRoot, realFile)) return null;
  return realFile;
};

export const inferExtensionVersionFromPath = (
  filePath: string | null | undefined,
): string | undefined => {
  if (!filePath) return undefined;
  const home = /[/\\]extension[/\\](\d+\.\d+\.\d+)[/\\]/.exec(filePath);
  return home?.[1];
};

export const resolveFtsVersionPair = (
  inspectPath?: string | null,
  vendorRoot?: string,
): { expected?: string; found?: string } => {
  // Ladybug's home path is `~/.lbdb/extension/<coreVersion>/…`. Compare that
  // directory to the packaged core pin, not the (often different) artifact
  // version, or a matching runtime looks skewed.
  const expected = readFtsArtifactManifest(vendorRoot).coreVersion;
  const found = inferExtensionVersionFromPath(inspectPath);
  return { expected, found };
};

export const resolveVendoredFtsPath = (opts?: {
  tuple?: string;
  vendorRoot?: string;
  filename?: string;
}): string | null => {
  const vendorRoot = opts?.vendorRoot ?? defaultVendorRoot();
  const tuple = opts?.tuple ?? nodePlatformTuple();
  const filename =
    opts?.filename ?? readFtsArtifactManifest(vendorRoot).filename ?? DEFAULT_FILENAME;
  const candidate = path.resolve(vendorRoot, 'lbug-fts', 'prebuilds', tuple, filename);
  if (!existsSync(candidate)) return null;
  return validateVendoredExtensionPath(candidate, vendorRoot);
};
