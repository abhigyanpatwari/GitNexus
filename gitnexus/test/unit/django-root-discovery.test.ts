import { describe, it, expect } from 'vitest';
import { discoverDjangoRootUrl } from '../../src/core/ingestion/route-extractors/django-root-discovery.js';

/** Build a disk-style reader from a path → content record. */
const makeReader = (fsMap: Record<string, string>) => (relativePath: string) =>
  Object.prototype.hasOwnProperty.call(fsMap, relativePath) ? fsMap[relativePath] : null;

const MANAGE_PY = `#!/usr/bin/env python
import os
def main():
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'myproj.settings')
`;

describe('discoverDjangoRootUrl', () => {
  it('discovers the root urls.py from content-bearing files (no reader)', () => {
    const files = [
      { path: 'manage.py', content: MANAGE_PY },
      { path: 'myproj/settings.py', content: `ROOT_URLCONF = 'myproj.urls'\n` },
      { path: 'myproj/urls.py', content: `urlpatterns = []\n` },
    ];
    expect(discoverDjangoRootUrl(files)).toBe('myproj/urls.py');
  });

  it('discovers the root urls.py via the reader fallback when files carry no content', () => {
    const fsMap: Record<string, string> = {
      'manage.py': MANAGE_PY,
      'myproj/settings.py': `ROOT_URLCONF = 'myproj.urls'\n`,
      'myproj/urls.py': `urlpatterns = []\n`,
    };
    // Only paths are passed (the main-thread pass does this); content is resolved on demand.
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrl(files, undefined, makeReader(fsMap))).toBe('myproj/urls.py');
  });

  it('follows ROOT_URLCONF through a star-imported base settings module via the reader', () => {
    const fsMap: Record<string, string> = {
      'manage.py': MANAGE_PY,
      'myproj/settings.py': `from .base import *\n`,
      'myproj/base.py': `DEBUG = True\nROOT_URLCONF = 'myproj.urls'\n`,
      'myproj/urls.py': `urlpatterns = []\n`,
    };
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrl(files, undefined, makeReader(fsMap))).toBe('myproj/urls.py');
  });

  it('resolves a urls package directory module (urls/__init__.py)', () => {
    const fsMap: Record<string, string> = {
      'manage.py': MANAGE_PY,
      'myproj/settings.py': `ROOT_URLCONF = 'myproj.urls'\n`,
      'myproj/urls/__init__.py': `urlpatterns = []\n`,
    };
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrl(files, undefined, makeReader(fsMap))).toBe(
      'myproj/urls/__init__.py',
    );
  });

  it('returns null when there is no manage.py', () => {
    const fsMap: Record<string, string> = {
      'myproj/settings.py': `ROOT_URLCONF = 'myproj.urls'\n`,
      'myproj/urls.py': `urlpatterns = []\n`,
    };
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrl(files, undefined, makeReader(fsMap))).toBeNull();
  });

  it('returns null when ROOT_URLCONF cannot be found in settings', () => {
    const fsMap: Record<string, string> = {
      'manage.py': MANAGE_PY,
      'myproj/settings.py': `DEBUG = True\n`,
      'myproj/urls.py': `urlpatterns = []\n`,
    };
    const files = Object.keys(fsMap).map((path) => ({ path }));
    expect(discoverDjangoRootUrl(files, undefined, makeReader(fsMap))).toBeNull();
  });
});
