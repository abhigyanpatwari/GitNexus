import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFixtureRepo, runPipelineFromRepo, getRelationships } from './resolvers/helpers.js';
const cases = [
  ['dependency macro', 'ext::declare_describe!();', false],
  ['macro-use dependency', '#[macro_use] extern crate ext; declare_describe!();', false],
  ['attribute macro', '#[ext::declare_describe] struct Marker;', false],
  ['derive macro', '#[derive(ext::Describe)] struct Marker;', false],
  ['include-generated items', 'include!("generated.rs");', false],
  [
    'nested dependency macro',
    'fn seed(){ println!("{}", { ext::declare_describe!(); 0 }); }',
    false,
  ],
  ['standard derive', '#[derive(Clone)] struct Marker;', true],
  ['standard macro expression', 'fn seed(){ println!("seed"); }', true],
] as const;
it.each(cases)(
  '%s keeps expansion-sensitive pointer ownership',
  async (_name, prefix, positive) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pointer-expansion-'));
    try {
      writeFixtureRepo(root, {
        'src/lib.rs': `use std::rc::Rc;
trait Describe { fn describe(&self); }
${prefix}
struct User; impl User { fn describe(&self) {} }
struct Other; impl Other { fn describe(&self) {} }
struct Holder { repo: Rc<User> }
fn probe(h: &Holder) { h.repo.describe(); }
`,
      });
      const r = await runPipelineFromRepo(root, () => {});
      const targets = getRelationships(r, 'CALLS')
        .filter((e) => e.source === 'probe')
        .map((e) => e.rel.targetId);
      expect(targets).toEqual(positive ? ['Function:src/lib.rs:User.describe#0'] : []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
