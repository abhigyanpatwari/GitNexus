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
