import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PipelineResult } from '../../src/types/pipeline.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('Go imported package identities', () => {
  let repo: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-go-package-names-'));
    const files: Record<string, string> = {
      'go.mod': 'module example.com/app\n\ngo 1.24\n',
      'api/v2/handlers.go':
        'package v2\nimport "github.com/gin-gonic/gin"\nfunc Handle(*gin.Context) {}\n',
      'storage/handlers.go':
        'package endpoints\nimport "github.com/gin-gonic/gin"\nfunc Handle(*gin.Context) {}\n',
      'endpoints/handlers.go':
        'package competing\nimport "github.com/gin-gonic/gin"\nfunc Handle(*gin.Context) {}\n',
      'aliased/handlers.go':
        'package original\nimport "github.com/gin-gonic/gin"\nfunc Handle(*gin.Context) {}\n',
      'routes.go': `package app
import (
  "github.com/gin-gonic/gin"
  "example.com/app/api/v2"
  "example.com/app/storage"
  "example.com/app/endpoints"
  renamed "example.com/app/aliased"
)
func Register(r *gin.Engine) {
  r.GET("/version", v2.Handle)
  r.GET("/declared", endpoints.Handle)
  r.GET("/competing", competing.Handle)
  r.GET("/alias", renamed.Handle)
}
func CallVersion() { v2.Handle(nil) }
func CallDeclared() { endpoints.Handle(nil) }
func CallCompeting() { competing.Handle(nil) }
func CallAlias() { renamed.Handle(nil) }
`,
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await writeFile(path.join(repo, file), content);
    }
    result = await runPipelineFromRepo(repo, () => {}, {});
  }, 300_000);

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it.each([
    ['/version', 'api/v2/handlers.go', 'CallVersion'],
    ['/declared', 'storage/handlers.go', 'CallDeclared'],
    ['/competing', 'endpoints/handlers.go', 'CallCompeting'],
    ['/alias', 'aliased/handlers.go', 'CallAlias'],
  ])('binds %s using the declared package name or explicit alias', (url, target, caller) => {
    const route = result.graph.getNode(`Route:GET ${url}`);
    const handler = result.graph.getNode(String(route?.properties.handlerSymbolId));
    expect(handler?.properties.filePath).toBe(target);
    const callTargets: string[] = [];
    result.graph.forEachRelationship((edge) => {
      if (edge.type !== 'CALLS') return;
      if (result.graph.getNode(edge.sourceId)?.properties.name !== caller) return;
      callTargets.push(String(result.graph.getNode(edge.targetId)?.properties.filePath));
    });
    expect(callTargets).toEqual([target]);
  });
});
