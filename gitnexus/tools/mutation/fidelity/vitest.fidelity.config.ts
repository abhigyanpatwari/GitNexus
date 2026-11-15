/**
 * Vitest config of gate 1's Stryker run (U6): tools/mutation/vitest.mutation.config.ts unchanged,
 * plus one observation plugin. The runner's unmutated run uses it through the scope driver's
 * `vitest` option (project `mutation`, so task ids match real mutation runs).
 *
 * The plugin's `configureVitest` hook, for the `mutation` project:
 *  - installs the gate 1 recorder setup file exactly as the base run does (record.ts
 *    `installRecorder`);
 *  - captures the resolved config into GITNEXUS_MUTATION_FIDELITY_DIR when the project is created
 *    and again when Vitest closes (after the runner has added its own setup file), one file per
 *    runner process (record.ts `ConfigRecord`).
 * Config snapshots leave this plugin out, so it is not a config difference itself.
 */
import { defineConfig } from 'vitest/config';
import type { Vite, VitestPluginContext } from 'vitest/node';
import mutationConfig from '../vitest.mutation.config.js';
import {
  CONFIG_RECORD_PREFIX,
  FIDELITY_DIR_ENV,
  FIDELITY_PLUGIN_NAME,
  RECORD_SCHEMA_VERSION,
  installRecorder,
  snapshotConfig,
  writeRecordFile,
  type ConfigRecord,
} from './record.js';

const recordDir = process.env[FIDELITY_DIR_ENV];
if (recordDir === undefined || recordDir === '') {
  throw new Error(`vitest.fidelity.config: ${FIDELITY_DIR_ENV} is not set`);
}

function fidelityPlugin(dir: string): Vite.Plugin {
  return {
    name: FIDELITY_PLUGIN_NAME,
    configureVitest({ project, vitest }: VitestPluginContext) {
      installRecorder(project);
      const write = (final: boolean): void => {
        const record: ConfigRecord = {
          schemaVersion: RECORD_SCHEMA_VERSION,
          pid: process.pid,
          final,
          snapshot: snapshotConfig(project, vitest),
        };
        writeRecordFile(dir, `${CONFIG_RECORD_PREFIX}${process.pid}-${project.name}.json`, record);
      };
      write(false);
      vitest.onClose(() => write(true));
    },
  };
}

export default defineConfig({
  ...mutationConfig,
  plugins: [...(mutationConfig.plugins ?? []), fidelityPlugin(recordDir)],
});
