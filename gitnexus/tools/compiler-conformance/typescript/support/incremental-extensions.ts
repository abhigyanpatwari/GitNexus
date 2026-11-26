import { after, afterEach, mock } from 'node:test';
import * as adapter from '../../../../dist/core/lbug/lbug-adapter.js';
import { resolveAnalyzeInstallPolicy } from '../../../../dist/core/lbug/extension-loader.js';
import { createTempDir } from '../../../../test/helpers/test-db.js';
import { isolateAnalysisHome } from './analysis-home.js';

/** Observe the catalog on the writer's live connection, immediately before native DML or COPY. */
export async function incrementalExtensions() {
  await isolateAnalysisHome();
  const observe: { beforeDelete?: () => Promise<void>; beforeCopy?: () => Promise<void> } = {};
  const replacement = mock.module(
    new URL('../../../../dist/core/lbug/lbug-adapter.js', import.meta.url).href,
    {
      namedExports: {
        ...adapter,
        async deleteNodesForFiles(...args: Parameters<typeof adapter.deleteNodesForFiles>) {
          await observe.beforeDelete?.();
          return adapter.deleteNodesForFiles(...args);
        },
        async loadGraphToLbug(...args: Parameters<typeof adapter.loadGraphToLbug>) {
          await observe.beforeCopy?.();
          return adapter.loadGraphToLbug(...args);
        },
      },
    },
  );
  afterEach(() => {
    delete observe.beforeDelete;
    delete observe.beforeCopy;
  });
  after(() => replacement.restore());
  return observe;
}

/** A required extension failing to load must fail CI even when its test could otherwise skip. */
export async function extensionAvailable(name: 'FTS' | 'VECTOR') {
  const probe = await createTempDir('gitnexus-extension-probe-');
  try {
    await adapter.initLbug(probe.dbPath);
    const load = name === 'FTS' ? adapter.loadFTSExtension : adapter.loadVectorExtension;
    const available = await load(undefined, { policy: resolveAnalyzeInstallPolicy() });
    if (!available && process.env[`GITNEXUS_REQUIRE_${name}`] === '1') {
      throw new Error(`The required LadybugDB ${name} extension is unavailable`);
    }
    return available;
  } finally {
    await adapter.closeLbug();
    await probe.cleanup();
  }
}
