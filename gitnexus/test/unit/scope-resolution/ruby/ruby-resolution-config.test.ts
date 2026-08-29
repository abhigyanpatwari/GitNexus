import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveRubyImportTarget } from '../../../../src/core/ingestion/languages/ruby/import-target.js';
import { loadRubyResolutionConfig } from '../../../../src/core/ingestion/languages/ruby/resolution-config.js';
import { rubyScopeResolver } from '../../../../src/core/ingestion/languages/ruby/scope-resolver.js';

const temporaryRepos: string[] = [];

afterEach(() => {
  for (const repo of temporaryRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'gitnexus-ruby-dependencies-'));
  temporaryRepos.push(repo);
  return repo;
}

describe('Ruby dependency resolution config (#2966)', () => {
  it('loads literal Gemfile/gemspec dependencies and adjacent locked transitive gems', () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, 'Gemfile'),
      ["source 'https://rubygems.org'", "gem 'rails'", 'gem("pg")', "# gem 'commented'"].join('\n'),
    );
    writeFileSync(
      join(repo, 'Gemfile.lock'),
      ['GEM', '  specs:', '    actionpack (8.0.0)', '      rack (~> 3.0)', 'DEPENDENCIES'].join(
        '\n',
      ),
    );
    mkdirSync(join(repo, 'packages'));
    writeFileSync(
      join(repo, 'packages', 'widget.gemspec'),
      ["spec.add_dependency 'dry-types'", 'spec.add_development_dependency("rspec")'].join('\n'),
    );

    const config = loadRubyResolutionConfig(repo);

    expect(config?.gemNames).toEqual(new Set(['rails', 'pg', 'dry-types', 'rspec', 'actionpack']));
  });

  it('fails open when a lockfile exists without a Gemfile or gemspec', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'Gemfile.lock'), ['GEM', '  specs:', '    rails (8.0.0)'].join('\n'));

    expect(loadRubyResolutionConfig(repo)).toBeNull();
  });

  it('threads the config through the resolver without changing local bare or relative resolution', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'Gemfile'), ["gem 'rails'", "gem 'generators'"].join('\n'));
    const files = new Set([
      'lib/app/models/user.rb',
      'lib/generators.rb',
      'lib/rails/generators.rb',
      'lib/main.rb',
    ]);
    const config = await rubyScopeResolver.loadResolutionConfig?.(repo);

    expect(
      rubyScopeResolver.resolveImportTarget('rails/generators', 'lib/main.rb', files, config),
    ).toBeNull();
    expect(
      rubyScopeResolver.resolveImportTarget('app/models/user', 'lib/main.rb', files, config),
    ).toBe('lib/app/models/user.rb');
    expect(resolveRubyImportTarget('generators', 'lib/main.rb', files)).toBe('lib/generators.rb');
    expect(resolveRubyImportTarget('./generators', 'lib/main.rb', files, config)).toBe(
      'lib/generators.rb',
    );
  });
});
