/**
 * MCP Tool Definitions
 *
 * Defines the tools that GitNexus exposes to external AI agents.
 * All tools support an optional `repo` parameter for multi-repo setups.
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description?: string;
        default?: unknown;
        items?: { type: string };
        enum?: string[];
        minimum?: number;
        maximum?: number;
        minLength?: number;
      }
    >;
    required: string[];
  };
}

const READ_ONLY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const QUERY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const DESTRUCTIVE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * Pagination bounds for the `list_repos` tool. Exported so the backend
 * validation (`local-backend.ts`) and the schema below stay a single source of
 * truth. `list_repos` is paginated to keep its response under MCP/LLM token
 * truncation limits when many repos are indexed (#2119); the default page is
 * small enough to render safely, and `LIST_REPOS_MAX_LIMIT` caps how much a
 * caller can pull in one request.
 */
export const LIST_REPOS_DEFAULT_LIMIT = 50;
export const LIST_REPOS_MAX_LIMIT = 200;

/**
 * Pagination bounds for the `explain` tool (#2083 M3 U6). Findings are sparse
 * and capped per function at analyze time, but a large repo can still
 * accumulate enough TAINTED rows to blow MCP/LLM token limits — the response
 * is page-bounded like `list_repos`. Exported so the backend clamp
 * (`local-backend.ts`) and the schema stay a single source of truth.
 */
export const EXPLAIN_DEFAULT_LIMIT = 50;
export const EXPLAIN_MAX_LIMIT = 200;

// pdg_query result-page bounds (#2086 M6). Mirror the EXPLAIN_* limits — the
// no-rel-index path means every page must be anchored + LIMIT-bounded.
export const PDG_QUERY_DEFAULT_LIMIT = 50;
export const PDG_QUERY_MAX_LIMIT = 200;

// Shared impact traversal depth cap. The MCP schema advertises this bound;
// PDG direct backend callers also enforce it before running traversal.
export const IMPACT_MAX_DEPTH = 32;

export const GITNEXUS_TOOLS: ToolDefinition[] = [
  {
    name: 'list_repos',
    description: `List indexed repositories available to GitNexus (paginated).

Returns a page of repositories — each with name, path, indexed date, last commit, and stats — plus a "pagination" object: { total, limit, offset, returned, hasMore, nextOffset }.

PAGINATION: Results are paginated so a large registry is not truncated by MCP/LLM token limits. "limit" sets the page size (default ${LIST_REPOS_DEFAULT_LIMIT}, max ${LIST_REPOS_MAX_LIMIT}; values above the max are rejected, not capped). "offset" selects the start. To enumerate EVERY repository: when pagination.hasMore is true, call list_repos again with offset set to pagination.nextOffset, and repeat until hasMore is false. Repositories are returned in a stable order, so paging never skips or duplicates an entry while the registry is unchanged.

WHEN TO USE: First step when multiple repos are indexed, or to discover available repos.
AFTER THIS: READ gitnexus://repo/{name}/context for the repo you want to work with.

When multiple repos are indexed, you MUST specify the "repo" parameter
on other tools (query, context, impact, etc.) to target the correct one.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: `Max repositories to return in this page (default: ${LIST_REPOS_DEFAULT_LIMIT}, min: 1, max: ${LIST_REPOS_MAX_LIMIT}). Values outside [1, ${LIST_REPOS_MAX_LIMIT}] are rejected.`,
          default: LIST_REPOS_DEFAULT_LIMIT,
          minimum: 1,
          maximum: LIST_REPOS_MAX_LIMIT,
        },
        offset: {
          type: 'integer',
          description:
            'Number of repositories to skip before this page (default: 0). Pass pagination.nextOffset from the previous response to fetch the next page.',
          default: 0,
          minimum: 0,
        },
      },
      required: [],
    },
  },
  {
    name: 'query',
    description: `Query the code knowledge graph for execution flows related to a concept.
Returns processes (call chains) ranked by relevance, each with its symbols and file locations.

WHEN TO USE: Understanding how code works together. Use this when you need execution flows and relationships, not just file matches. Complements grep/IDE search.
AFTER THIS: Use context() on a specific symbol for 360-degree view (callers, callees, categorized refs).

Returns results grouped by process (execution flow):
- processes: ranked execution flows with relevance priority
- process_symbols: all symbols in those flows with file locations and module (functional area)
- definitions: standalone types/interfaces not in any process

Hybrid ranking: BM25 keyword + semantic vector search, ranked by Reciprocal Rank Fusion.

GROUP MODE: set "repo" to "@<groupName>" to search all member repos in that group (merged via RRF), or "@<groupName>/<groupRepoPath>" to run against a single member (same path keys as in group.yaml). If you use "@<groupName>" only, the member repo defaults to the lexicographically first key in group.yaml "repos". Prefer resources for contracts/status (see migration from legacy group_* tools).

SERVICE: optional monorepo path prefix (POSIX-style, case-sensitive segments). When "repo" starts with "@", only processes whose symbols fall under that prefix are included. For a normal indexed repo name (no leading @), this field is currently ignored by the server.`,
    annotations: QUERY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        // #2175: the legacy `query` key is still accepted by the handler
        // (resolveAliasString in local-backend.ts), but is deliberately NOT named in the
        // advertised property or its description — surfacing "query" in the schema an LLM
        // reads would nudge it to send `query`, the exact argument Claude Code drops.
        search_query: {
          type: 'string',
          description: 'Natural language or keyword search query.',
        },
        task_context: {
          type: 'string',
          description: 'What you are working on (e.g., "adding OAuth support"). Helps ranking.',
        },
        goal: {
          type: 'string',
          description:
            'What you want to find (e.g., "existing auth validation logic"). Helps ranking.',
        },
        limit: {
          type: 'number',
          description: 'Max processes to return (default: 5)',
          default: 5,
          minimum: 1,
          maximum: 100,
        },
        max_symbols: {
          type: 'number',
          description: 'Max symbols per process (default: 10)',
          default: 10,
          minimum: 1,
          maximum: 200,
        },
        include_content: {
          type: 'boolean',
          description: 'Include full symbol source code (default: false)',
          default: false,
        },
        repo: {
          type: 'string',
          description:
            'Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>" (member path keys from group.yaml). Omit when only one indexed repo exists.',
        },
        service: {
          type: 'string',
          minLength: 1,
          description:
            'Optional monorepo service root (relative path, "/" separators). In group mode (@repo), prefix-matches symbol file paths; ignored for a normal repo name. Empty string is rejected server-side.',
        },
      },
      required: ['search_query'],
    },
  },
  {
    name: 'cypher',
    description: `Execute Cypher query against the code knowledge graph.

WHEN TO USE: Complex structural queries that search/explore can't answer. READ gitnexus://repo/{name}/schema first for the full schema.
AFTER THIS: Use context() on result symbols for deeper context.

SCHEMA:
- Nodes: File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process, Route, Tool
- Multi-language nodes (use backticks): \`Struct\`, \`Enum\`, \`Trait\`, \`Impl\`, etc.
- All edges via single CodeRelation table with 'type' property
- Edge types: CONTAINS, DEFINES, CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, ACCESSES, METHOD_OVERRIDES, METHOD_IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS, HANDLES_ROUTE, FETCHES, HANDLES_TOOL, ENTRY_POINT_OF
- Edge properties: type (STRING), confidence (DOUBLE), reason (STRING), step (INT32)

EXAMPLES:
• Find callers of a function:
  MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b:Function {name: "validateUser"}) RETURN a.name, a.filePath

• Find community members:
  MATCH (f)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community) WHERE c.heuristicLabel = "Auth" RETURN f.name

• Trace a process:
  MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process) WHERE p.heuristicLabel = "UserLogin" RETURN s.name, r.step ORDER BY r.step

• Find all methods of a class:
  MATCH (c:Class {name: "UserService"})-[r:CodeRelation {type: 'HAS_METHOD'}]->(m:Method) RETURN m.name, m.parameterCount, m.returnType

• Find all properties of a class:
  MATCH (c:Class {name: "User"})-[r:CodeRelation {type: 'HAS_PROPERTY'}]->(p:Property) RETURN p.name, p.declaredType

• Find all writers of a field:
  MATCH (f:Function)-[r:CodeRelation {type: 'ACCESSES', reason: 'write'}]->(p:Property) WHERE p.name = "address" RETURN f.name, f.filePath

• Find method overrides (MRO resolution):
  MATCH (winner:Method)-[r:CodeRelation {type: 'METHOD_OVERRIDES'}]->(loser:Method) RETURN winner.name, winner.filePath, loser.filePath, r.reason

• Detect diamond inheritance:
  MATCH (d:Class)-[:CodeRelation {type: 'EXTENDS'}]->(b1), (d)-[:CodeRelation {type: 'EXTENDS'}]->(b2), (b1)-[:CodeRelation {type: 'EXTENDS'}]->(a), (b2)-[:CodeRelation {type: 'EXTENDS'}]->(a) WHERE b1 <> b2 RETURN d.name, b1.name, b2.name, a.name

OUTPUT: Returns { markdown, row_count } — results formatted as a Markdown table for easy reading.

TIPS:
- All relationships use single CodeRelation table — filter with {type: 'CALLS'} etc.
- Community = auto-detected functional area (Leiden algorithm). Properties: heuristicLabel, cohesion, symbolCount, keywords, description, enrichedBy
- Process = execution flow trace from entry point to terminal. Properties: heuristicLabel, processType, stepCount, communities, entryPointId, terminalId
- Use heuristicLabel (not label) for human-readable community/process names
- PDG layers (only when indexed with \`--pdg\`): BasicBlock nodes + CFG / CDG (control dependence, branch sense 'T'|'F' in reason) / REACHING_DEF (def→use, variable in reason) edges, all BasicBlock→BasicBlock. Prefer the \`pdg_query\` tool — it anchors + bounds these for you (raw \`[:CDG*]\`/\`[:REACHING_DEF*]\` path scans are unindexed and unbounded).`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        // #2175: the legacy `query` key is still accepted by the handler
        // (resolveAliasString in local-backend.ts), but is deliberately NOT named in the
        // advertised property or its description — surfacing "query" in the schema an LLM
        // reads would nudge it to send `query`, the exact argument Claude Code drops.
        statement: {
          type: 'string',
          description: 'Cypher statement to execute.',
        },
        params: {
          type: 'object',
          description:
            'Optional query parameters for placeholders (e.g. $name) to execute via prepared statement binding.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['statement'],
    },
  },
  {
    name: 'context',
    description: `360-degree view of a single code symbol.
Shows categorized incoming/outgoing references (calls, imports, extends, implements, methods, properties, overrides), process participation, and file location.

WHEN TO USE: After query() to understand a specific symbol in depth. When you need to know all callers, callees, and what execution flows a symbol participates in.
AFTER THIS: Use impact() if planning changes, or READ gitnexus://repo/{name}/process/{processName} for full execution trace.

Handles disambiguation: if multiple symbols share the same name, returns ranked candidates (each with a relevance score) for you to pick from. Use uid for zero-ambiguity lookup, or narrow the search with file_path and/or kind hints.

NOTE: ACCESSES edges (field read/write tracking) are included in context results with reason 'read' or 'write'. CALLS edges resolve through field access chains and method-call chains (e.g., user.address.getCity().save() produces CALLS edges at each step).

GROUP MODE: set "repo" to "@<groupName>" to run context in each member repo (aggregated list), or "@<groupName>/<groupRepoPath>" for one member. If you use "@<groupName>" only, the member defaults to the lexicographically first key in group.yaml "repos".

SERVICE: optional monorepo path prefix (case-sensitive path segments). When "repo" starts with "@", prefix-matches resolved symbol file paths; when a hit is outside the prefix, that member returns an empty payload for the symbol. Ignored for a normal indexed repo name.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (e.g., "validateUser", "AuthService")' },
        uid: {
          type: 'string',
          description: 'Direct symbol UID from prior tool results (zero-ambiguity lookup)',
        },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        kind: {
          type: 'string',
          description:
            "Kind filter to disambiguate common names (e.g. 'Function', 'Class', 'Method', 'Interface', 'Constructor')",
        },
        include_content: {
          type: 'boolean',
          description: 'Include full symbol source code (default: false)',
          default: false,
        },
        repo: {
          type: 'string',
          description:
            'Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>". Omit if only one repo is indexed.',
        },
        service: {
          type: 'string',
          minLength: 1,
          description:
            'Optional monorepo service root (relative path). Applies in group mode (@repo) only; ignored for a normal repo name. Empty string is rejected server-side.',
        },
      },
      required: [],
    },
  },
  {
    name: 'detect_changes',
    description: `Analyze uncommitted git changes and find affected execution flows.
Maps git diff hunks to indexed symbols, then traces which processes are impacted.

WHEN TO USE: Before committing — to understand what your changes affect. Pre-commit review, PR preparation.
AFTER THIS: Review affected processes. Use context() on high-risk symbols. READ gitnexus://repo/{name}/process/{name} for full traces.

GIT WORKTREE SUPPORT: GitNexus automatically detects when the MCP server was launched from inside a linked git worktree and runs git diff against that worktree — no extra parameters needed in the common case. Pass "worktree" explicitly only when the server was started from a different directory than the worktree you are editing (e.g., the server runs from the canonical root but your changes are in a linked worktree at a different path).

Returns: changed symbols, affected processes, and a risk summary.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'What to analyze: "unstaged" (default), "staged", "all", or "compare"',
          enum: ['unstaged', 'staged', 'all', 'compare'],
          default: 'unstaged',
        },
        base_ref: {
          type: 'string',
          description: 'Branch/commit for "compare" scope (e.g., "main")',
        },
        worktree: {
          type: 'string',
          description:
            'Absolute path to a linked git worktree. Pass this when your changes are in a worktree (the .git entry at that path is a file, not a directory). GitNexus will run git diff from that worktree so staged/unstaged changes are correctly detected.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'check',
    description: `Run read-only structural checks against the indexed graph.

Currently detects directed cycles between File nodes connected by IMPORTS edges.
Returns deterministic cycle paths and a cycle count suitable for CI automation.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        cycles: {
          type: 'boolean',
          description: 'Detect circular file imports (default: true).',
          default: true,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'rename',
    description: `Multi-file coordinated rename using the knowledge graph + text search.
Finds all references via graph (high confidence) and regex text search (lower confidence). Preview by default.

WHEN TO USE: Renaming a function, class, method, or variable across the codebase. Safer than find-and-replace.
AFTER THIS: Run detect_changes() to verify no unexpected side effects.

Each edit is tagged with confidence:
- "graph": found via knowledge graph relationships (high confidence, safe to accept)
- "text_search": found via regex text search (lower confidence, review carefully)`,
    annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string', description: 'Current symbol name to rename' },
        symbol_uid: {
          type: 'string',
          description: 'Direct symbol UID from prior tool results (zero-ambiguity)',
        },
        new_name: { type: 'string', description: 'The new name for the symbol' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        dry_run: {
          type: 'boolean',
          description: 'Preview edits without modifying files (default: true)',
          default: true,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['new_name'],
    },
  },
  {
    name: 'impact',
    description: `Analyze the blast radius of changing a code symbol.
Returns affected symbols grouped by depth, plus risk assessment, affected execution flows, and affected modules.

MODE (opt-in): "callgraph" (default) walks symbol→symbol edges (CALLS/IMPORTS/EXTENDS/IMPLEMENTS) — inter-procedural, the established comparator/default behavior. "pdg" requires an index built with \`gitnexus analyze --pdg\` and returns one unified PDG-facing result: statement-level control/data dependence from the persisted PDG plus inter-procedural symbol reach. The explicit interprocedural surface is interproceduralByDepth/pdgInterprocedural; byDepth remains the compatibility symbol bucket. pdg remains incompatible with crossDepth and @group targets; relationTypes/minConfidence filter the inter-symbol reach.

STATEMENT-ANCHORED PDG SLICE: with mode:'pdg', pass "line" (1-based source line within the target symbol) to seed the dependence slice on the statement at that line and return what depends on it in affectedStatements (line + text). Inter-procedural symbols are still reported through interproceduralByDepth/pdgInterprocedural and the compatibility byDepth bucket. Without "line", pdg returns whole-symbol inter-procedural reach plus local whole-symbol PDG diagnostics.

PDG OUTPUT CONTRACT: every mode:'pdg' result (success, empty, degraded, or error) carries pdgResultVersion:1 — a stable discriminator for external consumers that bumps on any breaking change to the PDG result shape (distinct from the DB schema version). Successful PDG results include mode:'pdg', a full target envelope (id/name/type/filePath), affectedStatements, affectedStatementCount, interproceduralByDepth/pdgInterprocedural for cross-function reach, compatibility byDepth/byDepthCounts, risk:'UNKNOWN', and a note describing the unified contract. Degraded PDG results (no-layer, sub-layer-missing, unknown) keep mode:'pdg', pdgResultVersion:1, target metadata when the target resolves, risk:'UNKNOWN', note/remediation, and empty byDepth parity fields — never a false-safe zero. If depth and limit both bound the slice, truncatedByReasons reports both causes while truncatedBy remains scalar.

WHEN TO USE: Before making code changes — especially refactoring, renaming, or modifying shared code. Shows what would break.
AFTER THIS: Review d=1 items (WILL BREAK). Use context() on high-risk symbols.

Output includes:
- risk: LOW / MEDIUM / HIGH / CRITICAL / UNKNOWN
- summary: direct callers, processes affected, modules affected
- affected_processes: which execution flows break and at which step
- affected_modules: which functional areas are hit (direct vs indirect)
- byDepth: affected symbols grouped by traversal depth (paginated by limit/offset; omitted when summaryOnly:true — use byDepthCounts for totals per depth, pagination object when truncated). Each item includes a processes:[{id,label,processType,step}] field listing the execution flows that symbol participates in. Empty when the symbol has no process membership. Can ALSO be empty when partial:true is set — either the process-aggregation pass hit its cap before detecting affected processes, or per-symbol enrichment was capped on a very large page. When partial:true, do NOT treat processes:[] as proof of no participation; cross-check the top-level affected_processes list.

Depth groups:
- d=1: WILL BREAK (direct callers/importers)
- d=2: LIKELY AFFECTED (indirect)
- d=3: MAY NEED TESTING (transitive)

TIP: For hub symbols (base error classes, shared utilities) with many direct callers, use summaryOnly: true first to see counts and risk, then drill into specific depths with limit/offset. maxDepth alone does not bound output size when most dependents are at depth 1. limit and offset apply independently to each depth level, not to the total result set — use byDepthCounts to see totals per depth.

TIP: Default traversal uses CALLS/IMPORTS/EXTENDS/IMPLEMENTS. For class members, include HAS_METHOD and HAS_PROPERTY in relationTypes. For field access analysis, include ACCESSES in relationTypes.

Handles disambiguation: when multiple symbols share the target name, returns ranked candidates (each with a relevance score) instead of silently picking one. Use target_uid for zero-ambiguity lookup, or narrow with file_path and/or kind hints.

EdgeType: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, METHOD_OVERRIDES, METHOD_IMPLEMENTS, ACCESSES
Confidence: 1.0 = certain, <0.8 = fuzzy match

GROUP MODE: set "repo" to "@<groupName>" for cross-repo impact anchored at the default member (lexicographically first key in group.yaml "repos"), or "@<groupName>/<groupRepoPath>" to choose the member (same path keys as in group.yaml). Phase-1 walk runs in that member; cross-boundary fan-out uses the group bridge.

SERVICE: optional monorepo path prefix (case-sensitive path segments). When "repo" starts with "@", scopes the local impact walk and cross-repo symbol paths to files under that prefix; ignored for a normal indexed repo name.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of function, class, or file to analyze' },
        target_uid: {
          type: 'string',
          description:
            'Direct symbol UID from prior tool results (zero-ambiguity lookup, skips target resolution)',
        },
        direction: {
          type: 'string',
          description: 'upstream (what depends on this) or downstream (what this depends on)',
        },
        mode: {
          type: 'string',
          enum: ['callgraph', 'pdg'],
          default: 'callgraph',
          description:
            "Blast-radius engine. 'callgraph' (default) = inter-procedural symbol→symbol traversal (established comparator). 'pdg' = unified PDG-facing impact: intra-procedural statement-level affectedStatements from the persisted control/data dependence layer plus inter-procedural symbols in interproceduralByDepth/pdgInterprocedural and the compatibility byDepth bucket; requires `gitnexus analyze --pdg`. PDG symbol reach is labeled as a PDG evidence bridge, not pure statement-level dependence, and successful PDG results are UNKNOWN-risk. PDG is incompatible with crossDepth and @group targets; relationTypes/minConfidence filter the inter-symbol reach.",
        },
        line: {
          type: 'integer',
          // `minimum: 0` (not 1) so strict client/agent adapters that materialize
          // an omitted optional numeric field as `0` do not reject the request
          // before sending (#2279). A positive line is still required for a real
          // pdg anchor — the backend enforces that — but `0`/omitted means "no
          // statement anchor" and is tolerated on the callgraph path.
          minimum: 0,
          description:
            "1-based source line — PDG statement anchor (mode:'pdg'). Seeds affectedStatements on the statement at this line; inter-procedural symbols are still returned in interproceduralByDepth/pdgInterprocedural and the compatibility byDepth bucket. Omit line for whole-symbol pdg (whole-symbol reach + diagnostics); a positive line anchors a statement slice. Literal 0 is tolerated only as an omitted-line compatibility sentinel on the callgraph path and is rejected for mode:'pdg'.",
        },
        file_path: {
          type: 'string',
          description: 'File path hint to disambiguate common names',
        },
        kind: {
          type: 'string',
          description:
            "Kind filter to disambiguate common names (e.g. 'Function', 'Class', 'Method', 'Interface', 'Constructor')",
        },
        maxDepth: {
          type: 'number',
          description: 'Max relationship depth (default: 3, server clamps to 1–32)',
          default: 3,
          minimum: 1,
          maximum: IMPACT_MAX_DEPTH,
        },
        crossDepth: {
          type: 'number',
          description:
            'Cross-repository hop depth via contract bridge (default: 1; values above server maximum are clamped)',
          default: 1,
          minimum: 1,
          maximum: 32,
        },
        relationTypes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, METHOD_OVERRIDES, METHOD_IMPLEMENTS, ACCESSES (default: usage-based, ACCESSES excluded by default)',
        },
        includeTests: { type: 'boolean', description: 'Include test files (default: false)' },
        minConfidence: {
          type: 'number',
          description:
            'Minimum edge confidence 0–1 (default: 0 when omitted; server clamps to 0–1)',
          default: 0,
          minimum: 0,
          maximum: 1,
        },
        repo: {
          type: 'string',
          description:
            'Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>". Omit if only one repo is indexed.',
        },
        service: {
          type: 'string',
          minLength: 1,
          description:
            'Optional monorepo service root (relative path). Applies when "repo" is group mode (@…); ignored for a normal repo name. Empty string is rejected server-side.',
        },
        subgroup: {
          type: 'string',
          description:
            'Optional group subgroup prefix (member repo paths) limiting which repos participate in cross fan-out.',
        },
        limit: {
          type: 'integer',
          description:
            'Max symbols returned in byDepth per depth level (default: 100). Single-repo only; ignored in group mode (@groupName). Use small values for hub symbols to avoid output truncation.',
          default: 100,
          minimum: 1,
          maximum: 10000,
        },
        offset: {
          type: 'integer',
          description:
            'Skip this many symbols per depth level before applying limit. Single-repo only; ignored in group mode (@groupName). Use with limit for pagination.',
          default: 0,
          minimum: 0,
        },
        summaryOnly: {
          type: 'boolean',
          description:
            'When true, returns target, summary, risk, byDepthCounts, affected_processes, and affected_modules — omits byDepth. Single-repo only; ignored in group mode (@groupName). Use for hub symbols to get actionable signal without output explosion.',
          default: false,
        },
        timeoutMs: {
          type: 'number',
          description:
            'Wall-clock budget in milliseconds for the Phase-1 local impact leg (default 30000)',
          minimum: 1,
          maximum: 3600000,
        },
        timeout: {
          type: 'number',
          description: 'Alias of timeoutMs (milliseconds) when timeoutMs is omitted',
          minimum: 1,
          maximum: 3600000,
        },
      },
      required: ['target', 'direction'],
    },
  },
  {
    name: 'explain',
    description: `Explain persisted taint findings recorded by \`gitnexus analyze --pdg\`: intra-procedural source→sink data flows (TAINTED edges, statement-level hops) AND cross-function flows (TAINT_PATH edges, function-level hops, marked \`interprocedural: true\`).

Each finding carries the sink category (command-injection, code-injection, path-traversal, sql-injection, xss) and the ordered hop path. Intra-procedural findings carry source/sink lines and the variable on each hop; interprocedural findings carry the source and sink FUNCTION names and the chain of functions the taint crossed (decoded from the persisted path encoding).

WHEN TO USE: Security review — "what taint findings exist in this repo / file / function?". Requires the repo to be indexed with \`gitnexus analyze --pdg\`; without that layer the tool returns a clear "no taint layer" note, not an error.

ANCHORLESS (no "target"): enumerates all persisted findings for the repo — bounded ("limit", deterministic order), with "totalFindings" and a "truncated" flag.
ANCHORED ("target" = file path or symbol/function name): full hop detail for that anchor. A file-ish target (contains "/" or an extension) filters by file; a symbol name resolves like context() — ambiguous names return ranked candidates, unknown names return not-found. Symbol anchoring is line-range granular for intra-procedural findings; cross-function findings match when the symbol is the source OR sink function.

CONTRACT CAVEATS (absent flows are NOT proof of safety):
- Cross-function flows ARE modeled (#2084 M4): a source flowing through helper functions into a sink is found, via summary composition over the call graph (context-insensitive — return/call-site merging is accepted).
- Cross-function matching is by callee NAME (context-insensitive): when one caller invokes two distinct same-named callees, a flow into one over-attributes to both — a cross-function finding does not prove the taint reached every same-named function (sound over-report, never a missed flow).
- Closure/callback flows are invisible in both directions (e.g. arr.forEach(() => sink(y))) — the largest false-negative class.
- Property/field flows are not tracked (obj.x = taint; sink(obj.y) has no chain).
- Guard-style sanitizers (if (isValid(x))) and implicit/control-dependence flows are not modeled.
- CommonJS aliasing is partially modeled (require('<literal>') joins resolve; dynamic requires do not).
- Exception-path over-approximation can produce false-positive noise.

Findings are deliberately NOT part of impact()'s traversal or the web schema — explain is the dedicated taint consumer. SANITIZES (kill) edges are queryable via cypher.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'Optional anchor: a file path (e.g. "src/handlers/run.ts" — suffix match accepted) or a symbol/function name (resolved like context()). Omit to enumerate all findings for the repo.',
        },
        limit: {
          type: 'integer',
          description: `Max findings returned (default: ${EXPLAIN_DEFAULT_LIMIT}, max: ${EXPLAIN_MAX_LIMIT}). "totalFindings" reports the full matched count; "truncated" is set when the page is smaller.`,
          default: EXPLAIN_DEFAULT_LIMIT,
          minimum: 1,
          maximum: EXPLAIN_MAX_LIMIT,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'pdg_query',
    description: `Query the persisted Program Dependence Graph recorded by \`gitnexus analyze --pdg\` — control dependence (CDG) and data dependence (REACHING_DEF) at basic-block granularity. The control/data analog of \`explain\` (which is the taint consumer).

MODES:
- \`controls\` — "under what condition does X run?". Returns, for the anchored function, each control-dependence edge: the controlling predicate block, the dependent block, and the branch sense ('T' = the predicate's true/taken arm, 'F' = its false/fall-through arm). An edge into an early return/throw block is flagged \`guard: true\` (subsumes the #559 guard heuristic); the branch sense of a guard depends on its predicate — \`if (!ok) return;\` rides the 'T' arm — so don't filter guards by a fixed label.
- \`flows\` — "where does variable Y flow?". Returns REACHING_DEF def→use edges for the anchored function; pass \`variable\` to filter to one binding.

WHEN TO USE: comprehension ("what guards this statement?"), data-flow tracing within a function, guard-clause discovery. Requires \`gitnexus analyze --pdg\`; without that layer the tool returns a clear "no PDG layer" note, not an error.

ANCHORING (required): \`target\` is a file path or a symbol/function name (resolved like context()). PDG queries are ALWAYS anchored — there is no whole-repo enumeration (an unanchored basic-block path scan is unbounded; LadybugDB has no rel-property index). A symbol target is line-range granular; an ambiguous name returns ranked candidates, unknown returns not-found.

CONTRACT CAVEATS:
- CDG labels are binary 'T'/'F' in M5/M6; per-case \`switch\` arm conditions are not yet distinguished (every case dispatch is 'T').
- Granularity is basic-block, reconstructed to the function via the BasicBlock id + line span (no Function→BasicBlock edge); deeply same-line-packed functions may anchor coarsely.
- Control/data dependence is intra-procedural (per function). Cross-function flow is taint's domain (\`explain\`).
- These edges are deliberately NOT part of impact()'s traversal — \`pdg_query\` is the dedicated consumer; raw edges are also queryable via \`cypher\`.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['controls', 'flows'],
          description:
            "'controls' = control dependence (CDG: what condition gates X); 'flows' = data dependence (REACHING_DEF: where variable Y flows).",
        },
        target: {
          type: 'string',
          description:
            'Required anchor: a file path (e.g. "src/handlers/run.ts" — suffix match accepted) or a symbol/function name (resolved like context()).',
        },
        variable: {
          type: 'string',
          description:
            'Optional (flows mode only): restrict REACHING_DEF results to this source-level variable name.',
        },
        limit: {
          type: 'integer',
          description: `Max edges returned (default: ${PDG_QUERY_DEFAULT_LIMIT}, max: ${PDG_QUERY_MAX_LIMIT}). "total" reports the full matched count; "truncated" is set when the page is smaller.`,
          default: PDG_QUERY_DEFAULT_LIMIT,
          minimum: 1,
          maximum: PDG_QUERY_MAX_LIMIT,
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: ['mode', 'target'],
    },
  },
  {
    name: 'route_map',
    description: `Show API route mappings: which components/hooks fetch which API endpoints, and which handler files serve them.

WHEN TO USE: Understanding API consumption patterns, finding orphaned routes. For pre-change analysis, prefer \`api_impact\` which combines this data with mismatch detection and risk assessment.
AFTER THIS: Use impact() on specific route handlers to see full blast radius.

Returns: route nodes with their handlers, middleware wrapper chains (e.g., withAuth, withRateLimit), and consumers.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description: 'Filter by route path (e.g., "/api/grants"). Omit for all routes.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'tool_map',
    description: `Show MCP/RPC tool definitions: which tools are defined, where they're handled, and their descriptions.

WHEN TO USE: Understanding tool APIs, finding tool implementations, impact analysis for tool changes.

Returns: tool nodes with their handler files and descriptions.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Filter by tool name. Omit for all tools.' },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: [],
    },
  },
  {
    name: 'shape_check',
    description: `Check response shapes for API routes against their consumers' property accesses.

WHEN TO USE: Detecting mismatches between what an API route returns and what consumers expect. Finding shape drift. For pre-change analysis, prefer \`api_impact\` which combines this data with mismatch detection and risk assessment.
REQUIRES: Route nodes with responseKeys (extracted from .json({...}) calls during indexing).

Returns routes that have both detected response keys AND consumers. Shows top-level keys each endpoint returns (e.g., data, pagination, error) and what keys each consumer accesses. Reports MISMATCH status when a consumer accesses keys not present in the route's response shape.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description: 'Check a specific route (e.g., "/api/grants"). Omit to check all routes.',
        },
        repo: {
          type: 'string',
          description: 'Repository name or path. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
  {
    name: 'api_impact',
    description: `Pre-change impact report for an API route handler.

WHEN TO USE: BEFORE modifying any API route handler. Shows what consumers depend on, what response fields they access, what middleware protects the route, and what execution flows it triggers. Requires at least "route" or "file" parameter.

Risk levels: LOW (0-3 consumers), MEDIUM (4-9 or any mismatches), HIGH (10+ consumers or mismatches with 4+ consumers). Mismatches with confidence "low" indicate the consumer file fetches multiple routes — property attribution is approximate.

Returns: single route object when one match, or { routes: [...], total: N } for multiple matches. Combines route_map, shape_check, and impact data.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', description: 'Route path (e.g., "/api/grants")' },
        file: { type: 'string', description: 'Handler file path (alternative to route)' },
        repo: { type: 'string', description: 'Repository name or path.' },
      },
      required: [],
    },
  },
  {
    name: 'group_list',
    description: `List all configured repository groups, or return details for one group (repos, manifest links).

WHEN TO USE: Discover groups before group_sync. Optional "name" returns a single group's config.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name. Omit to list all groups.' },
      },
      required: [],
    },
  },
  {
    name: 'group_sync',
    description: `Rebuild the Contract Registry (contracts.json) for a group: extract HTTP contracts, apply manifest links, exact-match cross-links.

WHEN TO USE: After changing group.yaml or re-indexing member repos.`,
    // Writes contracts.json on every call; conservatively non-idempotent
    // even though output is deterministic for identical input.
    annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        skipEmbeddings: {
          type: 'boolean',
          description: 'Exact + BM25 only (Demo PR: same as default exact path)',
        },
        exactOnly: { type: 'boolean', description: 'Exact match only in cascade' },
      },
      required: ['name'],
    },
  },
  {
    name: 'trace',
    description: `Find the shortest directed path between two symbols over call and class-member edges.

WHEN TO USE: Debugging "how does A reach B?" — answers in one call what would take 3-8 manual context/impact hops. Shows the exact chain with file:line positions plus a per-hop edge type and confidence.

Traverses CALLS edges plus HAS_METHOD (class → member) edges, so a trace can descend from a class into its methods. Each hop's edge type is reported in edges[], so call hops and containment hops remain distinguishable.

Returns: ordered hops with file:line, and an aligned edges[] of edge type + confidence. When no path exists, reports the furthest reachable node so you know where the chain breaks (and truncated: true if a traversal cap was hit first).

CROSS-REPO (experimental): pass repo as "@groupName" to trace across repositories in a group. When from/to live in different member repos, the trace stitches the two repo-local segments across a single ContractLink boundary (e.g. an HTTP consumer→provider link), clamped to one crossing. The result adds crossings[] (the bridged contract with matchType/confidence), tags each hop with its member repo, and a notes[] channel for degraded states. The boundary hop is reported with edge type CONTRACT_LINK. Pass pdg:true to also attach the intra-procedural data-flow (REACHING_DEF) for boundary-adjacent segments when those repos were indexed with --pdg; absent a PDG layer it degrades to call-level hops with a note.

DESTINATION TRACE (cross-repo): for an "@groupName" trace, OMIT to/to_uid/to_file to trace 'from' to wherever its outgoing HTTP call lands. The result ends at the provider endpoint (reported by route + file even when the handler is an anonymous function with no nameable symbol). This is the way to follow a client call to a backend handler you cannot name.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source symbol name' },
        from_uid: { type: 'string', description: 'Source symbol UID (zero-ambiguity)' },
        from_file: { type: 'string', description: 'Source file path hint for disambiguation' },
        to: {
          type: 'string',
          description:
            "Target symbol name. Omit (with to_uid/to_file) on an @group trace to trace 'from' to its HTTP destination.",
        },
        to_uid: { type: 'string', description: 'Target symbol UID (zero-ambiguity)' },
        to_file: { type: 'string', description: 'Target file path hint for disambiguation' },
        maxDepth: {
          type: 'number',
          description: 'Maximum path length in hops (default: 10)',
          default: 10,
          minimum: 1,
          maximum: 30,
        },
        includeTests: {
          type: 'boolean',
          description: 'Include test-file symbols in traversal (default: false)',
          default: false,
        },
        pdg: {
          type: 'boolean',
          description:
            'Cross-repo only (experimental): attach intra-procedural REACHING_DEF data-flow for boundary-adjacent segments when the repo has a --pdg layer. Default false.',
          default: false,
        },
        crossDepth: {
          type: 'number',
          description:
            'Cross-repo only: number of ContractLink boundaries to cross. Only 1 is supported today (multi-hop deferred); a direct caller that passes a higher value gets it clamped to 1 with a notes[] entry.',
          default: 1,
          minimum: 1,
          maximum: 1,
        },
        limit: {
          type: 'number',
          description:
            'Cross-repo + pdg:true only: max REACHING_DEF data-flow hops attached per boundary-adjacent segment (default 50, max 200). When a segment dataFlow is truncated, re-issue with a higher limit.',
          default: 50,
          minimum: 1,
          maximum: 200,
        },
        repo: {
          type: 'string',
          description:
            'Repository name or path, or "@groupName" / "@groupName/memberPath" for a cross-repo trace over a group. Omit if only one repo is indexed.',
        },
      },
      required: [],
    },
  },
];

/**
 * Per-repo tools that accept an optional `branch` scope (#2106). Single source
 * of truth: the schema property is injected here so it cannot drift from the
 * server-side default in `local-backend.ts` (`resolveRepo(repo, branch)`).
 * `list_repos` and the `group_*` tools are intentionally excluded — they are
 * not single-repo, single-branch operations.
 */
const BRANCH_SCOPED_TOOLS = new Set([
  'query',
  'cypher',
  'context',
  'detect_changes',
  'explain',
  'pdg_query',
  'check',
  'impact',
  'rename',
  'route_map',
  'tool_map',
  'shape_check',
  'api_impact',
  'trace',
]);

for (const tool of GITNEXUS_TOOLS) {
  if (!BRANCH_SCOPED_TOOLS.has(tool.name)) continue;
  if (tool.inputSchema.properties.branch) continue;
  // Optional — `required` is left unchanged so omitting `branch` keeps today's
  // default/primary-branch behavior. Ignored in group mode (repo starts "@").
  tool.inputSchema.properties.branch = {
    type: 'string',
    description:
      'Optional: scope to a specific branch index (multi-branch repos, #2106). ' +
      'Omit for the default/primary branch. Ignored in group mode.',
  };
}
