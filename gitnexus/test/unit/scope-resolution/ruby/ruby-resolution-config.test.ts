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
  it('keeps manifest directories separate and records conventional require prefixes', () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, 'Gemfile'),
      ["source 'https://rubygems.org'", "gem 'rails'", 'gem("pg")', "# gem 'commented'"].join('\n'),
    );
    writeFileSync(
      join(repo, 'Gemfile.lock'),
      [
        'GEM',
        '  specs:',
        '    actionpack (8.0.0)',
        '      rack (~> 3.0)',
        '    rack (3.0.0)',
        'DEPENDENCIES',
      ].join('\n'),
    );
    mkdirSync(join(repo, 'packages', 'widget'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'widget', 'widget.gemspec'),
      [
        "spec.name = 'widget'",
        "spec.require_paths = ['src']",
        "spec.add_dependency 'dry-types'",
        'spec.add_development_dependency("rspec")',
      ].join('\n'),
    );

    const config = loadRubyResolutionConfig(repo);
    const root = config?.scopesByDirectory.get('');
    const widget = config?.scopesByDirectory.get('packages/widget');

    expect(root?.externalRequirePrefixes).toEqual(new Set(['rails', 'pg', 'actionpack', 'rack']));
    expect(widget?.externalRequirePrefixes).toEqual(new Set(['dry-types', 'dry/types', 'rspec']));
    expect(widget?.localLoadRootsByPrefix.get('widget')).toEqual(['packages/widget/src']);
  });

  it('fails open when a lockfile exists without a Gemfile or gemspec', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'Gemfile.lock'), ['GEM', '  specs:', '    rails (8.0.0)'].join('\n'));

    expect(loadRubyResolutionConfig(repo)).toBeNull();
  });

  it('gates external gems without changing local bare, relative, or no-config resolution', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'Gemfile'), "gem 'rails'\n");
    const files = new Set(['lib/app/models/user.rb', 'lib/generators.rb', 'lib/main.rb']);
    const config = await rubyScopeResolver.loadResolutionConfig?.(repo);

    expect(
      rubyScopeResolver.resolveImportTarget('rails/generators', 'lib/main.rb', files, config),
    ).toBeNull();
    expect(
      rubyScopeResolver.resolveImportTarget('app/models/user', 'lib/main.rb', files, config),
    ).toBe('lib/app/models/user.rb');
    expect(resolveRubyImportTarget('generators', 'lib/main.rb', files, config)).toBe(
      'lib/generators.rb',
    );
    expect(resolveRubyImportTarget('./generators', 'lib/main.rb', files, config)).toBe(
      'lib/generators.rb',
    );
    expect(resolveRubyImportTarget('rails/generators', 'lib/main.rb', files)).toBe(
      'lib/generators.rb',
    );
  });

  it('gates the conventional slash prefix of a hyphenated gem', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'Gemfile'), "gem 'dry-types'\n");
    const files = new Set(['lib/types.rb', 'lib/main.rb']);
    const config = loadRubyResolutionConfig(repo);

    expect(resolveRubyImportTarget('dry/types', 'lib/main.rb', files, config)).toBeNull();
    expect(resolveRubyImportTarget('dry-types', 'lib/main.rb', files, config)).toBeNull();
    expect(resolveRubyImportTarget('types', 'lib/main.rb', files, config)).toBe('lib/types.rb');
  });

  it('resolves a Gemfile path gem through its local load root', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'engines', 'my_engine'), { recursive: true });
    writeFileSync(join(repo, 'Gemfile'), "gem 'my_engine', path: 'engines/my_engine'\n");
    writeFileSync(
      join(repo, 'engines', 'my_engine', 'my_engine.gemspec'),
      ["spec.name = 'my_engine'", "spec.require_paths = ['lib']"].join('\n'),
    );
    const files = new Set([
      'engines/my_engine/lib/my_engine.rb',
      'lib/my_engine.rb',
      'lib/main.rb',
    ]);
    const config = loadRubyResolutionConfig(repo);

    expect(resolveRubyImportTarget('my_engine', 'lib/main.rb', files, config)).toBe(
      'engines/my_engine/lib/my_engine.rb',
    );
    expect(config?.scopesByDirectory.get('')?.externalRequirePrefixes).not.toContain('my_engine');
  });

  it('recognizes the Gemfile hashrocket path syntax as local', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'engines', 'my_engine'), { recursive: true });
    writeFileSync(join(repo, 'Gemfile'), "gem 'my_engine', :path => 'engines/my_engine'\n");
    writeFileSync(
      join(repo, 'engines', 'my_engine', 'my_engine.gemspec'),
      "spec.name = 'my_engine'\n",
    );
    const files = new Set(['engines/my_engine/lib/my_engine.rb', 'lib/main.rb']);
    const config = loadRubyResolutionConfig(repo);

    expect(resolveRubyImportTarget('my_engine', 'lib/main.rb', files, config)).toBe(
      'engines/my_engine/lib/my_engine.rb',
    );
    expect(config?.scopesByDirectory.get('')?.externalRequirePrefixes).not.toContain('my_engine');
  });

  it('keeps lockfile PATH specs local while gating GEM specs', () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, 'mygem.gemspec'),
      ["spec.name = 'mygem'", "spec.require_paths = ['lib']"].join('\n'),
    );
    writeFileSync(
      join(repo, 'Gemfile.lock'),
      [
        'PATH',
        '  remote: .',
        '  specs:',
        '    mygem (1.0.0)',
        '',
        'GEM',
        '  remote: https://rubygems.org/',
        '  specs:',
        '    rails (8.0.0)',
        '',
        'DEPENDENCIES',
        '  mygem!',
        '  rails',
      ].join('\n'),
    );
    const files = new Set(['lib/mygem.rb', 'lib/generators.rb', 'lib/main.rb']);
    const config = loadRubyResolutionConfig(repo);
    const root = config?.scopesByDirectory.get('');

    expect(resolveRubyImportTarget('mygem', 'lib/main.rb', files, config)).toBe('lib/mygem.rb');
    expect(resolveRubyImportTarget('rails/generators', 'lib/main.rb', files, config)).toBeNull();
    expect(root?.externalRequirePrefixes).toContain('rails');
    expect(root?.externalRequirePrefixes).not.toContain('mygem');
  });

  it('uses the nearest manifest instead of a repository-wide monorepo union', () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'packages', 'a'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'b'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'a', 'Gemfile'), "gem 'rails'\n");
    writeFileSync(join(repo, 'packages', 'b', 'Gemfile'), "source 'https://rubygems.org'\n");
    const files = new Set([
      'packages/a/lib/main.rb',
      'packages/b/lib/main.rb',
      'packages/b/lib/rails/generators.rb',
    ]);
    const config = loadRubyResolutionConfig(repo);

    expect(
      resolveRubyImportTarget('rails/generators', 'packages/a/lib/main.rb', files, config),
    ).toBeNull();
    expect(
      resolveRubyImportTarget('rails/generators', 'packages/b/lib/main.rb', files, config),
    ).toBe('packages/b/lib/rails/generators.rb');
  });
});
