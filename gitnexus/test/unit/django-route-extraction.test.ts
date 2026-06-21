import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { extractDjangoRoutes } from '../../src/core/ingestion/route-extractors/django.js';

const parser = new Parser();
parser.setLanguage(Python);

const extract = (
  source: string,
  filePath = 'app/urls.py',
  readFile?: (path: string) => string | null,
) =>
  extractDjangoRoutes(parser.parse(source), filePath, parser, readFile).map((route) => ({
    httpMethod: route.httpMethod,
    routePath: route.routePath,
    routeName: route.routeName,
    controllerName: route.controllerName,
    prefix: route.prefix,
    filePath: route.filePath,
  }));

describe('Django route extraction', () => {
  it('extracts path() routes from urlpatterns', () => {
    const routes = extract(`
from django.urls import path
from . import views

urlpatterns = [
    path('orders/', views.order_list),
    path('orders/<int:pk>/', views.order_detail),
    path('users/', views.user_list, name='user-list'),
]
`);
    expect(routes).toHaveLength(3);

    expect(routes[0]).toMatchObject({ httpMethod: '*', routePath: 'orders/' });
    expect(routes[1]).toMatchObject({ httpMethod: '*', routePath: 'orders/<int:pk>/' });
    expect(routes[2]).toMatchObject({
      httpMethod: '*',
      routePath: 'users/',
      routeName: 'user-list',
    });
  });

  it('extracts re_path() routes', () => {
    const routes = extract(`
from django.urls import re_path
from . import views

urlpatterns = [
    re_path(r'^articles/(?P<year>[0-9]{4})/$', views.year_archive),
]
`);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      httpMethod: '*',
      routePath: '^articles/(?P<year>[0-9]{4})/$',
    });
  });

  it('extracts legacy url() routes', () => {
    const routes = extract(`
from django.conf.urls import url
from . import views

urlpatterns = [
    url(r'^legacy/$', views.legacy_view),
]
`);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ httpMethod: '*', routePath: '^legacy/$' });
  });

  it('handles str concatenation in path strings', () => {
    const routes = extract(`
from django.urls import path
from . import views

urlpatterns = [
    path('api/' + 'v1/users/', views.user_list),
]
`);
    // Binary operator concatenation should produce the full path
    expect(routes).toHaveLength(1);
    if (routes.length > 0) {
      expect(routes[0].routePath).toContain('api/');
      expect(routes[0].routePath).toContain('v1/users/');
    }
  });

  it('extracts from augmented assignment (urlpatterns += ...)', () => {
    const routes = extract(`
from django.urls import path
from . import views

urlpatterns = [
    path('base/', views.base),
]
urlpatterns += [
    path('extra/', views.extra),
]
`);
    // Should find at least 'extra/' from the augmented assignment
    expect(routes.some((r) => r.routePath === 'extra/')).toBe(true);
  });

  it('resolves include() to child url files via readFile', () => {
    const childContent = `
from django.urls import path
from . import views

urlpatterns = [
    path('list/', views.item_list),
    path('<int:pk>/', views.item_detail),
]
`;
    const readFile = (path: string) => {
      if (path === 'items/urls.py' || path === 'app/items/urls.py') return childContent;
      return null;
    };

    const routes = extract(
      `
from django.urls import path, include
from . import views

urlpatterns = [
    path('api/', include('items.urls')),
    path('health/', views.health),
]
`,
      'app/urls.py',
      readFile,
    );

    // Should have: health/ and two routes from items/urls.py with prefix 'api/'
    const healthRoute = routes.find((r) => r.routePath === 'health/');
    expect(healthRoute).toBeDefined();
    expect(healthRoute?.filePath).toBe('app/urls.py');

    const prefixedRoutes = routes.filter((r) => r.prefix === 'api/');
    expect(prefixedRoutes).toHaveLength(2);
    expect(prefixedRoutes.some((r) => r.routePath === 'list/')).toBe(true);
    expect(prefixedRoutes.some((r) => r.routePath === '<int:pk>/')).toBe(true);
    expect(prefixedRoutes.every((r) => r.filePath === 'items/urls.py')).toBe(true);
  });

  it('resolves nested includes with accumulated prefixes', () => {
    const childContent = `
from django.urls import path, include
from . import views

urlpatterns = [
    path('v1/', include('v1.urls')),
    path('v2/', include('v2.urls')),
]
`;
    const grandchildContent = `
from django.urls import path
from . import views

urlpatterns = [
    path('users/', views.user_list),
]
`;
    const readFile = (path: string) => {
      if (path === 'app/api/urls.py') return childContent;
      if (path === 'v1/urls.py' || path === 'app/v1/urls.py') return grandchildContent;
      if (path === 'v2/urls.py' || path === 'app/v2/urls.py') return grandchildContent;
      return null;
    };

    const routes = extract(
      `
from django.urls import path, include

urlpatterns = [
    path('api/', include('app.api.urls')),
]
`,
      'root/urls.py',
      readFile,
    );

    // Should have deeply prefixed routes: api/v1/users/ and api/v2/users/
    const prefixedRoutes = routes.filter((r) => r.prefix != null);
    const hasApiV1Users = prefixedRoutes.some(
      (r) => r.prefix === 'api/v1/' && r.routePath === 'users/',
    );
    const hasApiV2Users = prefixedRoutes.some(
      (r) => r.prefix === 'api/v2/' && r.routePath === 'users/',
    );
    expect(hasApiV1Users).toBe(true);
    expect(hasApiV2Users).toBe(true);
    // Included routes should report their actual source file
    const v1Routes = routes.filter((r) => r.prefix === 'api/v1/');
    expect(v1Routes.every((r) => r.filePath === 'v1/urls.py')).toBe(true);
    const v2Routes = routes.filter((r) => r.prefix === 'api/v2/');
    expect(v2Routes.every((r) => r.filePath === 'v2/urls.py')).toBe(true);
  });

  it('emits both mounts when one urlconf is included under two prefixes (diamond)', () => {
    const common = `
from django.urls import path
from . import views

urlpatterns = [
    path('ping/', views.ping),
]
`;
    const readFile = (path: string) =>
      path === 'common/urls.py' || path === 'app/common/urls.py' ? common : null;

    const routes = extract(
      `
from django.urls import path, include

urlpatterns = [
    path('v1/', include('common.urls')),
    path('v2/', include('common.urls')),
]
`,
      'app/urls.py',
      readFile,
    );

    const pings = routes.filter((r) => r.routePath === 'ping/');
    expect(pings).toHaveLength(2);
    expect(pings.some((r) => r.prefix === 'v1/')).toBe(true);
    expect(pings.some((r) => r.prefix === 'v2/')).toBe(true);
  });

  it('terminates on a self-referential include() cycle without re-emitting routes', () => {
    const entrySource = `
from django.urls import path, include
from . import views

urlpatterns = [
    path('home/', views.home),
    include('app.urls'),
]
`;
    // `app.urls` resolves back to the entry file — a cycle the guard must break.
    const readFile = (path: string) => (path === 'app/urls.py' ? entrySource : null);

    const routes = extract(entrySource, 'app/urls.py', readFile);

    // The cycle is bounded (no hang) and home/ is emitted exactly once.
    expect(routes.filter((r) => r.routePath === 'home/')).toHaveLength(1);
  });

  it('resolves include() to the project-local app, not a same-named app at the repo root (monorepo)', () => {
    const rootApp = `
from django.urls import path
from . import views
urlpatterns = [path('wrong/', views.wrong)]
`;
    const backendApp = `
from django.urls import path
from . import views
urlpatterns = [path('right/', views.right)]
`;
    // A monorepo with a repo-root app/ AND a backend/ Django project that also
    // has an app/. The manage.py at backend/ pins the project root.
    const fsMap: Record<string, string> = {
      'backend/manage.py': "DJANGO_SETTINGS_MODULE = 'myproj.settings'\n",
      'app/urls.py': rootApp,
      'backend/app/urls.py': backendApp,
    };
    const readFile = (p: string) =>
      Object.prototype.hasOwnProperty.call(fsMap, p) ? fsMap[p] : null;

    const routes = extract(
      `
from django.urls import path, include
urlpatterns = [path('api/', include('app.urls'))]
`,
      'backend/myproj/urls.py',
      readFile,
    );

    // The include resolves to backend/app/urls.py (project-local), not the
    // repo-root app/urls.py.
    expect(routes.map((r) => r.routePath)).toEqual(['right/']);
    expect(routes.map((r) => r.filePath)).toEqual(['backend/app/urls.py']);
  });

  it('resolves views with attribute-style references (views.function)', () => {
    const routes = extract(`
from django.urls import path
from . import views

urlpatterns = [
    path('dashboard/', views.DashboardView.as_view()),
    path('report/', views.report_view),
]
`);
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({
      httpMethod: '*',
      routePath: 'dashboard/',
      controllerName: 'views.DashboardView.as_view()',
    });
    expect(routes[1]).toMatchObject({
      httpMethod: '*',
      routePath: 'report/',
      controllerName: 'views.report_view',
    });
  });

  it('infers HTTP method from view name suffix', () => {
    const routes = extract(`
from django.urls import path

urlpatterns = [
    path('users/', views.get_user),
    path('users/', views.post_user),
    path('users/', views.put_user),
    path('users/', views.patch_user),
    path('users/', views.delete_user),
]
`);
    const methods = routes.map((r) => r.httpMethod);
    expect(methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });

  it('handles include with tuple namespace', () => {
    const childContent = `
from django.urls import path

urlpatterns = [
    path('profile/', views.profile),
]
`;
    const readFile = (path: string) => {
      if (path === 'account/urls.py' || path === 'app/account/urls.py') return childContent;
      return null;
    };

    const routes = extract(
      `
from django.urls import path, include

urlpatterns = [
    path('account/', include(('account.urls', 'app_name'), namespace='account')),
]
`,
      'app/urls.py',
      readFile,
    );

    const prefixedRoutes = routes.filter((r) => r.prefix === 'account/');
    expect(prefixedRoutes.length).toBeGreaterThanOrEqual(1);
    expect(prefixedRoutes.some((r) => r.filePath === 'account/urls.py')).toBe(true);
  });

  it('does not crash on empty urlpatterns', () => {
    const routes = extract(`
from django.urls import path

urlpatterns = []
`);
    expect(routes).toHaveLength(0);
  });

  it('skips non-urlpatterns assignments', () => {
    const routes = extract(`
from django.urls import path

OTHER_LIST = [
    path('not-a-route/', something),
]

urlpatterns = [
    path('real/', views.real),
]
`);
    expect(routes).toHaveLength(1);
    expect(routes[0].routePath).toBe('real/');
  });

  it('extracts routes from list concatenation (urlpatterns = a + b)', () => {
    const routes = extract(`
from django.urls import path
from . import views

urlpatterns = [path('a/', views.a)] + [path('b/', views.b)]
`);
    expect(routes.map((r) => r.routePath).sort()).toEqual(['a/', 'b/']);
  });

  it('extracts routes wrapped in format_suffix_patterns()', () => {
    const routes = extract(`
from rest_framework.urlpatterns import format_suffix_patterns
from django.urls import path
from . import views

urlpatterns = format_suffix_patterns([path('a/', views.a)])
`);
    expect(routes).toHaveLength(1);
    expect(routes[0].routePath).toBe('a/');
  });

  it('extracts routes from a tuple urlpatterns', () => {
    const routes = extract(`
from django.urls import path
from . import views

urlpatterns = (path('a/', views.a),)
`);
    expect(routes).toHaveLength(1);
    expect(routes[0].routePath).toBe('a/');
  });

  it('combines a base list with an augmented concatenation (urlpatterns += a + b)', () => {
    const routes = extract(`
from django.urls import path
from . import views

urlpatterns = [path('base/', views.base)]
urlpatterns += [path('x/', views.x)] + [path('y/', views.y)]
`);
    expect(routes.map((r) => r.routePath).sort()).toEqual(['base/', 'x/', 'y/']);
  });

  it('returns no routes (without throwing) for dynamic urlpatterns like router.urls', () => {
    const routes = extract(`
from rest_framework import routers

router = routers.DefaultRouter()
urlpatterns = router.urls
`);
    expect(routes).toEqual([]);
  });
});
