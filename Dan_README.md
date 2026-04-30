# Quick Start for Dan

This is the NexusForge/GitNexus fork: a local-first code analysis tool that indexes a repository, stores a code knowledge graph, and serves an interactive website for exploring code graphs.

## Requirements

- Node.js 20.19+ or Node.js 22.12+
- npm
- Git is helpful, but folders without `.git` can still be analyzed with `--skip-git`

## First Setup

Open a terminal in this folder, then install and build the shared types package:

```powershell
cd gitnexus-shared
npm install
npm run build
```

Build the CLI/server package. This also builds the website and copies it into the CLI server bundle:

```powershell
cd ..\gitnexus
npm install
npm run build
```

## Analyze a Repository

From the `gitnexus` folder, index any codebase:

```powershell
node dist\cli\index.js analyze "C:\path\to\some-repo" --name some-repo
```

If the target folder is not a Git repo, add `--skip-git`:

```powershell
node dist\cli\index.js analyze "C:\path\to\some-folder" --name some-folder --skip-git
```

Useful checks:

```powershell
node dist\cli\index.js list
node dist\cli\index.js status
node dist\cli\index.js doctor
```

## Start the Website Graphs

Start the local web server:

```powershell
node dist\cli\index.js serve --port 4747
```

Open this in your browser:

```text
http://localhost:4747
```

Choose an indexed repository, then use the graph view to inspect files, symbols, routes, execution flows, and runtime overlays when available.

If port `4747` is busy, choose another port:

```powershell
node dist\cli\index.js serve --port 4848
```

## Optional Runtime/Log Overlay

After indexing a repo, you can import runtime evidence such as structured JSONL logs:

```powershell
node dist\cli\index.js runtime import "C:\path\to\logs.jsonl" --repo some-repo
```

Then restart or refresh the website graph to see runtime nodes and evidence.

## Troubleshooting

- Lock error on `.gitnexus`: close other `gitnexus serve`, `gitnexus mcp`, or `gitnexus analyze` processes for that repo, then retry.
- Website loads but no repos appear: run `node dist\cli\index.js list` to confirm the repo was indexed.
- Build fails after unzipping: delete any partial `node_modules` folders created during the failed install, then rerun the setup commands above.
- Large repositories can take a while to analyze. Start with a smaller repo to confirm the local setup is working.
