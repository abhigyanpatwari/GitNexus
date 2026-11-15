/**
 * Benchmark-only adapter for routes.ts at 565e502. Keep the historical bucket
 * copying and repeated scans: those are the costs this benchmark compares.
 * The source hash prevents silently applying this adapter to another baseline.
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const SOURCE_HASH = '0ad2c5cebf550a6e0b25c52f6edaa1ea268f0fc138156616f179ef620d1a912e';
const moduleStem = (filePath) => filePath.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');

function loadBaselineClosure(sourceRoot) {
  const source = readFileSync(join(sourceRoot, 'src/core/ingestion/pipeline-phases/routes.ts'));
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    SOURCE_HASH,
    'the legacy classifier adapter only matches the pinned pre-fix routes.ts',
  );
  return (wrapperDefs, configuredWrappers = []) => {
    const wrapperNames = new Set([
      ...wrapperDefs.filter((d) => d.seed).map((d) => d.functionName),
      ...configuredWrappers,
    ]);
    const carriers = new Set(wrapperDefs.filter((d) => d.forwardsUrl));
    const defsByName = new Map();
    const defsByModule = new Map();
    for (const def of wrapperDefs) {
      const key = `${moduleStem(def.filePath)}\0${def.functionName}`;
      defsByName.set(def.functionName, [...(defsByName.get(def.functionName) ?? []), def]);
      defsByModule.set(key, [...(defsByModule.get(key) ?? []), def]);
    }
    const carriesUrl = ({ callee, module }) =>
      configuredWrappers.includes(callee) ||
      (module === null
        ? (defsByName.get(callee)?.every((def) => carriers.has(def)) ?? false)
        : (defsByModule.get(`${module}\0${callee}`)?.some((def) => carriers.has(def)) ?? false));
    for (let grew = true; grew; ) {
      grew = false;
      for (const def of wrapperDefs) {
        if (carriers.has(def) || !def.forwardsTo.some(carriesUrl)) continue;
        carriers.add(def);
        wrapperNames.add(def.functionName);
        grew = true;
      }
    }
    return {
      isWrapperCall: ({ functionName, module, declaredName }) =>
        configuredWrappers.includes(functionName) ||
        (module === undefined
          ? wrapperNames.has(functionName)
          : (defsByModule
              .get(`${module}\0${declaredName ?? functionName}`)
              ?.some((def) => def.seed || carriers.has(def)) ?? false)),
    };
  };
}

module.exports = { loadBaselineClosure, moduleStem };
