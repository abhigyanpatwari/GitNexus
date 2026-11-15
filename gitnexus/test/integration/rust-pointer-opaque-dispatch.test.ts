import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFixtureRepo, runPipelineFromRepo, getRelationships } from './resolvers/helpers.js';
const cases = [
  [
    'super inherent',
    'use std::rc::Rc;\nstruct User; impl User { fn save(&self) {} }\nmod ext { impl super::User { pub fn as_ref(&self) {} } }\nstruct Holder { repo: Rc<User> }\nimpl Holder { fn probe(&self) { self.repo.as_ref(); } }',
  ],
  [
    'crate inherent',
    'use std::rc::Rc;\nstruct User; impl User { fn save(&self) {} }\nmod ext { impl crate::User { pub fn as_ref(&self) {} } }\nstruct Holder { repo: Rc<User> }\nimpl Holder { fn probe(&self) { self.repo.as_ref(); } }',
  ],
  [
    'declined nested chain',
    'use std::rc::Rc;\nstruct User;impl User { fn as_ref(&self) {} }\nstruct Holder { repo: Rc<User> }\nstruct Outer { holder: Holder }\nfn probe(o: &Outer) { o.holder.repo.as_ref(); }',
  ],
  [
    'unresolved external trait',
    'use std::rc::Rc;\nuse external::Describe;\nstruct User; impl User { fn describe(&self) {} }\nstruct Holder { repo: Rc<User> }\nimpl Holder { fn probe(&self) { self.repo.describe(); } }',
  ],
  [
    'macro blanket trait',
    'use std::rc::Rc;\nmacro_rules! declare_describe { () => { trait Describe { fn describe(&self); } impl<T> Describe for T { fn describe(&self) {} } } }\ndeclare_describe!();\nstruct User; impl User { fn describe(&self) {} }\nstruct Holder { repo: Rc<User> }\nimpl Holder { fn probe(&self) { self.repo.describe(); } }',
  ],
] as const;
describe('Rust pointer fields with opaque dispatch evidence', () => {
  it.each(cases)(
    '%s does not invent pointee dispatch',
    async (_name, source) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pointer-synthesis-'));
      try {
        writeFixtureRepo(root, {
          'src/lib.rs':
            source +
            '\nstruct Unrelated; impl Unrelated { fn as_ref(&self) {} fn describe(&self) {} }',
        });
        const r = await runPipelineFromRepo(root, () => {});
        const edges = getRelationships(r, 'CALLS').filter((e) => e.source === 'probe');
        expect(edges.map((e) => e.rel.targetId)).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    180000,
  );
});
