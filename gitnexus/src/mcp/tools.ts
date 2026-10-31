/**
 * MCP Tool Definitions
 *
 * Defines the tools that GitNexus exposes to external AI agents.
 * All tools support an optional `repo` parameter for multi-repo setups.
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { REL_TYPES } from 'gitnexus-shared';
import { GUARD_TAINT_LIMITATION } from './taint-limitations.js';
import {
  CONTEXT_RELATION_TYPES,
  CONTEXT_RESPONSE_SECTIONS,
  QUERY_RESPONSE_SECTIONS,
} from './response-filter.js';

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
        items?: { type: string; enum?: string[] };
        minItems?: number;
        maxItems?: number;
        enum?: string[];
        const?: boolean;
        minimum?: number;
        maximum?: number;
        minLength?: number;
      }
    >;
    required: string[];
    additionalProperties?: false;
  };
}

export const READ_ONLY_TOOL_ANNOTATIONS: ToolAnnotations = {
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

/** Rebuilds GitNexus's own index; never touches the repository's files. */
const REFRESH_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
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

/** Whole-file `read_file` cap. The schema default and the handler fallback share this. */
export const READ_FILE_DEFAULT_MAX_LINES = 2000;

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

/** Advertised query page defaults; backend and group orchestration must match. */
export const QUERY_DEFAULT_LIMIT = 10;
export const QUERY_DEFAULT_MAX_SYMBOLS = 25;
/** Advertised query page maxima (schema + LocalBackend.query reject, not clamp). */
export const QUERY_MAX_LIMIT = 100;
export const QUERY_MAX_MAX_SYMBOLS = 200;
/** Source preview characters shared across unique symbols on a query result page. */
export const QUERY_CONTENT_MAX_CHARS = 16_000;
export const CONTEXT_CHAIN_MAX_DEPTH = 3;

const CWD_AWARE_REPO_OMISSION =
  'Omit when only one repo is indexed, an MCP default is configured, or the GitNexus process cwd is inside a registered path without crossing an unindexed nested Git checkout; otherwise specify it explicitly.';
const MUTATING_REPO_OMISSION =
  'Omit only when one repo is indexed or an MCP default is configured; otherwise mutating tools require an explicit repo. A preview (dry_run omitted or true) may also omit it when the GitNexus process cwd is inside a registered path; dry_run:false always needs one of the first two.';

/** Always-on identity+freshness field on query/context/impact/cypher object results (#3291). */
const HOT_READ_STALENESS_NOTE =
  "Object results attach `staleness` even when current. Read `staleness.branch`/`lastCommit` for which index answered and `status` for freshness. Re-analyze only for `behind` or `diverged` — `current` is this clone's HEAD, not necessarily the default branch; `unknown` is unmeasurable, not stale. Field is only on object results (not raw-array cypher, error envelopes, or `@group` calls).";

const RENAME_PROPERTIES: ToolDefinition['inputSchema']['properties'] = {
  symbol_name: { type: 'string', description: 'Current symbol name to rename' },
  symbol_uid: { type: 'string', description: 'Direct symbol UID from prior tool results' },
  new_name: { type: 'string', description: 'The new identifier for the symbol' },
  file_path: { type: 'string', description: 'File path to disambiguate common names' },
};

export const GITNEXUS_TOOLS: ToolDefinition[] = [
  {
    name: 'list_repos',
    description: `List indexed repositories available to GitNexus (paginated).

Returns a page of repositories — each with name, path, indexed date, last commit, and stats — plus a "pagination" object: { total, limit, offset, returned, hasMore, nextOffset }.

PAGINATION: Results are paginated so a large registry is not truncated by MCP/LLM token limits. "limit" sets the page size (default ${LIST_REPOS_DEFAULT_LIMIT}, max ${LIST_REPOS_MAX_LIMIT}; values above the max are rejected, not capped). "offset" selects the start. To enumerate EVERY repository: when pagination.hasMore is true, call list_repos again with offset set to pagination.nextOffset, and repeat until hasMore is false. Repositories are returned in a stable order, so paging never skips or duplicates an entry while the registry is unchanged.

WHEN TO USE: First step when multiple repos are indexed, or to discover available repos.
AFTER THIS: READ gitnexus://repo/{name}/context for the repo you want to work with.

When multiple repos are indexed, repo-scoped read-only tools use the configured
MCP default or the registered path containing the GitNexus process cwd, unless
cwd has crossed into an unindexed nested Git checkout. If neither applies,
specify the "repo" parameter explicitly.`,
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
Returns ranked processes plus a flat process_symbols list. Join processes[].id to process_symbols[].process_id.

WHEN TO USE: Understanding how code works together. Use this when you need execution flows and relationships, not just file matches. Complements grep/IDE search.
AFTER THIS: Use context() on a specific symbol for 360-degree view (callers, callees, categorized refs). With include_content, context() also returns that symbol's source.

Returns results grouped by process (execution flow):
- processes: ranked execution flows with relevance priority. When a process has an HTTP endpoint, each item includes route and method string aliases plus routes: [{ url, method? }] (same shape as context). When chain_depth > 0, each item also includes chain — layered upstream callers + downstream callees from the process entry symbol (same BFS as context({chain_depth})).
- process_symbols: search-hit symbols in those flows with file locations and module (functional area). On the single-repo envelope { processes, process_symbols, definitions }: One row per (id, process_id) — the same symbol id may appear under more than one process. Join a process to its rows by process_id; symbol_count is the number of those rows. When the process entry is among those hits, it is marked is_entry_point: true. With include_content, content appears only on the first row for each symbol id across the whole process_symbols array, not per process; later rows for that id omit it, even under a different process_id. To get content for a row without it, find the earlier row with the same id, or call context({uid: "<id>", include_content: true}). A repo of "@<group>" returns { group, query, results, per_repo } and does not include process_symbols. results[].symbol_count is the member's post-slice attach count; when service is set, it counts only attaches under that prefix. To get process_symbols for one member, query again with repo "@<group>/<memberPath>" (member path from group.yaml, or results[]._repo).
- definitions: standalone types/interfaces not in any process. Keyword hits on Route URLs (route_fts) are bridged to their handler via HANDLES_ROUTE (handlerSymbolId, routes) when the edge exists; use route_map({route}) for the full HTTP surface.

Hybrid ranking: BM25 keyword + semantic vector search, ranked by Reciprocal Rank Fusion.

GROUP MODE: set "repo" to "@<groupName>" to search all member repos in that group (merged via RRF), or "@<groupName>/<groupRepoPath>" to run against a single member (same path keys as in group.yaml). If you use "@<groupName>" only, the member repo defaults to the lexicographically first key in group.yaml "repos". Prefer resources for contracts/status (see migration from legacy group_* tools).

SERVICE: optional monorepo path prefix (POSIX-style, case-sensitive segments). When "repo" starts with "@", only processes whose symbols fall under that prefix are included. For a normal indexed repo name (no leading @), this field is currently ignored by the server.

${HOT_READ_STALENESS_NOTE}`,
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
          description: `Max processes to return (default: ${QUERY_DEFAULT_LIMIT}, min: 1, max: ${QUERY_MAX_LIMIT}). Values outside [1, ${QUERY_MAX_LIMIT}] are rejected.`,
          default: QUERY_DEFAULT_LIMIT,
          minimum: 1,
          maximum: QUERY_MAX_LIMIT,
        },
        max_symbols: {
          type: 'number',
          description: `Max symbols per process (default: ${QUERY_DEFAULT_MAX_SYMBOLS}, min: 1, max: ${QUERY_MAX_MAX_SYMBOLS}). Values outside [1, ${QUERY_MAX_MAX_SYMBOLS}] are rejected.`,
          default: QUERY_DEFAULT_MAX_SYMBOLS,
          minimum: 1,
          maximum: QUERY_MAX_MAX_SYMBOLS,
        },
        response_sections: {
          type: 'array',
          items: { type: 'string', enum: [...QUERY_RESPONSE_SECTIONS] },
          minItems: 1,
          maxItems: QUERY_RESPONSE_SECTIONS.length,
          description:
            'Optional single-repo output view: select processes, process_symbols, and/or definitions. For symbol discovery use ["process_symbols", "definitions"] with include_content:false and chain_depth:0. Warnings and staleness always remain; response_filter identifies omitted sections, not absent evidence. Does not change ranking or existing search limits. Omit for existing full output. Not supported for @group routing.',
        },
        include_content: {
          type: 'boolean',
          description: `Include source text retained for matching symbols as previews (default: false), sharing ${QUERY_CONTENT_MAX_CHARS} characters equally across unique returned symbols per repository. content_truncated marks incomplete previews; all matches remain present. Content is sent once per symbol id, on its first process_symbols row; context({uid: "<id>", include_content: true}) returns it for any row. Use read_file line ranges for large sources. contentAvailability reports index retention. Query next is JSON guidance.`,
          default: false,
        },
        chain_depth: {
          type: 'integer',
          minimum: 0,
          maximum: CONTEXT_CHAIN_MAX_DEPTH,
          default: 0,
          description: `Optional: walk CALLS edges up to N hops (0-${CONTEXT_CHAIN_MAX_DEPTH}) from each returned process's entry symbol and attach the layered result as a per-process chain field (upstream callers + downstream callees). 0 = disabled (default). Same BFS semantics as context({chain_depth}) — exposes the procedure→workflow→helper flow behind a concept in one call.`,
        },
        maxTokens: {
          type: 'integer',
          minimum: 1,
          description:
            'Maximum estimated tokens in the complete formatted MCP response. Explicit request overrides GITNEXUS_MCP_DEFAULT_MAX_TOKENS.',
        },
        repo: {
          type: 'string',
          description: `Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>" (member path keys from group.yaml). ${CWD_AWARE_REPO_OMISSION}`,
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
- Nodes: File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process, Route, Tool, Destination
- Multi-language nodes (use backticks): \`Struct\`, \`Enum\`, \`Trait\`, \`Impl\`, etc.
- All edges via single CodeRelation table with 'type' property
- Edge types: ${REL_TYPES.join(', ')} — CFG, REACHING_DEF, TAINTED, SANITIZES, TAINT_PATH, CDG, POST_DOMINATE are populated ONLY on indexes built with \`gitnexus analyze --pdg\` (zero rows on a default index); OVERRIDES is a legacy alias — rows are written as METHOD_OVERRIDES
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

• Find DI-injected providers (provider Classes or synthetic factory declarations):
  MATCH (c:Class {name: 'OrderService'})-[r:CodeRelation]->(provider) WHERE r.type = 'INJECTS' RETURN provider.name, r.reason

• Detect diamond inheritance:
  MATCH (d:Class)-[:CodeRelation {type: 'EXTENDS'}]->(b1), (d)-[:CodeRelation {type: 'EXTENDS'}]->(b2), (b1)-[:CodeRelation {type: 'EXTENDS'}]->(a), (b2)-[:CodeRelation {type: 'EXTENDS'}]->(a) WHERE b1 <> b2 RETURN d.name, b1.name, b2.name, a.name

OUTPUT: Returns { markdown, row_count } — results formatted as a Markdown table for easy reading.

TIPS:
- All relationships use single CodeRelation table — filter with {type: 'CALLS'} etc.
- Community = auto-detected functional area (Leiden algorithm). Properties: heuristicLabel, cohesion, symbolCount, keywords, description, enrichedBy
- Process = execution flow trace from entry point to terminal. Properties: heuristicLabel, processType, stepCount, communities, entryPointId, terminalId
- Use heuristicLabel (not label) for human-readable community/process names
- PDG layers (only when indexed with \`--pdg\`): BasicBlock nodes + CFG / CDG (control dependence, branch sense 'T'|'F' in reason) / REACHING_DEF (def→use, variable in reason) edges, all BasicBlock→BasicBlock. Prefer the \`pdg_query\` tool — it anchors + bounds these for you (raw \`[:CDG*]\`/\`[:REACHING_DEF*]\` path scans are unindexed and unbounded).

${HOT_READ_STALENESS_NOTE}`,
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
          description: `Repository name or path. ${CWD_AWARE_REPO_OMISSION}`,
        },
      },
      required: ['statement'],
    },
  },
  {
    name: 'context',
    description: `Inspect a symbol's references, processes, and location when query results need more detail.
Use uid, or name with file_path/kind. Ambiguous results return ranked candidates, totalCandidates (full count), and candidatesTruncated.

include_content returns retained source. Leave chain_depth:0 unless layered CALLS neighbours are needed. routes:[{url,method?}] and is_entry_point describe HTTP handlers and process entries. ACCESSES references carry reason "read"/"write"; CALLS can follow field and method chains.

COMPLETENESS: epistemic "lower-bound" means incoming is a floor (missed callers/failed probes). Read boundaries; branch on causes. Empty callers do not prove safety.
- scopeExtractionFiles: files missing scope edges; analyze --force, inspect warnings.
- receiverTyping: sites with unknown receiver types; corroborate by text search.
- overloadResolution: unique unresolved overload/implementation sites matched by symbol/declaring owner. Missing/invalid/capped receipts imply lower-bound even at 0; analyze --force.
- externalBoundary: calls outside indexed code; compatible with "exact", not a defect.
- dispatchBoundary: DI/interface symbols, not sites. Runtime-proxy gaps may be uncountable (0 with lower-bound).
- undecidedSatisfaction: unjudged interface/type pairs without IMPLEMENTS; check dependencies.
- callableValueReferences: symbols holding the callable as a value via USES, without a modeled later invocation. Follow the registrations/readers. Zig registrations and JS/TS object properties are captured; bare JS/TS callback arguments are not counted. Synthesized dispatch excludes the whole symbol, so mixed followed/unfollowed registrations can report 0. Zero means no unfollowed registration was proven, not no escapes; a failed probe also reports 0 with lower-bound.

Older indexes can lack captures/metadata; re-analyze before trusting zero causes or exact coverage. Use impact() before edits; read gitnexus://repo/{name}/process/{processName} for a full flow.

GROUP MODE: repo "@<groupName>" aggregates member results; "@<groupName>/<groupRepoPath>" selects one member using group.yaml keys.

SERVICE: case-sensitive path prefix in @group mode; members whose symbol is outside it return an empty payload. Ignored for a normal repository.

${HOT_READ_STALENESS_NOTE}`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (e.g., "validateUser", "AuthService")' },
        uid: {
          type: 'string',
          description: 'Direct symbol UID from prior tool results (zero-ambiguity lookup)',
        },
        response_sections: {
          type: 'array',
          items: { type: 'string', enum: [...CONTEXT_RESPONSE_SECTIONS] },
          minItems: 1,
          maxItems: CONTEXT_RESPONSE_SECTIONS.length,
          description:
            'Optional single-repo output view: select incoming, outgoing, processes, chain, routes, and/or typed_properties. The symbol and all warnings/completeness/staleness fields always remain. For callers only use ["incoming"] plus relationTypes:["CALLS"]. Omitted data is not evidence of absence; remove filters to expand. Does not change traversal or existing reference limits. Omit for existing full output. Not supported for @group routing.',
        },
        relationTypes: {
          type: 'array',
          items: { type: 'string', enum: [...CONTEXT_RELATION_TYPES] },
          minItems: 1,
          maxItems: CONTEXT_RELATION_TYPES.length,
          description:
            'Optional uppercase relationship categories to retain in the existing incoming/outgoing view, e.g. ["CALLS"] or ["CALLS", "USES"]. This filters the returned bounded reference window; it does not search for additional matches or filter chain. If response_sections is set, it must include incoming or outgoing. Omit for all existing categories. Single-repo MCP only, not @group routing.',
        },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        file: {
          type: 'string',
          description: 'Compatibility alias for file_path; values must agree when both are present',
        },
        kind: {
          type: 'string',
          description:
            "Kind filter to disambiguate common names (e.g. 'Function', 'Class', 'Method', 'Interface', 'Constructor')",
        },
        include_content: {
          type: 'boolean',
          description:
            'Include source text retained for this symbol (default: false). The response reports contentAvailability; indexes built with content retention "none" explicitly report unavailable content.',
          default: false,
        },
        chain_depth: {
          type: 'integer',
          minimum: 0,
          maximum: CONTEXT_CHAIN_MAX_DEPTH,
          default: 0,
          description: `Optional: walk CALLS edges up to N hops (0-${CONTEXT_CHAIN_MAX_DEPTH}) and return the result as a \`chain\` field (downstream callees + upstream callers layered by depth). 0 = disabled (default). 1 = direct neighbours only. 2-${CONTEXT_CHAIN_MAX_DEPTH} = procedure→workflow→sub-workflow depth. Useful for revealing the full tRPC/RPC call chain in a single call instead of chaining context() invocations.`,
        },
        maxTokens: {
          type: 'integer',
          minimum: 1,
          description:
            'Maximum estimated tokens in the complete formatted MCP response. Explicit request overrides GITNEXUS_MCP_DEFAULT_MAX_TOKENS.',
        },
        repo: {
          type: 'string',
          description: `Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>". ${CWD_AWARE_REPO_OMISSION}`,
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

Returns: changed symbols, affected processes, and a risk summary.
- partial: true — mapping is incomplete, so risk_level is "unknown" instead of a ranked level. A failed symbol query (or an unparseable diff) degrades changed_symbols, both counts, and derived processes; a failed process lookup degrades only affected_processes and risk, leaving changed-symbol counts sound. unmapped_files lists changed supported source files with no mapped symbols, including source renames without hunks: their symbols may be missing, unindexed, or outside indexed ranges even when every query succeeded. Rebuild the index and inspect those diffs; retry alone may not resolve this state. changed_count:0 with partial:true is NOT a clean pre-commit check.
- truncated: true — the changed_symbols LISTING was capped for this response. summary.changed_count counts every symbol the run observed: the true total normally, a LOWER BOUND when partial:true. Compare it with the array length rather than trusting the array.`,
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
          description: `Repository name or path. ${CWD_AWARE_REPO_OMISSION}`,
        },
      },
      required: [],
    },
  },
  {
    name: 'check',
    description: `Run read-only structural checks against the indexed graph.

Currently detects directed cycles between File nodes connected by IMPORTS edges, counting only
edges that force a module-initialization order — a deferred import (\`import()\`, or one written
inside a function body) and a TypeScript \`import type\` are excluded, because neither can make the
modules impossible to initialize.

READ \`enumeration\` BEFORE \`cycleCount\`:
- \`enumeration: 'complete'\` — every elementary cycle is listed; \`cycleCount\` is their number.
- \`enumeration: 'component-representatives'\` — the full enumeration exceeded a safety limit, so
  \`cycles\` holds ONE representative per circular component, \`truncated\` is true, and
  \`cycleCount\` is **null**. Do not compare \`cycleCount\` numerically here: \`null > 0\` is false,
  so a caller keying on it alone concludes "clean" on exactly the most tangled repositories. Use
  \`status === 'cycles_found'\`.

\`componentCount\` (independent circular components) is present in both modes and is the number to
act on and to trend: cutting one import can remove thousands of elementary cycles at once, so
\`cycleCount\` swings wildly for small changes while \`componentCount\` stays stable.

A graph too large to analyze at all returns \`{ error, truncated: true }\` with no \`status\`.`,
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
          description: `Repository name or path. ${CWD_AWARE_REPO_OMISSION}`,
        },
      },
      required: [],
    },
  },
  {
    name: 'rename',
    description: `Rename using the indexed graph and GitNexus's own semantic layer. Previews by default: dry_run omitted or true never writes; dry_run:false requires the plan_token returned by a successful preview and applies exactly that captured edit set after checking source snapshots and targets. Preview first, review semantic_edits and coverage, then re-call with dry_run:false and plan_token.
Pass symbol_uid from context() to select the declaration. Unsupported syntax, ambiguous bindings, and incomplete coverage fail closed; no compiler or text-search fallback is used.
Returns result_version:2 with semantic_edits (occurrence count), exact UTF-16 spans, indexed-source coverage, and explicit planning/application status. Preview plan_token is single-use, expires after 15 minutes or a server restart, and can be evicted when retained previews reach 16 plans or 64 MiB. Apply rejects changed sources (including untracked files), source-file inventories, graph targets, repositories, and destination names; it never replans edits. Legacy graph_edits and text_search_edits are zero. Partial writes are not transactional: changes lists only landed edits, failed_files the file that failed, and unattempted_files later files never touched; reconcile and preview again before retrying.
Ambiguous symbol_name returns context()'s ranked candidates and totalCandidates verbatim; re-call with symbol_uid. After application, run tests and detect_changes().`,
    annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        ...RENAME_PROPERTIES,
        plan_token: {
          type: 'string',
          description:
            'Opaque single-use token returned by the reviewed preview. Required with dry_run:false; keep the same repository, target, and new_name.',
        },
        dry_run: {
          type: 'boolean',
          description:
            'Preview edits without modifying files (default: true). Pass false to apply.',
          default: true,
        },
        repo: { type: 'string', description: `Repository name or path. ${MUTATING_REPO_OMISSION}` },
      },
      required: ['new_name'],
    },
  },
  {
    name: 'impact',
    description: `Assess the blast radius before changing a symbol. Use target_uid when known, or target with file_path/kind.
For a hub, start with summaryOnly:true, then fetch needed callers with limit/offset. Leave includeTests:false unless test callers are needed. Risk is still computed. Review direct callers before editing; use context() for unresolved details.

CALLGRAPH MODE (default): CALLS/IMPORTS/EXTENDS/IMPLEMENTS. Add HAS_METHOD/HAS_PROPERTY for members or ACCESSES for field usage. Confidence 1.0 is certain; <0.8 is fuzzy. d=1 callers/importers WILL BREAK, d=2 are LIKELY AFFECTED, d=3 MAY NEED TESTING.

RISK: risk is the HIGH/CRITICAL edit-gate field: LOW/MEDIUM/HIGH/CRITICAL/UNKNOWN. Upstream zero callers is UNKNOWN with riskNote, never proof of safety; corroborate by text search. Downstream empty results describe callees, not safety.
- riskSharedAxes compares direct/total axes; group mode adds the cross-repo crossing overlay. Never substitute it for \`risk\` when deciding whether to warn.
- File targets lack process/community axes; their risk is not directly comparable with symbols. Web Graph-RAG expands Files to symbols.
- riskScale.{comparableAcrossKinds,unusedAxes} identifies unavailable/skipped/failed axes, including IMPACT_MAX_CHUNKS=0 and enrichment that sampled a subset of impacted symbols. Failed/truncated counts are floors: known HIGH/CRITICAL warnings survive; otherwise risk is UNKNOWN.

RESULTS: target, impactedCount, summary, affected_processes, affected_modules, byDepthCounts, and byDepth. summaryOnly omits byDepth. limit/offset apply PER DEPTH; maxDepth alone cannot bound wide hubs. Read pagination/truncated flags and totals before treating a page as complete. Ambiguous targets return ranked candidates, totalCandidates, and candidatesTruncated.
- byDepth rows include processes:[{id,label,processType,step}]. With partial:true, processes:[] can mean capped enrichment; cross-check affected_processes.
- staticGated:true marks a provably compile-time-unreachable edge (currently Zig); absence proves neither reachability nor coverage. Traversal/risk do not filter on it.
- affected_routes and row routes:[{url,method?}] are callgraph-only HTTP enrichment, not risk inputs.

COMPLETENESS: epistemic "lower-bound" makes impactedCount a floor (missed callers/failed probes). Read boundaries; branch on causes. Ambiguous/group results may omit this envelope.
- scopeExtractionFiles: files missing scope edges; analyze --force, inspect warnings.
- receiverTyping: sites with unknown receiver types; corroborate before deletion/rename.
- overloadResolution: unique unresolved overload/implementation sites in the expanded traversal before pagination. Missing/invalid/capped receipts imply lower-bound even at 0; analyze --force.
- externalBoundary: calls outside indexed code; compatible with "exact", not a defect.
- dispatchBoundary: DI/interface symbols, not sites. Runtime-proxy gaps may be uncountable (0 with lower-bound).
- undecidedSatisfaction: unjudged interface/type pairs without IMPLEMENTS; check dependencies.
- callableValueReferences counts symbols registering the callable VALUE via USES without a modeled later invocation. Follow registrations/readers; low risk/counts remain floors. Zig registrations and JS/TS object properties are captured; bare JS/TS callback arguments are not counted. Synthesized property dispatch excludes the whole symbol, so mixed followed/unfollowed registrations can report 0. Zero means no unfollowed registration was proven, not no escapes; a failed probe also reports 0 with lower-bound.
Older indexes can lack captures/metadata; re-analyze before trusting zero causes or apparently exact coverage from an older analyzer.

PDG MODE: mode:"pdg" requires analyze --pdg; incompatible with crossDepth/@group. relationTypes/minConfidence filter inter-symbol reach. A statement-anchored slice uses a 1-based line inside the target; omit line for whole-symbol dependence.
Every PDG result carries pdgResultVersion:3, risk:"UNKNOWN", and target metadata when resolved. Successful results include mode:"pdg", affectedStatements/affectedStatementCount, interproceduralByDepth/pdgInterprocedural, compatibility byDepth/byDepthCounts, and diagnostics. Missing-layer/degraded results keep UNKNOWN plus note/remediation; empty buckets are not safe zeros. truncatedByReasons lists simultaneous bounds while truncatedBy stays scalar.
pdgEvidence.ascent appears when inter-procedural descent ran, including empty slices. Read callSummaryLayerPresent FIRST: false means missing CALL_SUMMARY data; re-analyze --pdg, rather than read returnFlowFound:false as no return flow. referencesScanned counts distinct callees, not sites. returnFlowFound records any ascent; undecodableSummaryCount and examinedComplete describe coverage. incompleteReasons includes traversal-truncated, callee-list-capped, and callee-ids-unrecorded. Use structured fields, not narrative notes.

GROUP MODE: repo "@<groupName>" anchors at the first lexicographic group.yaml member; "@<groupName>/<groupRepoPath>" selects one. Local traversal precedes bridge fan-out, bounded to 50 strongest-confidence crossings. fanout_status:"not_attempted" proves a repository boundary with no far symbol; empty by_depth/affected_processes is not a completed zero-impact walk. Short results carry truncated:true, truncatedRepos, riskEpistemic:"lower-bound", and truncationReason; risk is a floor.
- 'timeout'/'partial': runtime limits; retry or increase timeoutMs.
- 'incomplete-sync': missing/unreadable in-scope repos; run group_sync before retrying.
- 'suppressed-stage': sync deliberately skipped a stage; re-sync without --exact-only / exactOnly. It does not mean a repository is broken.
truncated:true does NOT always mean exhausted fan-out: structural gaps can exist even when zero crossings were attempted.
Group results lift local risk fields to the top-level envelope.

SERVICE: case-sensitive path prefix for local/group-crossing walks in @group mode; ignored for a normal repository.

${HOT_READ_STALENESS_NOTE}`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of function, class, or file to analyze' },
        name: {
          type: 'string',
          description: 'Compatibility alias for target; all supplied target aliases must agree',
        },
        symbol: {
          type: 'string',
          description: 'Compatibility alias for target; all supplied target aliases must agree',
        },
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
        depth: {
          type: 'number',
          description:
            'Compatibility alias for maxDepth (CLI --depth). Values must agree when both are present. Literal 0 is an omitted-value compatibility sentinel.',
          minimum: 0,
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
            'Filter: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, METHOD_OVERRIDES, METHOD_IMPLEMENTS, ACCESSES (default: usage-based, ACCESSES excluded by default). DI edges require INJECTS; Spring proxy/advice edges require ADVISED_BY.',
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
          description: `Indexed repository name or path, or group mode "@<groupName>" / "@<groupName>/<memberPath>". ${CWD_AWARE_REPO_OMISSION}`,
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
        maxTokens: {
          type: 'integer',
          minimum: 1,
          description:
            'Maximum estimated tokens in the complete formatted MCP response. Explicit request overrides GITNEXUS_MCP_DEFAULT_MAX_TOKENS.',
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
      required: ['direction'],
    },
  },
  {
    name: 'explain',
    description: `Explain persisted taint findings recorded by \`gitnexus analyze --pdg\`: intra-procedural source→sink data flows (TAINTED edges, statement-level hops) AND cross-function flows (TAINT_PATH edges, function-level hops, marked \`interprocedural: true\`).

Each finding carries the sink category (command-injection, code-injection, path-traversal, sql-injection, xss) and the ordered hop path. Intra-procedural findings carry source/sink lines and the variable on each hop; interprocedural findings carry the source and sink FUNCTION names and the chain of functions the taint crossed (decoded from the persisted path encoding).

WHEN TO USE: Security review — "what taint findings exist in this repo / file / function?". Requires the repo to be indexed with \`gitnexus analyze --pdg\`; without that layer the tool returns a clear "no taint layer" note, not an error.

ANCHORLESS (no "target"): enumerates all persisted findings for the repo — bounded ("limit", deterministic order), with "totalFindings" and a "truncated" flag.
ANCHORED ("target" = file path or symbol/function name): full hop detail for that anchor. A file-ish target (contains "/" or an extension) filters by file; a symbol name resolves like context() — ambiguous names return ranked candidates plus totalCandidates (the TRUE match count, not candidates[].length), candidatesTruncated:true and a "(showing M)" suffix on message when candidates[] is the shorter window; unknown names return not-found. Symbol anchoring is line-range granular for intra-procedural findings; cross-function findings match when the symbol is the source OR sink function.

CONTRACT CAVEATS (absent flows are NOT proof of safety):
- Cross-function flows ARE modeled (#2084 M4): a source flowing through helper functions into a sink is found, via summary composition over the call graph (context-insensitive — return/call-site merging is accepted).
- Cross-function matching is by callee NAME (context-insensitive): when one caller invokes two distinct same-named callees, a flow into one over-attributes to both — a cross-function finding does not prove the taint reached every same-named function (sound over-report, never a missed flow).
- Sources read inside inline callbacks and returned handlers can flow through helper functions. Captured closure-variable flows are not modeled (e.g. const y = source(); arr.forEach(() => sink(y))).
- Property/field flows are not tracked (obj.x = taint; sink(obj.y) has no chain).
- ${GUARD_TAINT_LIMITATION}
- Implicit/control-dependence flows are not modeled.
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
          description: `Repository name or path. ${CWD_AWARE_REPO_OMISSION}`,
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

ANCHORING (required): \`target\` is a file path or a symbol/function name (resolved like context()). PDG queries are ALWAYS anchored — there is no whole-repo enumeration (an unanchored basic-block path scan is unbounded; LadybugDB has no rel-property index). A symbol target is line-range granular; an ambiguous name returns ranked candidates plus totalCandidates (the TRUE match count, not candidates[].length), candidatesTruncated:true and a "(showing M)" suffix on message when candidates[] is the shorter window; unknown returns not-found.

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
          description: `Repository name or path. ${CWD_AWARE_REPO_OMISSION}`,
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

Returns: route nodes with their handlers, middleware wrapper chains (e.g., withAuth, withRateLimit), and consumers. Each route object includes its "method" (the HTTP verb, "*" for method-agnostic routes, or null for method-less routes) and "runtimeEvidence". Runtime evidence is authoritative only when runtimeEvidence.confirmed is true; source records provenance, including conflicts.`,
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
          description: `Repository name or path. ${CWD_AWARE_REPO_OMISSION}`,
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
        repo: {
          type: 'string',
          description: `Repository name or path. ${CWD_AWARE_REPO_OMISSION}`,
        },
      },
      required: [],
    },
  },
  {
    name: 'shape_check',
    description: `Check response shapes for API routes against their consumers' property accesses.

WHEN TO USE: Detecting mismatches between what an API route returns and what consumers expect. Finding shape drift. For pre-change analysis, prefer \`api_impact\` which combines this data with mismatch detection and risk assessment.
REQUIRES: Route nodes with responseKeys (extracted from .json({...}) calls during indexing).

Returns routes that have both detected response keys AND consumers. Shows top-level keys each endpoint returns (e.g., data, pagination, error) and what keys each consumer accesses. Reports MISMATCH status when a consumer accesses keys not present in the route's response shape. Each route object includes its "method" (the HTTP verb, "*" for method-agnostic routes, or null for method-less routes) and "runtimeEvidence". Runtime evidence is authoritative only when runtimeEvidence.confirmed is true.`,
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
          description: `Repository name or path. ${CWD_AWARE_REPO_OMISSION}`,
        },
      },
      required: [],
    },
  },
  {
    name: 'api_impact',
    description: `Pre-change impact report for an API route handler.

WHEN TO USE: BEFORE modifying any API route handler. Shows what consumers depend on, what response fields they access, what middleware protects the route, and what execution flows it triggers. Requires at least "route" or "file" parameter.

Risk levels: LOW (0-3 consumers), MEDIUM (4-9 or any mismatches), HIGH (10+ consumers or mismatches with 4+ consumers). Mismatches with confidence "low" indicate the consumer file fetches multiple routes — property attribution is approximate. When impactSummary.epistemic is "lower-bound", impactSummary.unverifiedConsumers more files pass the route's URL to a function not proven to send HTTP requests, so directConsumers is a floor; riskLevel counts proven consumers only. "indirectConsumers" lists the callers of the function that sends the request, one level up, each with that function's name in "via"; impactSummary.indirectConsumers counts their distinct files. They are reported apart from the direct consumers and do not feed riskLevel. The field is absent on an index built before the requesting function was recorded.

Response shape is keyed on how many routes match, not on the data: exactly one match returns a single route object; two or more return { routes: [...], total: N }. The same URL can expose multiple HTTP verbs (e.g. GET and POST /api/orders are distinct routes that share the URL), so a bare-URL lookup may return the wrapped form — every route object carries its own "method" so verbs are distinguishable. Pass "method" to narrow to one verb; the single-object shape is returned only when exactly one route remains after filtering — a substring route/file match spanning several URLs can still return the wrapped form. A URL/file that exists but has no route for the given verb returns an error. Each route's "method" is the literal "*" for method-agnostic routes (e.g. Django function views), which match any "method" selector, or null for method-less routes (filesystem, Laravel resource), which never match a selector. Every route also carries "runtimeEvidence"; treat it as authoritative only when runtimeEvidence.confirmed is true. Combines route_map, shape_check, and impact data.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', description: 'Route path (e.g., "/api/grants")' },
        file: { type: 'string', description: 'Handler file path (alternative to route)' },
        method: {
          type: 'string',
          description:
            'Optional HTTP verb — GET, POST, PUT, PATCH, DELETE, etc. — to narrow a multi-verb route or file lookup to a single method. Returns an error if no matched route uses that verb.',
        },
        repo: {
          type: 'string',
          description: `Repository name or path. ${CWD_AWARE_REPO_OMISSION}`,
        },
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
    description: `Rebuild the Contract Registry (contracts.json) for a group: extract contracts (HTTP, gRPC, Thrift, topics, includes), apply manifest links, then cross-link by exact contract-id match followed by wildcard service match.

WHEN TO USE: After changing group.yaml or re-indexing member repos.

READ THE RESULT: \`missingRepos\` are configured repos with no entry in the registry (index them, or drop them from group.yaml); \`unreadableRepos\` ARE registered but this sync could not extract from them — the index would not open (version skew, lock, corruption), or an extractor failed partway — so NONE of their contracts are in this sync and a following group_impact / group_contracts is a lower bound, not a verdict. \`degradedLinks\` is the count of persisted cross-links whose provider endpoint has no resolved graph symbol (\`degraded: true\`); re-analyze the provider so handlers resolve. \`failedRepos\` is \`{ repo, reason }[]\` for per-repo extraction throws — each also appears in \`unreadableRepos\`; \`repo\` is that group path (e.g. app/backend), not the registry display name. \`warnings\` are operator-facing run notes (e.g. bridge.lbug write failed after contracts.json was written); \`[]\` means none this run. \`registryOutcome\` says what happened to the file, and the three values a call here can return each need a different response: 'written' — this run's contracts replaced contracts.json; 'preserved' — nothing could be read, so contracts.json was rewritten keeping the previous sync's contracts and cross-links verbatim and refreshing only \`missingRepos\`/\`unreadableRepos\` to describe THIS run (the file changed, the contracts in it did not, and they are as old as the last sync that succeeded); 'superseded' — nothing could be read, and another sync replaced contracts.json while this one waited for the group lock; that file was left untouched and this run's lists were NOT recorded, because they describe an older group state than what is on disk (so the registry is fresher than this response's diagnostics, not staler); 'no-prior-registry' — nothing could be read AND there was no previous contracts.json to carry forward, so none was written and this group has no contract registry on disk. Only 'no-prior-registry' means there is nothing to read: after it, group_contracts / group_impact have no registry at all rather than a stale one, so fix the repos above and re-run before trusting either. \`suppressedMatchStages\` names matching stages this sync was ASKED to skip, with the same three states as the repo lists: ABSENT means a registry written before the field existed, \`[]\` means this sync suppressed nothing, and a populated list means the cross-link set is a lower bound BY REQUEST — a later group_impact / group_contracts on it reports truncationReason 'suppressed-stage'.\n\nPARAMETERS ARE VALIDATED: \`exactOnly\` must be a real boolean — the string "false" is rejected, not coerced to true. The retired \`skipEmbeddings\` and \`allowStale\` parameters are refused by name; drop them from the call.`,
    // Usually writes contracts.json, so conservatively non-idempotent even
    // though output is deterministic for identical input. When no configured
    // repo could be read it still rewrites the file, keeping the previous
    // registry's contracts and refreshing only its diagnostic fields
    // (`registryOutcome: 'preserved'`); it writes nothing when there was no
    // previous registry to carry forward (`'no-prior-registry'`).
    annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        exactOnly: {
          type: 'boolean',
          description:
            'Skip the wildcard service-match stage; cross-link only on exact contract-id match. Manifest links still apply.',
        },
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

Handles disambiguation: an ambiguous from/to name returns status "ambiguous" with role ("from" or "to"), ranked candidates and totalCandidates — the TRUE match count, not candidates[].length — plus candidatesTruncated:true and a "(showing M)" suffix on message when candidates[] is the shorter window. Re-call with from_uid/to_uid.

CROSS-REPO (experimental): pass repo as "@groupName" to trace across repositories in a group. When from/to live in different member repos, the trace stitches the two repo-local segments across a single ContractLink boundary (e.g. an HTTP consumer→provider link), clamped to one crossing. The result adds crossings[] (the bridged contract with matchType/confidence), tags each hop with its member repo, and a notes[] channel for degraded states. The boundary hop is reported with edge type CONTRACT_LINK. Pass pdg:true to also attach the intra-procedural data-flow (REACHING_DEF) for boundary-adjacent segments when those repos were indexed with --pdg; absent a PDG layer it degrades to call-level hops with a note.

DESTINATION TRACE (cross-repo): for an "@groupName" trace, OMIT to/to_uid/to_file to trace 'from' to wherever its outgoing HTTP call lands. The result ends at the provider endpoint (reported by route + file even when the handler is an anonymous function with no nameable symbol). This is the way to follow a client call to a backend handler you cannot name.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source symbol name' },
        from_uid: { type: 'string', description: 'Source symbol UID (zero-ambiguity)' },
        file: {
          type: 'string',
          description: 'Source file path hint for disambiguation (alias for from_file)',
        },
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
        depth: {
          type: 'number',
          description:
            'Compatibility alias for maxDepth (CLI --depth). Values must agree when both are present. Literal 0 is an omitted-value compatibility sentinel.',
          minimum: 0,
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
          description: `Repository name or path, or "@groupName" / "@groupName/memberPath" for a cross-repo trace over a group. ${CWD_AWARE_REPO_OMISSION}`,
        },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: `Read a file from the repository checkout, optionally sliced to a 0-indexed line range.
Returns checkout bytes plus totalLines and the slice bounds. The realpath re-check matches HTTP GET /api/file. The lexical barrier is the CodeQL \`startsWith('..')\` form narrowed to the \`..\` segment, so a file named \`..config\` stays readable. A whole-file read is capped by maxLines (default ${READ_FILE_DEFAULT_MAX_LINES}, 0 = no cap), which is stricter than the uncapped HTTP body.

WHEN TO USE: After query()/cypher()/context() gave you a filePath (or file:line), read the surrounding source: header context (open/variable/import lines), a full declaration, or any line window. Prefer context({name, include_content: true}) when you already have the symbol — it returns the symbol span plus call edges in one call.
AFTER THIS: Use the read text to ground signatures verbatim; never invent names from memory.

Paths that escape the repository are refused. A missing file returns a not-found error only when the checkout directory exists. When full source is unavailable (content retention is not "full", or the checkout directory is gone), the result is code "source-unavailable" — not an empty body and not "file not found". This tool reads the checkout and does not accept branch.`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Repository-contained file path (e.g. "Mathlib/Analysis/SpecificLimits/Basic.lean"). Paths that escape the repository, including ".." escapes, are refused.',
        },
        startLine: {
          type: 'integer',
          description: 'Optional 0-indexed first line of the slice (inclusive).',
          minimum: 0,
        },
        endLine: {
          type: 'integer',
          description: 'Optional 0-indexed last line of the slice (inclusive). Requires startLine.',
          minimum: 0,
        },
        maxLines: {
          type: 'integer',
          description: `Maximum lines returned for a whole-file read (default ${READ_FILE_DEFAULT_MAX_LINES}, 0 = no cap). Ignored when startLine is set. Negative values are rejected.`,
          default: READ_FILE_DEFAULT_MAX_LINES,
          minimum: 0,
        },
        repo: {
          type: 'string',
          description: `Indexed repository name or path. ${CWD_AWARE_REPO_OMISSION}`,
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep',
    description: `Regex search of the live checkout for files the index retained — the MCP twin of HTTP GET /api/grep.
The file list is indexed File nodes that still have content. Bytes are read from the working tree, so edits since the last analyze are visible. Hits are 1-based. read_file startLine/endLine are 0-based.

WHEN TO USE: Only after graph tools came back empty or ambiguous — exact-name pinning, docstring fallback, or literal tokens the index does not model (e.g. tactic names inside proof bodies, notation). Graph first (query/context/cypher); grep is the offline-capable fallback, never the default.
AFTER THIS: Read the matching line with read_file({path, startLine: hit.line - 1, endLine: hit.line - 1}) or pin the symbol with context({name}).

Optional caseSensitive and literal match HTTP /api/grep (default: case-insensitive regex). When full source is unavailable the result is code "source-unavailable", not an empty hit list. This tool reads the checkout and does not accept branch. Results carry timedOut: true when the wall-clock budget expired first — re-issue narrower (fileFilter or a tighter pattern).`,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern (max 200 chars) matched against file content lines.',
        },
        fileFilter: {
          type: 'string',
          description: 'Optional case-insensitive substring filter on file paths.',
        },
        limit: {
          type: 'number',
          description: 'Maximum hits returned (default 50, max 200).',
          default: 50,
          minimum: 1,
          maximum: 200,
        },
        caseSensitive: {
          type: 'boolean',
          description:
            'Optional. When true, match case. Default is case-insensitive, matching HTTP /api/grep.',
        },
        literal: {
          type: 'boolean',
          description:
            'Optional. When true, treat pattern as a literal substring (escaped), matching HTTP /api/grep literal=1. Default is a regex.',
        },
        repo: {
          type: 'string',
          description: `Indexed repository name or path. ${CWD_AWARE_REPO_OMISSION}`,
        },
      },
      required: ['pattern'],
    },
  },
];

/**
 * `refresh_index` (#3524) lives outside GITNEXUS_TOOLS: it is opt-in, so it is
 * neither part of the default catalog nor of its byte budget. The local server
 * appends it only when refresh-policy.ts enables it.
 */
export const REFRESH_INDEX_TOOL: ToolDefinition = {
  name: 'refresh_index',
  description: `Rebuild a registered repository's index from its working tree, for agents that see a stale index but cannot run \`gitnexus analyze\`.

Index-only: never writes AGENTS.md, CLAUDE.md, skills, hooks, or any repository file. Incremental where possible; keeps embeddings and PDG mode. Waits for the rebuild, then returns indexedAt, lastCommit, stats, and staleness before and after; clients that send a progress token get progress notifications. One refresh per repository at a time.

WHEN TO USE: staleness.status is "behind" or "diverged". Call with dry_run:true first; repositories over the server's file limit are refused.`,
  annotations: REFRESH_TOOL_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    properties: {
      dry_run: {
        type: 'boolean',
        description:
          'Report staleness, file count, embeddings, and whether a refresh would run (default: false).',
        default: false,
      },
      repo: {
        type: 'string',
        description:
          'Repository name or path. Omit only when one repo is indexed or an MCP default is configured; dry runs included.',
      },
    },
    required: [],
  },
};

/** Schema for a tool name, including opt-in tools outside the default catalog. */
export function findToolDefinition(name: string): ToolDefinition | undefined {
  return name === REFRESH_INDEX_TOOL.name
    ? REFRESH_INDEX_TOOL
    : GITNEXUS_TOOLS.find((tool) => tool.name === name);
}

/**
 * Per-repo tools that accept an optional `branch` scope (#2106). Single source
 * of truth: the schema property is injected here so it cannot drift from the
 * server-side default in `local-backend.ts` (`resolveRepo(repo, branch)`).
 * `list_repos` and the `group_*` tools are intentionally excluded — they are
 * not single-repo, single-branch operations. `read_file` and `grep` are in
 * this set so `repo` stays required with the other per-repo tools, and the
 * loop below skips `branch` for `CHECKOUT_SOURCE_TOOLS` — a pin would label
 * checkout bytes with another commit.
 */
export const CHECKOUT_SOURCE_TOOLS = new Set(['read_file', 'grep', 'rename', 'refresh_index']);

export const REPO_SCOPED_TOOLS = new Set([
  'read_file',
  'grep',
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
  'refresh_index',
]);

for (const tool of [...GITNEXUS_TOOLS, REFRESH_INDEX_TOOL]) {
  // Advertises a closed schema; tools/call still fail-closes on the scrubbed key list.
  // The unpublished handler aliases in tool-arguments.ts stay off this schema on
  // purpose (#2175), and closing it strands no caller: every alias has an
  // advertised counterpart reaching the same handler — `query` → `search_query`
  // on query, `query` → `statement` on cypher, and `target` → `name` on group
  // context, which local-backend maps to the group target (the group name comes
  // from `repo: "@group"`, not from `name`; see test/unit/mcp/group-repo-routing).
  // A schema-validating client therefore has a valid call for every tool, and
  // advertising the aliases instead would re-break Claude Code on `query`.
  tool.inputSchema.additionalProperties = false;
  if (!REPO_SCOPED_TOOLS.has(tool.name)) continue;
  // Checkout reads follow the working tree. Do not advertise `branch`.
  if (CHECKOUT_SOURCE_TOOLS.has(tool.name)) continue;
  if (tool.inputSchema.properties.branch) continue;
  // Optional — `required` is left unchanged so omitting `branch` keeps today's
  // workspace-index behavior. Ignored in group mode (repo starts "@").
  tool.inputSchema.properties.branch = {
    type: 'string',
    description:
      'Optional: scope to a pinned branch index (multi-branch repos, #2106). ' +
      'Omit for the workspace index, which follows the checked-out working tree. ' +
      'Ignored in group mode.',
  };
}
