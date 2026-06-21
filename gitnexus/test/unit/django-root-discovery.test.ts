import { describe, it, expect } from 'vitest';
import { discoverDjangoRootUrls } from '../../src/core/ingestion/route-extractors/django-root-discovery.js';

/** Build a disk-style reader from a path → content record. */
const makeReader = (fsMap: Record<string, string>) => (relativePath: string) =>
  Object.prototype.hasOwnProperty.call(fsMap, relativePath) ? fsMap[relativePath] : null;

/** A `manage.py` body pointing at the given dotted settings module. */
const manageFor = (settingsModule: string) =>
  `#!/usr/bin/env python\nimport os\ndef main():\n    os.environ.setdefault('DJANGO_SETTINGS_MODULE', '${settingsModule}')\n`;

const MANAGE_PY = manageFor('myproj.settings');

describe('discoverDjangoRootUrls', () => {
  it('discovers the root urls.py from content-bearing files (no reader)', () => {
    const files = [
      { path: 'manage.py', content: MANAGE_PY },
      { path: 'myproj/settings.py', content: `ROOT_URLCONF = 'myproj.urls'\n` },
      { path: 'myproj/urls.py', content: `urlpatterns = []\n` },
    ];
    expect(discoverDjangoRootUrls(files)).toEqual(['myproj/urls.py']);
  });

  it('discovers the root urls.py via the reader fallback when files carry no content', () => {
    const fsMap: Record<string, string> = {
      'manage.py': MANAGE_PY,
      'myproj/settings.py': `ROOT_URLCONF = 'myproj.urls'\n`,
      'myproj/urls.py': `urlpatterns = []\n`,
    };
    // Only paths are passed (the main-thread pass does this); content is resolved on demand.
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrls(files, undefined, makeReader(fsMap))).toEqual(['myproj/urls.py']);
  });

  it('follows ROOT_URLCONF through a star-imported base settings module via the reader', () => {
    const fsMap: Record<string, string> = {
      'manage.py': MANAGE_PY,
      'myproj/settings.py': `from .base import *\n`,
      'myproj/base.py': `DEBUG = True\nROOT_URLCONF = 'myproj.urls'\n`,
      'myproj/urls.py': `urlpatterns = []\n`,
    };
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrls(files, undefined, makeReader(fsMap))).toEqual(['myproj/urls.py']);
  });

  it('resolves a urls package directory module (urls/__init__.py)', () => {
    const fsMap: Record<string, string> = {
      'manage.py': MANAGE_PY,
      'myproj/settings.py': `ROOT_URLCONF = 'myproj.urls'\n`,
      'myproj/urls/__init__.py': `urlpatterns = []\n`,
    };
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrls(files, undefined, makeReader(fsMap))).toEqual([
      'myproj/urls/__init__.py',
    ]);
  });

  it('discovers a Django project located in a subdirectory (settings resolved relative to manage.py)', () => {
    const fsMap: Record<string, string> = {
      'backend/manage.py': MANAGE_PY,
      'backend/myproj/settings.py': `ROOT_URLCONF = 'myproj.urls'\n`,
      'backend/myproj/urls.py': `urlpatterns = []\n`,
    };
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrls(files, undefined, makeReader(fsMap))).toEqual([
      'backend/myproj/urls.py',
    ]);
  });

  it('follows star-imported base settings for a subdirectory project', () => {
    const fsMap: Record<string, string> = {
      'backend/manage.py': MANAGE_PY,
      'backend/myproj/settings.py': `from .base import *\n`,
      'backend/myproj/base.py': `ROOT_URLCONF = 'myproj.urls'\n`,
      'backend/myproj/urls.py': `urlpatterns = []\n`,
    };
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrls(files, undefined, makeReader(fsMap))).toEqual([
      'backend/myproj/urls.py',
    ]);
  });

  it('discovers every project in a monorepo with multiple manage.py files', () => {
    const fsMap: Record<string, string> = {
      'serviceA/manage.py': manageFor('svca.settings'),
      'serviceA/svca/settings.py': `ROOT_URLCONF = 'svca.urls'\n`,
      'serviceA/svca/urls.py': `urlpatterns = []\n`,
      'serviceB/manage.py': manageFor('svcb.settings'),
      'serviceB/svcb/settings.py': `ROOT_URLCONF = 'svcb.urls'\n`,
      'serviceB/svcb/urls.py': `urlpatterns = []\n`,
    };
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrls(files, undefined, makeReader(fsMap))).toEqual([
      'serviceA/svca/urls.py',
      'serviceB/svcb/urls.py',
    ]);
  });

  it('returns an empty array when there is no manage.py', () => {
    const fsMap: Record<string, string> = {
      'myproj/settings.py': `ROOT_URLCONF = 'myproj.urls'\n`,
      'myproj/urls.py': `urlpatterns = []\n`,
    };
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrls(files, undefined, makeReader(fsMap))).toEqual([]);
  });

  it('returns an empty array when ROOT_URLCONF cannot be found in settings', () => {
    const fsMap: Record<string, string> = {
      'manage.py': MANAGE_PY,
      'myproj/settings.py': `DEBUG = True\n`,
      'myproj/urls.py': `urlpatterns = []\n`,
    };
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrls(files, undefined, makeReader(fsMap))).toEqual([]);
  });
});
