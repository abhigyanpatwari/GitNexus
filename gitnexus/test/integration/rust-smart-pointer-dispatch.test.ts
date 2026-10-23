import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './resolvers/helpers.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

async function analyze(files: Record<string, string>): Promise<PipelineResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-pointer-dispatch-'));
  roots.push(root);
  writeFixtureRepo(root, files);
  return runPipelineFromRepo(root, () => {}, {});
}

describe('pointer and pointee member ownership', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await analyze({
      'main.rs': `use std::rc::Rc;
use std::sync::Arc;
struct User;
impl User { fn as_ref(&self) {} fn save(&self) {} }
struct SafeUser;
impl SafeUser { fn save(&self) {} }
struct Holder {
  boxed: Box<User>, rc: Rc<User>, arc: Arc<User>,
  safe_boxed: Box<SafeUser>, safe_rc: Rc<SafeUser>, safe_arc: Arc<SafeUser>
}
fn boxed_builtin(h: &Holder) { h.boxed.as_ref(); }
fn rc_builtin(h: &Holder) { h.rc.as_ref(); }
fn arc_builtin(h: &Holder) { h.arc.as_ref(); }
fn boxed_target(h: &Holder) { h.boxed.save(); }
fn rc_target(h: &Holder) { h.rc.save(); }
fn arc_target(h: &Holder) { h.arc.save(); }
fn safe_boxed(h: &Holder) { h.safe_boxed.save(); }
fn safe_rc(h: &Holder) { h.safe_rc.save(); }
fn safe_arc(h: &Holder) { h.safe_arc.save(); }
`,
    });
  }, 120000);

  it.each(['boxed_builtin', 'rc_builtin', 'arc_builtin'])(
    '%s never substitutes User.as_ref for a pointer method',
    (name) => {
      expect(getRelationships(result, 'CALLS').filter((e) => e.source === name)).toEqual([]);
    },
  );
  it.each(['boxed_target', 'rc_target', 'arc_target'])(
    '%s conservatively leaves other methods unresolved on a conflicted field',
    (name) => {
      // save() is legal Rust. Whole-field refusal deliberately loses this edge
      // until dispatch can represent ordered autoderef for individual members.
      expect(getRelationships(result, 'CALLS').filter((e) => e.source === name)).toEqual([]);
    },
  );
  it.each(['safe_boxed', 'safe_rc', 'safe_arc'])(
    '%s still resolves an unconflicted pointee method',
    (name) => {
      expect(
        getRelationships(result, 'CALLS')
          .filter((e) => e.source === name && e.target === 'save')
          .map((e) => e.rel.targetId),
      ).toEqual(['Function:main.rs:SafeUser.save#0']);
    },
  );
});

describe('pointer declaration ownership', () => {
  it('does not replace a qualified pointee with a local namesake', async () => {
    const result = await analyze({
      'src/lib.rs': `mod remote;
struct User;
impl User { fn save(&self) {} }
struct Holder { repo: Box<remote::User> }
impl Holder {
  fn direct(&self) { self.repo.save(); }
  fn assigned(&self) { let value = self.repo; value.save(); }
}
fn destructured(h: Holder) { let Holder { repo } = h; repo.save(); }
`,
      'src/remote.rs': 'pub struct User; impl User { pub fn save(&self) {} }',
    });
    for (const name of ['direct', 'assigned', 'destructured']) {
      expect(
        getRelationships(result, 'CALLS').filter(
          (e) => e.source === name && e.target === 'save' && e.targetFilePath === 'src/lib.rs',
        ),
      ).toEqual([]);
    }
  }, 120000);

  it.each([
    ['standard crate', '', true],
    [
      'crate alias',
      `#![no_std]
extern crate self as std;
pub mod boxed {
  pub struct Box<T> { pub value: T }
  impl<T> Box<T> { pub fn save(&self) {} }
}
`,
      false,
    ],
  ] as const)(
    '%s respects absolute wrapper ownership',
    async (_name, prefix, standard) => {
      const result = await analyze({
        'src/lib.rs': `${prefix}
struct User;
impl User { fn save(&self) {} }
struct Holder { repo: ::std::boxed::Box<User> }
impl Holder { fn direct(&self) { self.repo.save(); } }
`,
      });
      const calls = getRelationships(result, 'CALLS').filter(
        (e) => e.source === 'direct' && e.rel.targetId === 'Function:src/lib.rs:User.save#0',
      );
      expect(calls).toHaveLength(standard ? 1 : 0);
    },
    120000,
  );

  it.each(['Rc<User>', '&Rc<User>'])(
    'does not bypass a local trait implementation on %s',
    async (receiver) => {
      const result = await analyze({
        'main.rs': `use std::rc::Rc;
trait Save { fn save(&self); }
struct User;
impl User { fn save(&self) {} }
impl Save for ${receiver} { fn save(&self) {} }
struct Holder { repo: Rc<User> }
fn probe(h: &Holder) { h.repo.save(); }
`,
      });
      expect(
        getRelationships(result, 'CALLS').filter(
          (e) => e.source === 'probe' && e.rel.targetId === 'Function:main.rs:User.save#0',
        ),
      ).toEqual([]);
    },
    120000,
  );
});
