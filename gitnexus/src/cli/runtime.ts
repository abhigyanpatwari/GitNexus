import path from 'node:path';
import {
  findRepo,
  readRegistry,
  resolveRegistryEntry,
  type RegistryEntry,
} from '../storage/repo-manager.js';
import {
  importRuntimeFile,
  mergeRuntimeSignalStores,
  readRuntimeSignalStore,
  writeRuntimeSignalStore,
  type RuntimeImportFormat,
} from '../core/runtime/overlay.js';
import { LocalBackend } from '../mcp/local/local-backend.js';

interface RuntimeImportOptions {
  repo?: string;
  format?: RuntimeImportFormat;
  replace?: boolean;
  json?: boolean;
}

interface RuntimeContextOptions {
  repo?: string;
  target?: string;
  uid?: string;
  file?: string;
  kind?: string;
  route?: string;
  service?: string;
  json?: boolean;
}

async function resolveRuntimeRepo(repoParam?: string): Promise<RegistryEntry> {
  const registry = await readRegistry();
  if (repoParam) return resolveRegistryEntry(registry, repoParam);

  const found = await findRepo(process.cwd());
  if (found) {
    const entry = registry.find((item) => path.resolve(item.path) === path.resolve(found.repoPath));
    if (entry) return entry;
    return {
      name: path.basename(found.repoPath),
      path: found.repoPath,
      storagePath: found.storagePath,
      indexedAt: found.meta.indexedAt,
      lastCommit: found.meta.lastCommit,
      remoteUrl: found.meta.remoteUrl,
      stats: found.meta.stats,
    };
  }

  throw new Error(
    'No indexed repository found. Pass --repo <name-or-path> or run from a repo with .gitnexus.',
  );
}

export const runtimeImportCommand = async (
  input: string,
  options: RuntimeImportOptions = {},
): Promise<void> => {
  try {
    const repo = await resolveRuntimeRepo(options.repo);
    const signalPath = path.join(repo.storagePath, 'runtime-signals.json');
    const next = await importRuntimeFile(input, options.format ?? 'auto');
    const existing = options.replace ? null : await readRuntimeSignalStore(signalPath);
    const merged = existing ? mergeRuntimeSignalStores([existing, next]) : next;
    await writeRuntimeSignalStore(signalPath, merged);

    const summary = {
      repo: repo.name,
      path: signalPath,
      services: merged.services.length,
      routes: merged.routes.length,
      spans: merged.spans.length,
      errors: merged.errors.length,
      logPatterns: merged.logPatterns.length,
      logs: merged.logs.length,
    };

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log(`Runtime overlay imported for ${repo.name}`);
    console.log(`  ${signalPath}`);
    console.log(
      `  services=${summary.services} routes=${summary.routes} spans=${summary.spans} errors=${summary.errors} logPatterns=${summary.logPatterns} logs=${summary.logs}`,
    );
  } catch (err) {
    console.error(`Runtime import failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
};

export const runtimeContextCommand = async (options: RuntimeContextOptions = {}): Promise<void> => {
  const backend = new LocalBackend();
  try {
    await backend.init();
    const result = await backend.callTool('runtime_context', {
      repo: options.repo,
      target: options.target,
      target_uid: options.uid,
      file_path: options.file,
      kind: options.kind,
      route: options.route,
      service: options.service,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Runtime context failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await backend.dispose().catch(() => {});
  }
};
