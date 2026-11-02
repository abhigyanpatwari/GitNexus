/**
 * The `reason` text stamped on the USES edge a `value-ref` site emits.
 *
 * A leaf module on purpose. Two modules need this string and they sit on
 * opposite sides of the product: `passes/property-dispatch.ts` writes it at
 * analysis time, and `mcp/local/local-backend.ts` reads it back at query time
 * to decide whether an answer is `exact`. Re-typing the literal in the reader
 * would make the epistemic signal fail SILENTLY the day the writer's text is
 * reworded — the query would simply match nothing and every answer would go
 * back to claiming certainty, which is the exact defect (#3399) this constant
 * exists to close. Importing `property-dispatch.ts` for it instead would drag
 * the whole scope-resolution emit graph into the MCP backend for one string.
 */
export const VALUE_REF_EDGE_REASON = 'scope-resolution: value-ref';
