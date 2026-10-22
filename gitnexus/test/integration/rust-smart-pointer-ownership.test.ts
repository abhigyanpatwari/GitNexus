import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';
const custom = (name: string) =>
  `mod custom { pub struct ${name}<T> { pub value:T } impl<T> ${name}<T> { pub fn save(&self) {} } }`;
const localBox = `struct Box<T> { value:T } impl<T> Box<T> { fn save(&self) {} }`;
describe('Rust field pointer ownership', () => {
  it.each([
    ['custom Box', 'custom::Box<User>', custom('Box'), ['Function:src/lib.rs:custom.Box.save#0']],
    ['custom Rc', 'custom::Rc<User>', custom('Rc'), ['Function:src/lib.rs:custom.Rc.save#0']],
    ['custom Arc', 'custom::Arc<User>', custom('Arc'), ['Function:src/lib.rs:custom.Arc.save#0']],
    ['shadowed prelude Box', 'Box<User>', localBox, ['Function:src/lib.rs:Box.save#0']],
    ['foreign imported Rc', 'Rc<User>', 'use foreign::Rc;', []],
    ['nested custom Box', 'std::boxed::Box<custom::Box<User>>', custom('Box'), []],
    ['std qualified Box', 'std::boxed::Box<User>', '', ['Function:src/lib.rs:User.save#0']],
    ['std qualified Rc', 'std::rc::Rc<User>', '', ['Function:src/lib.rs:User.save#0']],
    ['std qualified Arc', 'std::sync::Arc<User>', '', ['Function:src/lib.rs:User.save#0']],
    ['prelude Box', 'Box<User>', '', ['Function:src/lib.rs:User.save#0']],
    ['imported standard Rc', 'Rc<User>', 'use std::rc::Rc;', ['Function:src/lib.rs:User.save#0']],
    [
      'imported standard Arc',
      'Arc<User>',
      'use std::sync::Arc;',
      ['Function:src/lib.rs:User.save#0'],
    ],
  ] as const)(
    '%s',
    async (_label, type, declaration, expectedTargets) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-pointer-'));
      try {
        writeFixtureRepo(root, {
          'Cargo.toml': '[package]\nname="pointer_probe"\nversion="0.1.0"\nedition="2021"\n',
          'src/lib.rs': `${declaration}
struct User; impl User { fn save(&self) {} }
struct Decoy; impl Decoy { fn save(&self) {} }
struct Host { repo: ${type} }
impl Host { fn probe(&self) { self.repo.save(); } }
`,
        });
        const result = await runPipelineFromRepo(root, () => {}, {});
        const targets = getRelationships(result, 'CALLS')
          .filter((e) => e.source === 'probe')
          .map((e) => e.rel.targetId);
        expect(targets).toEqual(expectedTargets);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );
});
