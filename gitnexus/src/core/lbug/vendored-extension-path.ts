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

export const readFtsArtifactManifest = (
  vendorRoot: string = defaultVendorRoot(),
): FtsArtifactManifest => {
  const manifestPath = path.join(vendorRoot, 'lbug-fts', 'manifest.json');
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as FtsArtifactManifest;
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
