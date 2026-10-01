import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

describe('Go route declaration identity through ingestion', () => {
  let repo: string;
  let result: PipelineResult;
  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-go-binding-'));
    await mkdir(path.join(repo, 'handlers'));
    await writeFile(path.join(repo, 'go.mod'), 'module example.com/bindings\n\ngo 1.24\n');
    await writeFile(
      path.join(repo, 'handlers', 'handler.go'),
      `package handlers
import "github.com/gin-gonic/gin"
func Do(*gin.Context) {}
`,
    );
    await writeFile(
      path.join(repo, 'routes.go'),
      `package routes
import (
  "github.com/gin-gonic/gin"
  "example.com/bindings/handlers"
)
func Handle(*gin.Context) {}
type A struct{}
func (*A) Do(*gin.Context) {}
type B struct{}
func (*B) Do(*gin.Context) {}
func NewH() *A { return &A{} }
func Bare(r *gin.Engine, Handle gin.HandlerFunc) { r.GET("/bare", Handle) }
func Constructor(r *gin.Engine, NewH func() *B) {
  h := NewH()
  r.GET("/constructor", h.Do)
}
func Captured() {
  _ = handlers.Do
  handlers := &B{}
  func() { r := gin.New(); r.GET("/captured", handlers.Do) }()
}
func Write(r *gin.Engine) {
  var h interface{ Do(*gin.Context) } = &A{}
  func() { h = &B{} }()
  r.GET("/write", h.Do)
}
type FakeRouter struct{}
func (FakeRouter) GET(string, gin.HandlerFunc) {}
func Shadow(r *gin.Engine) {
  { var r FakeRouter; r.GET("/fake", Handle) }
  r.GET("/real", Handle)
}
func TypeShadow(r *gin.Engine) {
  type A = B
  h := &A{}
  r.GET("/type", h.Do)
}
func Independent(r *gin.Engine) {
  h := &A{}
  func() { h := &B{}; _ = h }()
  r.GET("/independent", h.Do)
}
`,
    );
    result = await runPipelineFromRepo(repo, () => {}, {});
  }, 300_000);
  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  const route = (url: string) => {
    const nodes: { id: string; handler: unknown }[] = [];
    result.graph.forEachNode((node) => {
      if (node.label === 'Route' && node.properties.name === url) {
        nodes.push({ id: node.id, handler: node.properties.handlerSymbolId });
      }
    });
    return nodes;
  };

  it.each(['/bare', '/constructor', '/type', '/write'])(
    'keeps %s without an unproven handler edge',
    (url) => {
      const routes = route(url);
      expect(routes).toHaveLength(1);
      expect(routes[0]?.handler).toBeUndefined();
      const incoming: string[] = [];
      result.graph.forEachRelationship((edge) => {
        if (edge.type === 'HANDLES_ROUTE' && edge.targetId === routes[0]?.id)
          incoming.push(edge.sourceId);
      });
      // Unresolved routes retain their file-level ownership edge.
      expect(incoming).toEqual(['File:routes.go']);
    },
  );

  it('selects the captured local type instead of the imported function', () => {
    expect(route('/captured')[0]?.handler).toMatch(/^Method:routes.go:B\.Do/);
  });

  it('rejects a shadowed non-framework receiver and retains the outer engine', () => {
    expect(route('/fake')).toEqual([]);
    expect(route('/real')[0]?.handler).toBe('Function:routes.go:Handle');
  });

  it('retains facts when a nested declaration does not write the captured variable', () => {
    expect(route('/independent')[0]?.handler).toMatch(/^Method:routes.go:A\.Do/);
  });
});
