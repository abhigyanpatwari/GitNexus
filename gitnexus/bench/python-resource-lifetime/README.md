# Python resource lifetimes

The fixture in `test/fixtures/fastapi-resource-lifetime` has a route that registers a listener on a session supplied by a yielding FastAPI dependency. Follow the handler’s existing `CALLS` edge to the provider, then inspect the provider’s lifetime facts.

```cypher
MATCH (f:Function)-[o:CodeRelation]->(r:CodeElement)-[c:CodeRelation]->(s:CodeElement)
WHERE o.type IN ['OWNS_RESOURCE', 'MANAGES_CONTEXT'] AND c.type = 'CLEANUP_AT'
RETURN f.name, o.type, r.name, r.startLine, s.name, s.startLine, s.endLine
```

`OWNS_RESOURCE` identifies a local acquired binding that the generator yields and explicitly closes in a straight-line `finally` suite. Its cleanup site spans the call. For a single `with` or `async with` item, `MANAGES_CONTEXT` identifies the manager expression and the cleanup site spans the suite whose exit invokes the context protocol. The object returned by a manager can be borrowed. Open-ended factory returns, conditional cleanup, and cleanup of a different binding leave ownership unknown. These facts describe source operations. They do not establish that a callback was removed at runtime.

From `gitnexus/`, run `npm run build` and `node bench/python-resource-lifetime/measure.mjs`. The benchmark times extraction on already-parsed functions at three corpus sizes, checks the expected fact count, and reports median milliseconds after warmup.
