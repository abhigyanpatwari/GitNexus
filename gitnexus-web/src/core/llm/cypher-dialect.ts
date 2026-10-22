/** Shared by the agent prompt, Cypher tool description, and error feedback. */
export const CYPHER_DIALECT_GUIDANCE = `This graph uses LadybugDB Cypher, not Neo4j Cypher.
- Match a single node type in the pattern: MATCH (n:Function).
- For mixed node types, use WHERE label(n) IN ['Function', 'Method', 'Class'].
- Return the node type with label(n) AS kind, not labels(n) or labels(n)[0].
- Do not use label predicates such as WHERE n:Function OR n:Method; put labels in the MATCH pattern or filter with label(n).
- On a syntax error, correct the query using these rules and retry.`;
