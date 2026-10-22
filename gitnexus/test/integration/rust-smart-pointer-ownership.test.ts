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
    ['custom Box', 'custom::Box<User>', custom('Box'), false],
    ['custom Rc', 'custom::Rc<User>', custom('Rc'), false],
    ['custom Arc', 'custom::Arc<User>', custom('Arc'), false],
    ['shadowed prelude Box', 'Box<User>', localBox, false],
    ['foreign imported Rc', 'Rc<User>', 'use foreign::Rc;', false],
    ['nested custom Box', 'std::boxed::Box<custom::Box<User>>', custom('Box'), false],
    ['std qualified Box', 'std::boxed::Box<User>', '', true],
    ['std qualified Rc', 'std::rc::Rc<User>', '', true],
    ['std qualified Arc', 'std::sync::Arc<User>', '', true],
    ['prelude Box', 'Box<User>', '', true],
    ['imported standard Rc', 'Rc<User>', 'use std::rc::Rc;', true],
    ['imported standard Arc', 'Arc<User>', 'use std::sync::Arc;', true],
  ] as const)(
    '%s',
    async (_label, type, declaration, transparent) => {
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
        expect(targets.filter((target) => /User\.save#/.test(target))).toHaveLength(
          transparent ? 1 : 0,
        );
        // A same-file wrapper keeps its own method rather than losing the call.
        if (declaration === localBox) expect(targets).toEqual(['Function:src/lib.rs:Box.save#0']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );
});
