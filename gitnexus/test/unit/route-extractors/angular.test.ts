/**
 * Unit tests: Angular route extractor (Issues #7, #43).
 *
 * Coverage matrix:
 *  1. `RouterModule.forRoot([{path: '/x', component: ...}])` → 1 Route
 *  2. `RouterModule.forChild([...])` works the same way
 *  3. Direct `const ROUTES = [...]` array is recognised
 *  4. `children: [...]` recursion prepends parent path
 *  5. `loadChildren` → 1 Route annotated as lazy
 *  6. `redirectTo` → 1 Route annotated with target
 *  7. Non-Angular files produce no routes
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { extractAngularRoutes, isAngularFile } from '../../../src/core/ingestion/route-extractors/angular.js';

function parse(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code);
}

describe('Angular route extractor (#7, #43)', () => {
  describe('isAngularFile detection', () => {
    it('accepts .ts files that mention RouterModule', () => {
      expect(isAngularFile('app.routes.ts', "import { RouterModule } from '@angular/router';")).toBe(true);
    });
    it('accepts .ts files that import @angular/router', () => {
      expect(isAngularFile('src/router.ts', "import { Routes } from '@angular/router';")).toBe(true);
    });
    it('accepts .ts files that use provideRouter (standalone API)', () => {
      expect(isAngularFile('main.ts', 'provideRouter(ROUTES)')).toBe(true);
    });
    it('rejects .ts files with no Angular markers', () => {
      expect(isAngularFile('utils.ts', 'export function add(a, b) { return a + b; }')).toBe(false);
    });
    it('rejects non-ts files even with Angular markers', () => {
      expect(isAngularFile('app.js', "import { RouterModule } from '@angular/router';")).toBe(false);
    });
  });

  describe('RouterModule.forRoot', () => {
    it('extracts a single inline route', () => {
      const code = `
        import { RouterModule, Routes } from '@angular/router';
        import { HomeComponent } from './home.component';
        @NgModule({
          imports: [RouterModule.forRoot([
            { path: 'home', component: HomeComponent },
          ])],
          exports: [RouterModule],
        })
        export class AppRoutingModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'app-routing.module.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        filePath: 'app-routing.module.ts',
        httpMethod: 'GET',
        routePath: '/home',
        controllerName: null, // file isn't app.routes.ts
        methodName: null,
        middleware: [],
        prefix: null,
        isControllerClass: false,
        isInherited: false,
      });
      expect(routes[0]?.lineNumber).toBeGreaterThan(0);
    });

    it('extracts a referenced const array', () => {
      const code = `
        import { RouterModule, Routes } from '@angular/router';
        import { HomeComponent } from './home.component';
        import { AboutComponent } from './about.component';

        export const ROUTES: Routes = [
          { path: '', component: HomeComponent },
          { path: 'about', component: AboutComponent },
        ];

        @NgModule({
          imports: [RouterModule.forRoot(ROUTES)],
          exports: [RouterModule],
        })
        export class AppRoutingModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'app-routing.module.ts');
      expect(routes).toHaveLength(2);
      expect(routes.map((r) => r.routePath).sort()).toEqual(['/', '/about']);
    });

    it('sets controllerName to AppModule when the file is app.routes.ts', () => {
      const code = `
        import { RouterModule, Routes } from '@angular/router';
        @NgModule({
          imports: [RouterModule.forRoot([
            { path: 'home', component: HomeComponent },
          ])],
        })
        export class AppModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'app.routes.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.controllerName).toBe('AppModule');
    });
  });

  describe('RouterModule.forChild', () => {
    it('extracts routes from a feature module', () => {
      const code = `
        import { RouterModule, Routes } from '@angular/router';
        import { FeatureComponent } from './feature.component';
        const FEATURE_ROUTES: Routes = [
          { path: 'feature', component: FeatureComponent },
          { path: 'feature/:id', component: FeatureComponent },
        ];
        @NgModule({
          imports: [RouterModule.forChild(FEATURE_ROUTES)],
          exports: [RouterModule],
        })
        export class FeatureRoutingModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'feature-routing.module.ts');
      expect(routes).toHaveLength(2);
      const paths = routes.map((r) => r.routePath).sort();
      expect(paths).toEqual(['/feature', '/feature/:id']);
    });
  });

  describe('children nesting', () => {
    it('prepends parent path to child path', () => {
      const code = `
        import { RouterModule, Routes } from '@angular/router';
        @NgModule({
          imports: [RouterModule.forRoot([
            {
              path: 'users',
              component: UserListComponent,
              children: [
                { path: ':id', component: UserDetailComponent },
                { path: 'new', component: UserNewComponent },
              ],
            },
          ])],
        })
        export class AppModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'app.routes.ts');
      // 1 parent + 2 children = 3
      expect(routes).toHaveLength(3);
      const paths = routes.map((r) => r.routePath).sort();
      expect(paths).toEqual(['/users', '/users/:id', '/users/new']);
      // Parent emits at /users (not at /children/placeholder)
      expect(routes.find((r) => r.routePath === '/users')).toBeDefined();
    });

    it('handles nested children with grandparent path', () => {
      const code = `
        import { RouterModule, Routes } from '@angular/router';
        @NgModule({
          imports: [RouterModule.forRoot([
            {
              path: 'admin',
              children: [
                {
                  path: 'users',
                  children: [
                    { path: ':id', component: AdminUserDetailComponent },
                  ],
                },
              ],
            },
          ])],
        })
        export class AppModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'app.routes.ts');
      const paths = routes.map((r) => r.routePath).sort();
      expect(paths).toContain('/admin');
      expect(paths).toContain('/admin/users');
      expect(paths).toContain('/admin/users/:id');
    });
  });

  describe('loadChildren (lazy loading)', () => {
    it('emits one route annotated as lazy', () => {
      const code = `
        import { RouterModule, Routes } from '@angular/router';
        @NgModule({
          imports: [RouterModule.forRoot([
            { path: 'lazy', loadChildren: () => import('./lazy.module').then(m => m.LazyModule) },
          ])],
        })
        export class AppModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'app.routes.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.routePath).toBe('/lazy (lazy)');
      expect(routes[0]?.httpMethod).toBe('GET');
    });
  });

  describe('redirectTo', () => {
    it('emits one route annotated with the redirect target', () => {
      const code = `
        import { RouterModule, Routes } from '@angular/router';
        @NgModule({
          imports: [RouterModule.forRoot([
            { path: 'redirect', redirectTo: 'users' },
          ])],
        })
        export class AppModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'app.routes.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.routePath).toBe('/redirect (redirect:users)');
    });
  });

  describe('non-Angular files', () => {
    it('returns an empty array for files without RouterModule', () => {
      const code = `
        export function add(a: number, b: number): number {
          return a + b;
        }
      `;
      const routes = extractAngularRoutes(parse(code), 'utils.ts');
      expect(routes).toEqual([]);
    });

    it('returns an empty array for null tree', () => {
      const routes = extractAngularRoutes(null, 'x.ts');
      expect(routes).toEqual([]);
    });
  });

  describe('standalone API (provideRouter)', () => {
    it('extracts routes from provideRouter', () => {
      const code = `
        import { provideRouter } from '@angular/router';
        import { HomeComponent } from './home.component';
        const ROUTES = [{ path: 'home', component: HomeComponent }];
        bootstrapApplication(AppComponent, {
          providers: [provideRouter(ROUTES)],
        });
      `;
      const routes = extractAngularRoutes(parse(code), 'main.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.routePath).toBe('/home');
    });
  });

  describe('direct array literal', () => {
    it('extracts routes from a const Routes array even without forRoot wiring', () => {
      const code = `
        import { Routes } from '@angular/router';
        import { HomeComponent } from './home.component';
        import { AboutComponent } from './about.component';
        export const APP_ROUTES: Routes = [
          { path: 'home', component: HomeComponent },
          { path: 'about', component: AboutComponent },
        ];
      `;
      const routes = extractAngularRoutes(parse(code), 'app.routes.ts');
      expect(routes).toHaveLength(2);
      const paths = routes.map((r) => r.routePath).sort();
      expect(paths).toEqual(['/about', '/home']);
    });
  });

  describe('Edge cases', () => {
    it('handles root path correctly', () => {
      const code = `
        @NgModule({
          imports: [RouterModule.forRoot([{ path: '', component: HomeComponent }])],
        })
        export class AppModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'app.routes.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.routePath).toBe('/');
    });

    it('handles dynamic segments with colons', () => {
      const code = `
        @NgModule({
          imports: [RouterModule.forRoot([{ path: 'users/:id/posts/:postId', component: PostComponent }])],
        })
        export class AppModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'app.routes.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.routePath).toBe('/users/:id/posts/:postId');
    });

    it('does not crash when RouterModule.forRoot() is called with no arguments', () => {
      const code = `
        import { NgModule } from '@angular/core';
        import { RouterModule } from '@angular/router';
        @NgModule({
          imports: [RouterModule.forRoot()],
        })
        export class AppModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'app.routes.ts');
      expect(routes).toEqual([]);
    });

    it('emits routes from multiple forRoot calls in the same file', () => {
      // Two independent module classes wiring two distinct route configs —
      // both should emit, neither should shadow the other.
      const code = `
        import { NgModule } from '@angular/core';
        import { RouterModule } from '@angular/router';
        import { HomeComponent } from './home.component';
        import { SettingsComponent } from './settings.component';
        @NgModule({
          imports: [RouterModule.forRoot([
            { path: 'home', component: HomeComponent },
          ])],
        })
        export class HomeModule {}
        @NgModule({
          imports: [RouterModule.forRoot([
            { path: 'settings', component: SettingsComponent },
          ])],
        })
        export class SettingsModule {}
      `;
      const routes = extractAngularRoutes(parse(code), 'app.routes.ts');
      expect(routes).toHaveLength(2);
      const paths = routes.map((r) => r.routePath).sort();
      expect(paths).toEqual(['/home', '/settings']);
    });
  });

  describe('Non-route keys (guards, resolvers, data) are ignored', () => {
    // These keys are common in Angular route configs but they describe
    // *behavior attached to* a route, not new routes. The extractor must
    // not invent extra routes for them.
    const route = (extras: string) => `
      import { NgModule } from '@angular/core';
      import { RouterModule } from '@angular/router';
      import { HomeComponent } from './home.component';
      import { AuthGuard } from './auth.guard';
      import { CanMatchService } from './can-match.service';
      import { DeactivateGuard } from './deactivate.guard';
      import { LazyGuard } from './lazy.guard';
      import { SomeResolver } from './some.resolver';
      @NgModule({
        imports: [RouterModule.forRoot([{
          path: 'home',
          component: HomeComponent,
          ${extras}
        }])],
      })
      export class AppModule {}
    `;

    it('ignores canActivate guard', () => {
      const routes = extractAngularRoutes(parse(route(`canActivate: [AuthGuard]`)), 'app.routes.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.routePath).toBe('/home');
    });

    it('ignores canMatch guard', () => {
      const routes = extractAngularRoutes(parse(route(`canMatch: [CanMatchService]`)), 'app.routes.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.routePath).toBe('/home');
    });

    it('ignores canDeactivate guard', () => {
      const routes = extractAngularRoutes(parse(route(`canDeactivate: [DeactivateGuard]`)), 'app.routes.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.routePath).toBe('/home');
    });

    it('ignores canLoad guard', () => {
      const routes = extractAngularRoutes(parse(route(`canLoad: [LazyGuard]`)), 'app.routes.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.routePath).toBe('/home');
    });

    it('ignores resolve property', () => {
      const routes = extractAngularRoutes(parse(route(`resolve: { data: SomeResolver }`)), 'app.routes.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.routePath).toBe('/home');
    });

    it('ignores data property', () => {
      const routes = extractAngularRoutes(parse(route(`data: { title: 'X' }`)), 'app.routes.ts');
      expect(routes).toHaveLength(1);
      expect(routes[0]?.routePath).toBe('/home');
    });
  });
});
