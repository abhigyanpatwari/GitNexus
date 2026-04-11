/**
 * Binding Accumulator — model module re-export (SM-20).
 *
 * Re-exports the BindingAccumulator class and related types from the parent
 * module so that consumers can import binding data through the unified
 * `model/` module boundary.
 */

export {
  BindingAccumulator,
  type BindingEntry,
  type EnrichmentGraphNode,
  type EnrichmentGraphLookup,
  enrichExportedTypeMap,
} from '../binding-accumulator.js';
