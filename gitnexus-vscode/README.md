# GitNexus VS Code Extension

Native VS Code integration for GitNexus knowledge graph tooling.

## Features

- Auto-registers the GitNexus MCP server in `.vscode/mcp.json`
- Chat participant `@gitnexus` with slash workflows: `/explore`, `/impact`, `/debug`, `/refactor`, `/flow`, `/changes`
- Sidebar views for indexed repositories, modules, and execution flows
- Editor context menu actions for symbol exploration and impact analysis
- Status bar indicator for index state (indexed/stale/not indexed)
- Interactive Sigma.js graph explorer in a webview panel
- Commands to run `gitnexus analyze` and open repo/process context quickly

## Requirements

- VS Code 1.93+
- `gitnexus` available through `npx` (default uses `npx -y gitnexus@latest`)

## Development

```bash
npm install
npm run build
```

Build a clean VSIX package:

```bash
npm run vsix:clean
```

Press `F5` in VS Code to launch an Extension Development Host.

## Usage

1. Run `GitNexus: Analyze Workspace` once in your repository.
2. GitNexus auto-refreshes repository/module/flow views on startup and after analyze runs.
3. Use the status bar item to monitor index freshness:
	- `GitNexus: Fresh`
	- `GitNexus: Stale`
	- `GitNexus: Not Indexed`

If status is stale, click the status bar item to trigger analyze; the extension polls and updates to fresh automatically when indexing completes.

## Configuration

- `gitnexus.mcp.autoRegister`: Automatically write `.vscode/mcp.json`
- `gitnexus.mcp.autoStart`: Automatically start GitNexus MCP on extension activation
- `gitnexus.defaultRepo`: Preferred repo when multiple indexes exist
- `gitnexus.cli.command`: Command used to launch GitNexus (default `npx`)
- `gitnexus.cli.baseArgs`: Base args before subcommands
- `gitnexus.cli.mcpArgs`: Args to start MCP server (default `["mcp"]`)

## Troubleshooting

- If `Analyze Workspace` fails with npm `ECOMPROMISED` or `ENOTEMPTY`, clear the npx temp cache and retry:

```bash
rm -rf ~/.npm/_npx
mkdir -p ~/.npm/_npx
npm cache verify
```

- If views look stale after updating the extension, run `Developer: Reload Window` once.
