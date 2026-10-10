import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';

async function callsFor(
  source: string,
  targetSource = 'pub fn uniqueScopeHelper() {}\n',
  targetName = 'uniqueScopeHelper',
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-import-scope-'));
  try {
    writeFixtureRepo(dir, {
      'Cargo.toml': '[package]\nname = "scope-test"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': source,
      'src/target.rs': targetSource,
    });
    const result = await runPipelineFromRepo(dir, () => {});
    return getRelationships(result, 'CALLS').filter((edge) => edge.target === targetName);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe('Rust import scope through full ingestion', () => {
  it('respects a local type import when inferring a destructured receiver', async () => {
    const calls = await callsFor(
      `
mod target;
pub fn allowed(source: target::Container) {
    use crate::target::Container;
    let Container { item } = source;
    item.save();
}
pub fn denied(source: target::Container) {
    use crate::missing::Container;
    let Container { item } = source;
    item.save();
}
`,
      'pub struct User {}\nimpl User { pub fn save(&self) {} }\npub struct Container { pub item: User }\n',
      'save',
    );
    expect(calls.filter((edge) => edge.source === 'denied')).toEqual([]);
    expect(
      calls
        .filter((edge) => edge.source === 'allowed')
        .map((edge) => [edge.targetFilePath, edge.targetLabel, edge.target]),
    ).toEqual([['src/target.rs', 'Function', 'save']]);
  });

  it('does not fabricate receiver calls from an unresolved local factory or factory parameter', async () => {
    const calls = await callsFor(
      `
mod target;
use crate::target::make_user;
pub fn unresolved() {
    use crate::missing::make_user;
    let user = make_user();
    user.save();
    for entry in make_user() { entry.save(); }
}
pub fn parameter(make_user: F) {
    let user = make_user();
    user.save();
    for entry in make_user() { entry.save(); }
}
pub fn allowed() {
    for entry in make_user() { entry.save(); }
}
`,
      'pub struct User {}\nimpl User { pub fn save(&self) {} }\npub fn make_user() -> Vec<User> { vec![] }\n',
      'save',
    );
    expect(calls.filter((edge) => edge.source === 'unresolved')).toEqual([]);
    expect(calls.filter((edge) => edge.source === 'parameter')).toEqual([]);
    expect(
      calls.filter((edge) => edge.source === 'allowed').map((edge) => edge.targetFilePath),
    ).toEqual(['src/target.rs']);
  });

  it('keeps sibling local factories with equal type names attached to their own declarations', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-factory-scope-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml':
          '[package]\nname = "factory-scope-test"\nversion = "0.1.0"\nedition = "2021"\n',
        'src/lib.rs': `
mod left;
mod right;
pub fn use_left() { use crate::left::make; let item = make(); item.save(); }
pub fn use_right() { use crate::right::make; let item = make(); item.save(); }
pub fn iterate_left() { use crate::left::all; for item in all() { item.save(); } }
pub fn iterate_right() { use crate::right::all; for item in all() { item.save(); } }
`,
        'src/left.rs':
          'pub struct Item {}\nimpl Item { pub fn save(&self) {} }\npub fn make() -> Item { Item {} }\npub fn all() -> Vec<Item> { vec![] }\n',
        'src/right.rs':
          'pub struct Item {}\nimpl Item { pub fn save(&self) {} }\npub fn make() -> Item { Item {} }\npub fn all() -> Vec<Item> { vec![] }\n',
      });
      const result = await runPipelineFromRepo(dir, () => {});
      const calls = getRelationships(result, 'CALLS').filter((edge) => edge.target === 'save');
      for (const side of ['left', 'right']) {
        for (const prefix of ['use', 'iterate']) {
          expect(
            calls
              .filter((edge) => edge.source === `${prefix}_${side}`)
              .map((edge) => edge.targetFilePath),
          ).toEqual([`src/${side}.rs`]);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('preserves method calls on the result of a function-local imported factory', async () => {
    const calls = await callsFor(
      `
mod target;
pub fn allowed() {
    use crate::target::make_user;
    let user = make_user();
    user.save();
}
`,
      'pub struct User {}\nimpl User { pub fn save(&self) {} }\npub fn make_user() -> User { User {} }\n',
      'save',
    );
    expect(calls.filter((edge) => edge.source === 'allowed')).toHaveLength(1);
  });

  it('an import in one inline module cannot bind or authorize calls in its sibling', async () => {
    const calls = await callsFor(`
mod target;
mod importing {
    use crate::target::uniqueScopeHelper;
    pub fn allowed() { uniqueScopeHelper(); }
}
mod sibling {
    pub fn denied() { uniqueScopeHelper(); }
}
`);
    expect(calls.filter((edge) => edge.source === 'allowed')).toHaveLength(1);
    expect(calls.filter((edge) => edge.source === 'allowed')[0]!.rel.reason).toBe(
      'import-resolved',
    );
    expect(calls.filter((edge) => edge.source === 'denied')).toEqual([]);
  });

  it('function-local alias imports remain usable inside that function, not its sibling', async () => {
    const calls = await callsFor(`
mod target;
pub fn allowed() {
    use crate::target::uniqueScopeHelper as localHelper;
    localHelper();
}
pub fn denied() { localHelper(); }
`);
    expect(calls.filter((edge) => edge.source === 'allowed')).toHaveLength(1);
    expect(calls.filter((edge) => edge.source === 'denied')).toEqual([]);
  });
});
