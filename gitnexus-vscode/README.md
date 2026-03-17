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

Press `F5` in VS Code to launch an Extension Development Host.

## Configuration

- `gitnexus.mcp.autoRegister`: Automatically write `.vscode/mcp.json`
- `gitnexus.defaultRepo`: Preferred repo when multiple indexes exist
- `gitnexus.cli.command`: Command used to launch GitNexus (default `npx`)
- `gitnexus.cli.baseArgs`: Base args before subcommands
- `gitnexus.cli.mcpArgs`: Args to start MCP server (default `["mcp"]`)
