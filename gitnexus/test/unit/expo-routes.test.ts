import { describe, it, expect } from 'vitest';
import { expoFileToRouteURL } from '../../src/core/ingestion/route-extractors/expo.js';

describe('expoFileToRouteURL', () => {
  it('converts root index to /', () => {
    expect(expoFileToRouteURL('app/index.tsx')).toBe('/');
  });
  it('converts screen file to route', () => {
    expect(expoFileToRouteURL('app/settings.tsx')).toBe('/settings');
  });
  it('strips route groups', () => {
    expect(expoFileToRouteURL('app/(tabs)/index.tsx')).toBe('/');
    expect(expoFileToRouteURL('app/(tabs)/settings.tsx')).toBe('/settings');
    expect(expoFileToRouteURL('app/(auth)/login.tsx')).toBe('/login');
  });
  it('handles nested route groups', () => {
    expect(expoFileToRouteURL('app/(tabs)/(home)/feed.tsx')).toBe('/feed');
  });
  it('skips _layout files', () => {
    expect(expoFileToRouteURL('app/_layout.tsx')).toBeNull();
    expect(expoFileToRouteURL('app/(tabs)/_layout.tsx')).toBeNull();
  });
  it('skips +not-found files', () => {
    expect(expoFileToRouteURL('app/+not-found.tsx')).toBeNull();
  });
  it('handles +api routes', () => {
    expect(expoFileToRouteURL('app/users+api.ts')).toBe('/users');
    expect(expoFileToRouteURL('app/user/[id]+api.ts')).toBe('/user/[id]');
  });
  it('skips .d.ts files', () => {
    expect(expoFileToRouteURL('app/types.d.ts')).toBeNull();
  });
  it('returns null for non-app paths', () => {
    expect(expoFileToRouteURL('src/utils/helper.ts')).toBeNull();
  });
  it('normalizes backslashes', () => {
    expect(expoFileToRouteURL('app\\(tabs)\\settings.tsx')).toBe('/settings');
  });
  it('preserves dynamic segments', () => {
    expect(expoFileToRouteURL('app/user/[id].tsx')).toBe('/user/[id]');
    expect(expoFileToRouteURL('app/posts/[...slug].tsx')).toBe('/posts/[...slug]');
  });
});
