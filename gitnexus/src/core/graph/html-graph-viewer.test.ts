import { describe, it, expect } from 'vitest'
import { generateHTMLGraphViewer } from './html-graph-viewer.js'

const nodes = [
  { id: 'fn_a', label: 'Function', properties: { name: 'doSomething', filePath: 'src/a.ts' } },
  { id: 'fn_b', label: 'Function', properties: { name: 'doOther', filePath: 'src/b.ts' } },
]
const relationships = [
  { id: 'fn_a_CALLS_fn_b', type: 'CALLS', sourceId: 'fn_a', targetId: 'fn_b' }
]

describe('generateHTMLGraphViewer', () => {
  it('returns a non-empty HTML string', () => {
    const html = generateHTMLGraphViewer(nodes as any, relationships as any, 'TestProject')
    expect(typeof html).toBe('string')
    expect(html.length).toBeGreaterThan(100)
    expect(html).toContain('<!DOCTYPE html>')
  })

  it('embeds all node ids in GRAPH_DATA', () => {
    const html = generateHTMLGraphViewer(nodes as any, relationships as any, 'TestProject')
    expect(html).toContain('fn_a')
    expect(html).toContain('fn_b')
  })

  it('embeds relationship data', () => {
    const html = generateHTMLGraphViewer(nodes as any, relationships as any, 'TestProject')
    expect(html).toContain('CALLS')
  })

  it('includes the project name in the title', () => {
    const html = generateHTMLGraphViewer(nodes as any, relationships as any, 'MyRepo')
    expect(html).toContain('MyRepo')
  })
})
