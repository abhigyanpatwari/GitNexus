/**
 * Binding Accumulator — model module facade re-export (SM-20).
 *
 * NOTE: This file is a facade, NOT a model implementation. The actual
 * BindingAccumulator lives in `../binding-accumulator.ts` (parent module).
 * It is re-exported here so consumers can import all resolution-time data
 * structures through the unified `model/` module boundary via `model/index.ts`.
 *
 * Do not add registry logic to this file. If a new binding-related type or
 * helper is needed, add it to the parent `binding-accumulator.ts` and
 * re-export it from here.
 */

export {
  BindingAccumulator,
  type BindingEntry,
  type EnrichmentGraphNode,
  type EnrichmentGraphLookup,
  enrichExportedTypeMap,
} from '../binding-accumulator.js';
