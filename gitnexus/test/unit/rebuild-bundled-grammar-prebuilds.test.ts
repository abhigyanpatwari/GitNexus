import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildEnvironment } = require('../../scripts/rebuild-bundled-grammar-prebuilds.cjs') as {
  buildEnvironment: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

describe('bundled grammar rebuild environment', () => {
  it('keeps compiler and flag overrides out of the recorded GCC build', () => {
    const inherited = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/builder',
      CC: 'clang',
      CXX: 'clang++',
      CC_target: 'clang',
      CXX_target: 'clang++',
      LINK_target: 'clang++',
      CFLAGS: '-O1',
      CXXFLAGS: '-O1',
      CPPFLAGS: '-DOVERRIDE',
      LDFLAGS: '-fuse-ld=lld',
      MAKEFLAGS: 'CC=clang',
      GYP_DEFINES: 'clang=1',
    };

    expect(buildEnvironment(inherited)).toEqual({
      PATH: inherited.PATH,
      HOME: inherited.HOME,
      CC: 'gcc',
      CXX: 'g++',
    });
    expect(inherited.CC).toBe('clang');
  });
});
