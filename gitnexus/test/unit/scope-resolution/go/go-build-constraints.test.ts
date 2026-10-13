import { describe, expect, it } from 'vitest';
import {
  goFileBuildConstraint,
  goBuildConstraintsMayOverlap,
} from '../../../../src/core/ingestion/languages/go/build-constraints.js';

const source = (tag = '') => `${tag ? `//go:build ${tag}\n\n` : ''}package example\n`;
const overlap = (a: string, b: string, aTag = '', bTag = '') =>
  goBuildConstraintsMayOverlap(
    goFileBuildConstraint(a, source(aTag)),
    goFileBuildConstraint(b, source(bTag)),
  );

describe('Go build constraints for method ownership', () => {
  it.each([
    ['value_linux.go', 'value_windows.go', false],
    ['value_amd64.go', 'value_arm64.go', false],
    ['value_linux_amd64_test.go', 'value_linux_arm64_test.go', false],
    ['linux.go', 'value_windows.go', true],
    ['value_unix.go', 'value_windows.go', true],
    ['value_madeup.go', 'value_windows.go', true],
    ['dir_linux/value.go', 'value_windows.go', true],
    ['dir\\value_linux.go', 'value_windows.go', false],
    ['value_linux.go', 'value_android.go', true],
    ['value_darwin.go', 'value_ios.go', true],
    ['value_solaris.go', 'value_illumos.go', true],
  ])('compares %s with %s', (a, b, expected) => expect(overlap(a, b)).toBe(expected));

  it.each([
    ['linux', 'windows', false],
    ['linux', 'android', true],
    ['linux && !android', 'android', false],
    ['unix', 'windows', false],
    ['!unix', 'darwin', false],
    ['fast', '!fast', false],
    ['!(!fast)', '!fast', false],
    ['fast', 'debug', true],
    ['fast && (cgo || debug)', '!(fast && (cgo || debug))', false],
    ['fast || debug && cgo', '!fast && debug && !cgo', false],
    ['fast || debug && cgo', '!fast && debug && cgo', true],
    ['fast && !fast', '', false],
    ['linux && windows', '', false],
    ['amd64 && arm64', '', false],
    ['go1.25', '!go1.24', true], // Unknown implications remain possible.
  ])('compares %s with %s', (a, b, expected) =>
    expect(overlap('a.go', 'b.go', a, b)).toBe(expected),
  );

  it('combines filename and explicit constraints', () => {
    expect(overlap('a_linux.go', 'b.go', '', '!linux')).toBe(false);
    expect(overlap('a_linux.go', 'b.go', 'windows')).toBe(false);
  });

  it('reads modern directives around block comments, but not inside them or after code', () => {
    const positive = goFileBuildConstraint('a.go', source('fast'));
    for (const text of [
      '/* license */\n//go:build !fast\n\npackage p\n',
      '//go:build !fast\n/* license */\npackage p\n',
    ])
      expect(goBuildConstraintsMayOverlap(positive, goFileBuildConstraint('b.go', text))).toBe(
        false,
      );
    for (const text of [
      '/*\n//go:build !fast\n*/\npackage p\n',
      'package p\n//go:build !fast\n',
      '//go:buildsomething !fast\npackage p\n',
    ])
      expect(goBuildConstraintsMayOverlap(positive, goFileBuildConstraint('b.go', text))).toBe(
        true,
      );
  });

  it('supports legacy line-AND, space-OR and comma-AND with modern precedence', () => {
    const legacy = goFileBuildConstraint(
      'a.go',
      '// +build fast,debug slow\n// +build cgo\n\npackage p\n',
    );
    const opposite = goFileBuildConstraint('b.go', source('!((fast && debug || slow) && cgo)'));
    expect(goBuildConstraintsMayOverlap(legacy, opposite)).toBe(false);
    const modern = goFileBuildConstraint('a.go', '//go:build fast\n// +build !fast\n\npackage p\n');
    expect(
      goBuildConstraintsMayOverlap(modern, goFileBuildConstraint('b.go', source('!fast'))),
    ).toBe(false);
    // Without the separating blank line, +build is package documentation.
    expect(
      goBuildConstraintsMayOverlap(
        goFileBuildConstraint('a.go', '// +build !fast\npackage p\n'),
        modern,
      ),
    ).toBe(true);
  });

  it('keeps malformed, missing and expensive constraints unknown', () => {
    for (const text of [
      undefined,
      '//go:build\n\npackage p\n',
      source('fast &&'),
      source('!!fast'),
      source('! !fast'),
      source('fast\u00a0&& debug'),
      source('fast\r&& debug'),
      source('(fast'),
      '//go:build fast\n//go:build !fast\n\npackage p\n',
      source(Array.from({ length: 8 }, (_, i) => `(a${i} || b${i})`).join(' && ')),
      source('('.repeat(130) + 'fast' + ')'.repeat(130)),
      '// license '.repeat(2000) + '\npackage p\n',
    ]) {
      const constraint = goFileBuildConstraint('a.go', text);
      expect(constraint).toBeNull();
      expect(
        goBuildConstraintsMayOverlap(constraint, goFileBuildConstraint('b.go', source('!fast'))),
      ).toBe(true);
    }
  });
});
