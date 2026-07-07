/**
 * Locks the `--shard=<index>/<total>` resolution used by the CI cross-platform
 * runner (scripts/shard-arg.ts). A regression here silently changes whether the
 * platform-sensitive suite shards at all — worth a direct, env-free unit test.
 */
import { describe, it, expect } from 'vitest';
import { parseShardArg } from '../../scripts/shard-arg.js';

describe('parseShardArg', () => {
  it('returns undefined when no --shard arg is present (unsharded run)', () => {
    expect(parseShardArg(['run', '--reporter=dot'])).toBeUndefined();
  });

  it('returns the matched --shard token when present', () => {
    expect(parseShardArg(['--shard=1/3'])).toBe('--shard=1/3');
  });

  it('finds the --shard token amid other args', () => {
    expect(parseShardArg(['--reporter=dot', '--shard=2/2', '--bail'])).toBe('--shard=2/2');
  });

  it('throws on a malformed --shard arg (missing /total)', () => {
    expect(() => parseShardArg(['--shard=1'])).toThrow(/Malformed --shard/);
  });

  it('throws on a bare --shard with no value', () => {
    expect(() => parseShardArg(['--shard'])).toThrow(/Malformed --shard/);
  });

  it('throws on a non-numeric --shard value', () => {
    expect(() => parseShardArg(['--shard=abc'])).toThrow(/Malformed --shard/);
  });

  it('ignores flags that merely start with --shard (e.g. --shardx=)', () => {
    expect(parseShardArg(['--shardx=1/2'])).toBeUndefined();
  });
});
