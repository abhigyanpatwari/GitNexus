/**
 * Unit tests: Angular metadata extractor (Issue #31).
 *
 * Coverage matrix:
 *  1. @NgModule({ providers: [UserService, AuthService] })
 *     → 2 AngularCallRecords, sourceId = Class:<file>:AppModule, calledName in {UserService, AuthService}
 *  2. @Component({ template: '<button (click)="onClick()">...' })
 *     → 1 AngularCallRecord, sourceId = Class:<file>:AppComponent, calledName = onClick,
 *       receiverTypeName = AppComponent
 *  3. Template binding with arguments: (input)="onInput($event)" → onInput
 *  4. Multiple bindings in one template → both method names captured
 *  5. Class without @NgModule/@Component → no records
 *  6. Non-Angular files → no records
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { extractAngularCalls, extractTemplateBindingMethods } from '../../src/core/ingestion/extractors/angular-calls.js';

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code);
}

describe('Angular metadata calls extractor (#31)', () => {
  describe('extractTemplateBindingMethods (regex unit)', () => {
    it('captures method name from (click)="onClick()"', () => {
      expect(extractTemplateBindingMethods('<button (click)="onClick()">'))
        .toEqual(['onClick']);
    });

    it('captures method name with $event arg', () => {
      expect(extractTemplateBindingMethods('<input (input)="onInput($event)">'))
        .toEqual(['onInput']);
    });

    it('captures multiple methods in one template, deduped', () => {
      const tpl = '<button (click)="onClick()"><input (input)="onInput($event)" (blur)="onBlur()">';
      expect(extractTemplateBindingMethods(tpl).sort())
        .toEqual(['onBlur', 'onClick', 'onInput']);
    });

    it('returns empty array for templates without bindings', () => {
      expect(extractTemplateBindingMethods('<h1>Hello</h1>')).toEqual([]);
    });
  });

  describe('extractAngularCalls — @NgModule providers', () => {
    it('emits one call per provider, sourceId = Class:<file>:AppModule', () => {
      const code = `
        import { NgModule } from '@angular/core';
        import { UserService } from './user.service';
        import { AuthService } from './auth.service';
        @NgModule({
          providers: [UserService, AuthService],
        })
        export class AppModule {}
      `;
      const calls = extractAngularCalls(parse(code), 'src/app.module.ts');
      expect(calls).toHaveLength(2);
      const names = calls.map(c => c.calledName).sort();
      expect(names).toEqual(['AuthService', 'UserService']);
      for (const c of calls) {
        expect(c.sourceId).toBe('Class:src/app.module.ts:AppModule');
        expect(c.callForm).toBe('free');
        expect(c.receiverName).toBeUndefined();
        expect(c.receiverTypeName).toBeUndefined();
      }
    });

    it('handles single provider', () => {
      const code = `
        import { NgModule } from '@angular/core';
        import { UserService } from './user.service';
        @NgModule({ providers: [UserService] })
        export class AppModule {}
      `;
      const calls = extractAngularCalls(parse(code), 'app.module.ts');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.calledName).toBe('UserService');
      expect(calls[0]?.sourceId).toBe('Class:app.module.ts:AppModule');
    });

    it('handles empty providers array', () => {
      const code = `
        import { NgModule } from '@angular/core';
        @NgModule({ providers: [] })
        export class AppModule {}
      `;
      const calls = extractAngularCalls(parse(code), 'app.module.ts');
      expect(calls).toEqual([]);
    });

    it('ignores non-Angular classes (no decorator)', () => {
      const code = `
        export class Foo {
          doWork() {}
        }
      `;
      const calls = extractAngularCalls(parse(code), 'foo.ts');
      expect(calls).toEqual([]);
    });
  });

  describe('extractAngularCalls — @Component template', () => {
    it('emits one call per template binding, receiverTypeName = component class', () => {
      const code = `
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-root',
          template: '<button (click)="onClick()">Go</button>',
        })
        export class AppComponent {
          onClick() {}
        }
      `;
      const calls = extractAngularCalls(parse(code), 'src/app.component.ts');
      expect(calls).toHaveLength(1);
      const c = calls[0]!;
      expect(c.calledName).toBe('onClick');
      expect(c.sourceId).toBe('Class:src/app.component.ts:AppComponent');
      expect(c.callForm).toBe('member');
      expect(c.receiverName).toBe('this');
      expect(c.receiverTypeName).toBe('AppComponent');
    });

    it('handles multiple bindings in a single template', () => {
      const code = `
        import { Component } from '@angular/core';
        @Component({
          template: \`
            <button (click)="onClick()">Go</button>
            <input (input)="onInput(\$event)" (blur)="onBlur()">
          \`,
        })
        export class AppComponent {}
      `;
      const calls = extractAngularCalls(parse(code), 'src/app.component.ts');
      const names = calls.map(c => c.calledName).sort();
      expect(names).toEqual(['onBlur', 'onClick', 'onInput']);
    });

    it('ignores @Component when template is missing', () => {
      const code = `
        import { Component } from '@angular/core';
        @Component({ selector: 'app-root' })
        export class AppComponent {}
      `;
      const calls = extractAngularCalls(parse(code), 'src/app.component.ts');
      expect(calls).toEqual([]);
    });

    it('captures binding with method-call-args ($event)', () => {
      const code = `
        import { Component } from '@angular/core';
        @Component({
          template: '<input (input)="onInput($event)">',
        })
        export class MyComp {}
      `;
      const calls = extractAngularCalls(parse(code), 'comp.ts');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.calledName).toBe('onInput');
    });
  });

  describe('extractAngularCalls — combined @NgModule + @Component', () => {
    it('a file with two classes decorated with different decorators yields records for both', () => {
      const code = `
        import { Component, NgModule } from '@angular/core';
        @Component({ template: '<button (click)="go()">' })
        export class AppComponent { go() {} }
        @NgModule({ providers: [AppComponent] })
        export class AppModule {}
      `;
      const calls = extractAngularCalls(parse(code), 'app.ts');
      // 1 template binding (AppComponent → go) + 1 provider (AppModule → AppComponent) = 2
      expect(calls).toHaveLength(2);
      const bySource = new Map(calls.map(c => [c.sourceId, c]));
      expect(bySource.get('Class:app.ts:AppComponent')?.calledName).toBe('go');
      expect(bySource.get('Class:app.ts:AppModule')?.calledName).toBe('AppComponent');
    });
  });

  describe('edge cases', () => {
    it('returns empty array for null tree', () => {
      expect(extractAngularCalls(null as any, 'x.ts')).toEqual([]);
    });

    it('returns empty array for non-Angular file', () => {
      const code = `
        export function add(a: number, b: number): number {
          return a + b;
        }
      `;
      expect(extractAngularCalls(parse(code), 'utils.ts')).toEqual([]);
    });
  });
});
