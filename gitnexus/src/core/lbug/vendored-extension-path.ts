import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Resolve the packaged FTS extension for this process's Node platform tuple.
 *
 * Lives here (not in extension-loader) so the doctor startup probe can share
 * the same path without importing the loader, which statically pulls lbug-config.
 * U2 will attach descriptor-based LOAD to this resolver; U1 fills the prebuilds.
 */
const DEFAULT_FILENAME = 'libfts.lbug_extension';

export const defaultVendorRoot = (): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'vendor');

export const nodePlatformTuple = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string => `${platform}-${arch}`;

export interface FtsArtifactManifest {
  coreVersion?: string;
  extensionVersion?: string;
  filename?: string;
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
  return existsSync(candidate) ? candidate : null;
};
