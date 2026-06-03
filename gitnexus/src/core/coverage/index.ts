// gitnexus/src/core/coverage/index.ts
export * from './types.js';
export { CoverageStore, openCoverageStore } from './store.js';
export { ingestCoverage } from './ingestor.js';
export { streamIngest } from './streaming.js';
export { mergeRuns } from './merger.js';
export { parseLcov } from './parsers/lcov.js';
export { parseGoCover } from './parsers/go-cover.js';
export { parseGenericCoverage } from './parsers/generic.js';
export { writeCoverageToGraph, removeCoverageFromGraph } from './graph-bridge.js';
