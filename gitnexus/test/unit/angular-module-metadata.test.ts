/**
 * Unit tests: Angular @NgModule metadata edge extractor (#32).
 *
 * Coverage matrix (mirrors the behavior-coverage checklist in the WI):
 *  1. `@NgModule({ declarations: [Foo, Bar] })` → 2 DECLARES edges
 *  2. `imports: [BrowserModule]` → 1 IMPORTS_MODULE edge
 *  3. `providers: [UserService]` → 1 PROVIDES edge
 *  4. `bootstrap: [AppComponent]` → 1 BOOTSTRAPS edge
 *  5. Empty `@NgModule()` → 0 edges
 *  6. Non-NgModule decorators (`@Component`) → 0 edges
 *  7. Edge types are wired through WorkerExtractedData → graph
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { extractAngularMetadata } from '../../src/core/ingestion/extractors/angular-metadata.js';
import { processAngularMetadataFromExtracted } from '../../src/core/ingestion/angular-metadata-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createResolutionContext, type ResolutionContext } from '../../src/core/ingestion/resolution-context.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code);
}

describe('Angular @NgModule metadata extractor (#32)', () => {
  describe('extractAngularMetadata — declarations', () => {
    it('emits one DECLARES edge per identifier in declarations array', () => {
      const code = `
        import { NgModule } from '@angular/core';
        import { AppComponent } from './app.component';
        import { HeaderComponent } from './header.component';
        @NgModule({
          declarations: [AppComponent, HeaderComponent],
        })
        export class AppModule {}
      `;
      const edges = extractAngularMetadata(parse(code), 'src/app.module.ts');
      const declares = edges.filter(e => e.edgeType === 'DECLARES');
      expect(declares).toHaveLength(2);
      const targets = declares.map(e => e.targetName).sort();
      expect(targets).toEqual(['AppComponent', 'HeaderComponent']);
      for (const e of declares) {
        expect(e.moduleClassName).toBe('AppModule');
        expect(e.filePath).toBe('src/app.module.ts');
      }
    });

    it('emits no DECLARES edges when declarations array is absent', () => {
      const code = `
        import { NgModule } from '@angular/core';
        @NgModule({})
        export class AppModule {}
      `;
      const edges = extractAngularMetadata(parse(code), 'app.module.ts');
      expect(edges.filter(e => e.edgeType === 'DECLARES')).toHaveLength(0);
    });
  });

  describe('extractAngularMetadata — imports', () => {
    it('emits one IMPORTS_MODULE edge per identifier in imports array', () => {
      const code = `
        import { NgModule } from '@angular/core';
        import { BrowserModule } from '@angular/platform-browser';
        @NgModule({
          imports: [BrowserModule],
        })
        export class AppModule {}
      `;
      const edges = extractAngularMetadata(parse(code), 'app.module.ts');
      const imports = edges.filter(e => e.edgeType === 'IMPORTS_MODULE');
      expect(imports).toHaveLength(1);
      expect(imports[0].targetName).toBe('BrowserModule');
      expect(imports[0].moduleClassName).toBe('AppModule');
    });
  });

  describe('extractAngularMetadata — providers', () => {
    it('emits one PROVIDES edge per identifier in providers array', () => {
      const code = `
        import { NgModule } from '@angular/core';
        import { UserService } from './user.service';
        @NgModule({
          providers: [UserService],
        })
        export class AppModule {}
      `;
      const edges = extractAngularMetadata(parse(code), 'app.module.ts');
      const provides = edges.filter(e => e.edgeType === 'PROVIDES');
      expect(provides).toHaveLength(1);
      expect(provides[0].targetName).toBe('UserService');
    });
  });

  describe('extractAngularMetadata — bootstrap', () => {
    it('emits one BOOTSTRAPS edge per identifier in bootstrap array', () => {
      const code = `
        import { NgModule } from '@angular/core';
        import { AppComponent } from './app.component';
        @NgModule({
          bootstrap: [AppComponent],
        })
        export class AppModule {}
      `;
      const edges = extractAngularMetadata(parse(code), 'app.module.ts');
      const bootstraps = edges.filter(e => e.edgeType === 'BOOTSTRAPS');
      expect(bootstraps).toHaveLength(1);
      expect(bootstraps[0].targetName).toBe('AppComponent');
    });
  });

  describe('extractAngularMetadata — combined arrays', () => {
    it('emits edges from all four metadata arrays in one pass', () => {
      const code = `
        import { NgModule } from '@angular/core';
        import { BrowserModule } from '@angular/platform-browser';
        import { AppComponent } from './app.component';
        import { HeaderComponent } from './header.component';
        import { UserService } from './user.service';
        @NgModule({
          declarations: [AppComponent, HeaderComponent],
          imports: [BrowserModule],
          providers: [UserService],
          bootstrap: [AppComponent],
        })
        export class AppModule {}
      `;
      const edges = extractAngularMetadata(parse(code), 'app.module.ts');
      expect(edges.filter(e => e.edgeType === 'DECLARES')).toHaveLength(2);
      expect(edges.filter(e => e.edgeType === 'IMPORTS_MODULE')).toHaveLength(1);
      expect(edges.filter(e => e.edgeType === 'PROVIDES')).toHaveLength(1);
      expect(edges.filter(e => e.edgeType === 'BOOTSTRAPS')).toHaveLength(1);
    });
  });

  describe('extractAngularMetadata — negative cases', () => {
    it('emits 0 edges for empty @NgModule()', () => {
      const code = `
        import { NgModule } from '@angular/core';
        @NgModule()
        export class AppModule {}
      `;
      const edges = extractAngularMetadata(parse(code), 'app.module.ts');
      expect(edges).toEqual([]);
    });

    it('emits 0 edges for non-NgModule decorators (e.g. @Component)', () => {
      const code = `
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-root',
          template: '<h1>Hi</h1>',
        })
        export class AppComponent {}
      `;
      const edges = extractAngularMetadata(parse(code), 'app.component.ts');
      expect(edges).toEqual([]);
    });

    it('emits 0 edges for a class with no decorators', () => {
      const code = `
        export class PlainClass {
          doWork() { return 1; }
        }
      `;
      const edges = extractAngularMetadata(parse(code), 'plain.ts');
      expect(edges).toEqual([]);
    });

    it('emits 0 edges for non-Angular files (no decorators at all)', () => {
      const code = `
        export function add(a: number, b: number): number { return a + b; }
      `;
      const edges = extractAngularMetadata(parse(code), 'utils.ts');
      expect(edges).toEqual([]);
    });
  });

  describe('extractAngularMetadata — file metadata', () => {
    it('records the source line number of the @NgModule decorator', () => {
      // Decorator is on line 4 (0-based) of the body
      const code = [
        `import { NgModule } from '@angular/core';`,     // 0
        `import { AppComponent } from './app.component';`,// 1
        ``,                                                // 2
        `@NgModule({ declarations: [AppComponent] })`,    // 3
        `export class AppModule {}`,                       // 4
      ].join('\n');
      const edges = extractAngularMetadata(parse(code), 'app.module.ts');
      expect(edges).toHaveLength(1);
      expect(edges[0].lineNumber).toBe(3);
    });
  });
});

describe('processAngularMetadataFromExtracted — graph integration (#32)', () => {
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let ctx: ResolutionContext;

  beforeEach(() => {
    graph = createKnowledgeGraph();
    ctx = createResolutionContext();
  });

  it('emits DECLARES edges between registered AppModule and AppComponent', async () => {
    ctx.symbols.add('src/app.module.ts', 'AppModule', 'Class:src/app.module.ts:AppModule', 'Class');
    ctx.symbols.add('src/app.component.ts', 'AppComponent', 'Class:src/app.component.ts:AppComponent', 'Class');

    await processAngularMetadataFromExtracted(graph, [{
      filePath: 'src/app.module.ts',
      moduleClassName: 'AppModule',
      targetName: 'AppComponent',
      edgeType: 'DECLARES',
      lineNumber: 0,
    }], ctx);

    const declares = graph.relationships.filter(r => r.type === 'DECLARES');
    expect(declares).toHaveLength(1);
    expect(declares[0].sourceId).toBe('Class:src/app.module.ts:AppModule');
    expect(declares[0].targetId).toBe('Class:src/app.component.ts:AppComponent');
    expect(declares[0].confidence).toBeGreaterThan(0);
  });

  it('emits IMPORTS_MODULE / PROVIDES / BOOTSTRAPS edges with the right type', async () => {
    ctx.symbols.add('src/app.module.ts', 'AppModule', 'Class:src/app.module.ts:AppModule', 'Class');
    ctx.symbols.add('src/x.ts', 'BrowserModule', 'Class:src/x.ts:BrowserModule', 'Class');
    ctx.symbols.add('src/y.ts', 'UserService', 'Class:src/y.ts:UserService', 'Class');
    ctx.symbols.add('src/z.ts', 'AppComponent', 'Class:src/z.ts:AppComponent', 'Class');

    const edges = [
      { filePath: 'src/app.module.ts', moduleClassName: 'AppModule', targetName: 'BrowserModule', edgeType: 'IMPORTS_MODULE' as const, lineNumber: 0 },
      { filePath: 'src/app.module.ts', moduleClassName: 'AppModule', targetName: 'UserService', edgeType: 'PROVIDES' as const, lineNumber: 0 },
      { filePath: 'src/app.module.ts', moduleClassName: 'AppModule', targetName: 'AppComponent', edgeType: 'BOOTSTRAPS' as const, lineNumber: 0 },
    ];

    await processAngularMetadataFromExtracted(graph, edges, ctx);

    const byType = new Map<string, number>();
    for (const r of graph.relationships) {
      byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    }
    expect(byType.get('IMPORTS_MODULE')).toBe(1);
    expect(byType.get('PROVIDES')).toBe(1);
    expect(byType.get('BOOTSTRAPS')).toBe(1);
  });

  it('uses synthetic ids and lower confidence when symbols are not registered', async () => {
    // Neither AppModule nor FooService is in the symbol table.
    await processAngularMetadataFromExtracted(graph, [{
      filePath: 'src/app.module.ts',
      moduleClassName: 'AppModule',
      targetName: 'FooService',
      edgeType: 'PROVIDES',
      lineNumber: 0,
    }], ctx);

    const provides = graph.relationships.filter(r => r.type === 'PROVIDES');
    expect(provides).toHaveLength(1);
    // Both ends fall back to global tier → confidence = geometric mean of two globals.
    expect(provides[0].confidence).toBeGreaterThan(0);
    expect(provides[0].confidence).toBeLessThan(1);
  });

  it('skips self-edges (module referencing itself)', async () => {
    ctx.symbols.add('src/app.module.ts', 'AppModule', 'Class:src/app.module.ts:AppModule', 'Class');

    await processAngularMetadataFromExtracted(graph, [{
      filePath: 'src/app.module.ts',
      moduleClassName: 'AppModule',
      targetName: 'AppModule',
      edgeType: 'PROVIDES',
      lineNumber: 0,
    }], ctx);

    expect(graph.relationshipCount).toBe(0);
  });
});
