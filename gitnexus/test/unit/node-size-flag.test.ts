import { describe, expect, it } from 'vitest';
import {
  processNodeBooleanFlag,
  processNodeSizeFlag,
  readNodeBooleanFlag,
  readNodeFlagValue,
  readNodeSizeFlag,
} from '../../src/lib/node-size-flag.js';

const OLD = 'max-old-space-size';

describe('readNodeSizeFlag', () => {
  it.each([
    ['an execArgv value', ['--max-old-space-size=3000'], 3000],
    ['the last repeated value', ['--max-old-space-size=1000', '--max-old-space-size=3000'], 3000],
    ['the underscore spelling', ['--max_old_space_size=2500'], 2500],
    ['a single leading dash', ['-max-old-space-size=2600'], 2600],
    ['a single dash and underscores', ['-max_old_space_size=2700'], 2700],
    ['a plus sign', ['--max-old-space-size=+2800'], 2800],
    ['leading whitespace', ['--max-old-space-size= \t2900'], 2900],
    ['leading zeros', ['--max-old-space-size=03000'], 3000],
    ['a negative zero', ['--max-old-space-size=-0'], 0],
    ['a separate value argument', ['--max-old-space-size', '1800'], 1800],
    ['an explicit zero', ['--max-old-space-size=0'], 0],
    ['no value before the next flag', ['--max-old-space-size', '--x'], undefined],
    ['a non-numeric value', ['--max-old-space-size=lots'], undefined],
    ['trailing text, which V8 rejects at startup', ['--max-old-space-size=3000 '], undefined],
    [
      'a negative value V8 ignores, keeping the earlier one',
      ['--max-old-space-size=3000', '--max-old-space-size=-5'],
      3000,
    ],
    [
      'an out-of-bounds value V8 ignores',
      ['--max-old-space-size=2000', '--max-old-space-size=100000000000000000000'],
      2000,
    ],
    ['a value V8 accepts beyond exact integers', ['--max-old-space-size=9007199254740993'], NaN],
    ['a short option, which is not a heap flag', ['-r', 'max-old-space-size=3000'], undefined],
    ['an eval argument', ['--eval', '--max-old-space-size=800'], undefined],
    ['a process title', ['--title', 'worker --max-old-space-size=2000'], undefined],
    ['an absent flag', ['--max-semi-space-size=64'], undefined],
    ['the percentage flag, a different flag', ['--max-old-space-size-percentage=25'], undefined],
  ])('reads %s', (_label, flags, expected) => {
    expect(readNodeSizeFlag(flags, OLD)).toBe(expected);
  });

  it.each([
    ['a quoted value', '--max-old-space-size="3000"', 3000],
    ['quotes inside a token', '--max-old-space-size="30"00', 3000],
    ['a fully quoted token', '"--max-old-space-size=2500" --x', 2500],
    ['a space-separated value', '--max-old-space-size 4096 --x', 4096],
    ['a quoted require path', '--require "module --max-old-space-size=800"', undefined],
    ['a quoted title', '--title "worker --max-old-space-size=2000"', undefined],
    ['an escaped quote', '--title "a\\" --max-old-space-size=900" --x', undefined],
    ['an empty quoted argument, which Node drops', '"" --max-old-space-size=700', 700],
  ])('splits NODE_OPTIONS like Node: %s', (_label, options, expected) => {
    expect(readNodeSizeFlag(options, OLD)).toBe(expected);
  });
});

describe('readNodeFlagValue', () => {
  it('reads an option value by argument, never from inside another argument', () => {
    const name = 'max-old-space-size-percentage';
    expect(readNodeFlagValue(['--max_old_space_size_percentage=12.5'], name)).toBe('12.5');
    expect(readNodeFlagValue('--max-old-space-size-percentage 25', name)).toBe('25');
    expect(readNodeFlagValue(['--eval', 'f("--max-old-space-size-percentage=50")'], name)).toBe(
      undefined,
    );
    expect(readNodeFlagValue(['--title', 'w --max-old-space-size-percentage=50'], name)).toBe(
      undefined,
    );
  });
});

describe('readNodeBooleanFlag', () => {
  it.each([
    [['--freeze-flags-after-init'], true],
    [['-freeze-flags-after-init'], true],
    [['--freeze_flags_after_init'], true],
    [['--freeze-flags-after-init', '--no-freeze-flags-after-init'], false],
    [['--freeze-flags-after-init', '--nofreeze-flags-after-init'], false],
    [['--freeze-flags-after-init', '--no_freeze_flags_after_init'], false],
    [['--freeze-flags-after-init', '-nofreeze-flags-after-init'], false],
    [['--no-freeze-flags-after-init', '-freeze-flags-after-init'], true],
    [['--freeze-flags-after-init-extra'], undefined],
    [['--eval', '--freeze-flags-after-init'], undefined],
    [[], undefined],
  ])('reads %j like V8', (flags, expected) => {
    expect(readNodeBooleanFlag(flags, 'freeze-flags-after-init')).toBe(expected);
  });
});

describe('process flags', () => {
  it('let the command line win over NODE_OPTIONS, even with an explicit zero', () => {
    expect(processNodeSizeFlag(OLD, ['--max-old-space-size=0'], '--max-old-space-size=800')).toBe(
      0,
    );
    expect(
      processNodeSizeFlag(
        'max-semi-space-size',
        ['--max-semi-space-size=0'],
        '--max-semi-space-size=64',
      ),
    ).toBe(0);
    expect(processNodeSizeFlag(OLD, [], '--max-old-space-size=800')).toBe(800);
    expect(processNodeSizeFlag(OLD, [], '')).toBeUndefined();
    expect(
      processNodeBooleanFlag(
        'freeze-flags-after-init',
        ['--no-freeze-flags-after-init'],
        '--freeze-flags-after-init',
      ),
    ).toBe(false);
    expect(processNodeBooleanFlag('freeze-flags-after-init', [], '--freeze-flags-after-init')).toBe(
      true,
    );
  });
});
