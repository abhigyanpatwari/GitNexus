# 03 — PRD / Acceptance Criteria

**Feature:** CLI-MCP Graph Visualization (`gitnexus view`)

---

## Requirements

### R1 — Command invocation
```
gitnexus view [path] [--output <file>] [--no-open]
```
- `path` — optional; defaults to `cwd` (same convention as `gitnexus analyze`)
- `--output` — path for generated HTML (default: `.gitnexus/graph.html`)
- `--no-open` — generate file but don't launch browser

### R2 — Data source
- Reads from the existing KuzuDB index via `buildGraph()` (`server/api.ts:20`)
- Fails with a clear message if the repo is not indexed:
  `"No index found. Run: gitnexus analyze"`

### R3 — Output: self-contained HTML
- Single file, no external assets beyond CDN JS (Sigma.js or D3.js)
- Embeds `nodes` and `relationships` as inline JSON
- Works offline once loaded (CDN fetched once; subsequent opens work from cache)

### R4 — Graph rendering
- Nodes: one per Function/Class/File/Community symbol
- Node color: mapped to cluster (`heuristicLabel`)
- Node size: scaled by degree (number of edges)
- Edges: directed, typed (`CALLS`, `IMPORTS`, `EXTENDS`, etc.)
- Layout: force-directed (Sigma.js ForceAtlas2 or D3 force simulation)

### R5 — Interactions (v1 minimum)
- Pan and zoom
- Click a node → highlight its direct neighbors + edges
- Hover a node → tooltip with `name`, `type`, `filePath`

### R6 — Performance
- Must render repos up to 1500 symbols without browser freeze
- Large repos (>1500 symbols): warn and offer `--filter <cluster>` to scope render

### R7 — Parity with `gitnexus wiki`
- Same UX pattern: command runs, outputs a file path, opens browser
- Same error handling conventions

---

## Proto-BDD specs

```gherkin
Feature: gitnexus view command

  Scenario: Basic invocation on indexed repo
    Given a repo has been indexed with gitnexus analyze
    When I run `gitnexus view`
    Then a file .gitnexus/graph.html is created
    And my default browser opens it
    And the graph shows nodes for all indexed symbols
    And nodes are colored by cluster

  Scenario: Repo not indexed
    Given no .gitnexus/ index exists
    When I run `gitnexus view`
    Then I see: "No index found. Run: gitnexus analyze"
    And exit code is 1

  Scenario: --no-open flag
    Given a repo has been indexed
    When I run `gitnexus view --no-open`
    Then .gitnexus/graph.html is created
    And the browser does NOT open

  Scenario: --output flag
    Given a repo has been indexed
    When I run `gitnexus view --output /tmp/my-graph.html`
    Then /tmp/my-graph.html is created

  Scenario: Click interaction
    Given the graph viewer is open
    When I click a node
    Then its direct neighbors are highlighted
    And all other nodes are dimmed
```
