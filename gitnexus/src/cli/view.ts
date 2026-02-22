/**
 * View Command
 *
 * Generates a self-contained graph.html from the KuzuDB index and
 * opens it in the default browser.
 *
 * Usage: gitnexus view [path] [--no-open]
 */

import path from 'path'
import fs from 'fs/promises'
import { exec } from 'child_process'
import { findRepo } from '../storage/repo-manager.js'
import { initKuzu } from '../core/kuzu/kuzu-adapter.js'
import { buildGraph } from '../server/api.js'
import { generateHTMLGraphViewer } from '../core/graph/html-graph-viewer.js'
import { getCurrentCommit } from '../storage/git.js'

export interface ViewCommandOptions {
  noOpen?: boolean
  output?: string
}

function openInBrowser(filePath: string): void {
  const url = `file://${filePath}`
  let cmd: string
  if (process.platform === 'darwin') {
    cmd = `open "${url}"`
  } else if (process.platform === 'win32') {
    cmd = `start "" "${url}"`
  } else {
    cmd = `xdg-open "${url}"`
  }
  exec(cmd, (err) => {
    if (err) console.error('Failed to open browser:', err.message)
  })
}

export const viewCommand = async (
  inputPath?: string,
  options?: ViewCommandOptions,
) => {
  console.log('⚠ Experimental: gitnexus view is under active development.\n')

  const repoPath = inputPath ? path.resolve(inputPath) : process.cwd()
  const repo = await findRepo(repoPath)

  if (!repo) {
    console.error('No index found. Run: gitnexus analyze')
    process.exit(1)
  }

  const currentCommit = getCurrentCommit(repo.repoPath)
  if (currentCommit !== repo.meta.lastCommit) {
    console.warn('Index is stale — showing last indexed state. Run: gitnexus analyze\n')
  }

  await initKuzu(repo.kuzuPath)
  const { nodes, relationships } = await buildGraph()

  const projectName = path.basename(repo.repoPath)
  const outputPath = options?.output
    ? path.resolve(options.output)
    : path.join(repo.storagePath, 'graph.html')
  const html = generateHTMLGraphViewer(nodes, relationships, projectName)

  await fs.writeFile(outputPath, html, 'utf-8')
  console.log(`Graph written to: ${outputPath}`)
  console.log(`Nodes: ${nodes.length}  Edges: ${relationships.length}`)

  if (!options?.noOpen) {
    openInBrowser(outputPath)
  }
}
