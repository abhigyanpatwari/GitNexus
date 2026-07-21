import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CANONICAL_SKILLS = path.join(REPO_ROOT, '.claude', 'skills');

function readSkillFile(skill: 'gitnexus-plan' | 'gitnexus-work', relativePath: string): string {
  return readFileSync(path.join(CANONICAL_SKILLS, skill, relativePath), 'utf-8');
}

function expectConcepts(
  text: string,
  concepts: ReadonlyArray<readonly [description: string, pattern: RegExp]>,
): void {
  for (const [description, pattern] of concepts) {
    expect(text, description).toMatch(pattern);
  }
}

function section(text: string, startHeading: string, endHeading?: string): string {
  const start = text.indexOf(startHeading);
  if (start < 0) throw new Error(`Missing contract section: ${startHeading}`);
  const end = endHeading ? text.indexOf(endHeading, start + startHeading.length) : text.length;
  if (endHeading && end < 0) throw new Error(`Missing contract section: ${endHeading}`);
  return text.slice(start, end);
}

describe('gitnexus-plan evidence provenance contract', () => {
  const ledger = readSkillFile('gitnexus-plan', 'references/context-ledger.md');
  const pack = readSkillFile('gitnexus-plan', 'references/context-pack.md');
  const template = readSkillFile('gitnexus-plan', 'references/plan-template.md');
  const serializer = readSkillFile('gitnexus-plan', 'references/evidence-provenance.md');
  const ledgerProvenance = section(ledger, '## Evidence provenance', '## Reread rules');
  const packIntro = section(pack, '# Implementation context pack', '## Schema');
  const packSchema = section(pack, '## Schema', '## Must not contain');
  const packBounds = section(pack, '## Must not contain');
  const templateContract = section(template, '## Compact form');
  const provenanceContract = `${ledgerProvenance}\n${packSchema}\n${templateContract}`;

  it('makes provenance mandatory in compact and full packs', () => {
    expectConcepts(packIntro, [
      ['compact pack includes provenance', /Compact plans[\s\S]*evidence_provenance/i],
      ['provenance is mandatory in both forms', /evidence_provenance[\s\S]*mandatory[\s\S]*both/i],
    ]);
    expect(packSchema).toMatch(/implementation_context:[\s\S]*evidence_provenance:/i);
  });

  it('records a versioned global dirty digest and sorted cited-path manifest', () => {
    expectConcepts(provenanceContract, [
      ['versioned provenance schema', /evidence_provenance[\s\S]*schema_version/i],
      ['full pinned commit identity', /head_commit:[^\n]*full commit/i],
      ['whole-tree dirty-state digest', /global_dirty_digest/i],
      ['sorted cited-path manifest', /cited_path_manifest[\s\S]*sorted/i],
      ['filesystem object kind', /object_kind/i],
      ['HEAD layer digest', /head_digest/i],
      ['index layer digest', /index_digest/i],
      ['worktree layer digest', /worktree_digest/i],
      ['untracked layer digest', /untracked_digest/i],
      ['generated plan excluded from the digest', /generated plan[\s\S]*exclud/i],
    ]);
    expect(packBounds).toMatch(/digest only|only its canonical[\s\S]*global_dirty_digest/i);
    expect(packBounds).toMatch(/detailed entries[\s\S]*bounded to cited paths/i);
  });

  it('binds the emitted schema to one versioned portable serializer', () => {
    expect(packSchema.match(/canonicalization:/g) ?? []).toHaveLength(1);
    expect(packSchema).toMatch(
      /schema_version:\s*2[\s\S]*canonicalization:\s*['"]gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records['"]/,
    );
    expect(packSchema).toMatch(/sole normative emitted[\s\S]*executable serializer/i);
    expect(ledger).not.toMatch(/canonicalization:/);
    expect(ledgerProvenance).toMatch(
      /context-pack\.md[\s\S]*normative emitted field schema[\s\S]*do not redefine/i,
    );
    expectConcepts(serializer, [
      ['UTF-8 and NFC path contract', /valid UTF-8[\s\S]*Unicode[\s\S]*NFC/i],
      ['version and schema prefix', /gitnexus-evidence-provenance[\s\S]*schema_version[\s\S]*`2`/i],
      ['fixed field order', /fixed-order[\s\S]*head_kind[\s\S]*untracked_digest/i],
      ['NUL record framing', /NUL-framed[\s\S]*extra NUL/i],
      ['explicit absent literal', /literal `absent`/i],
      ['unsigned UTF-8 sorting', /unsigned lexicographic[\s\S]*UTF-8 bytes/i],
      ['rename endpoint expansion', /old endpoint[\s\S]*new endpoint[\s\S]*include both/i],
      ['exact plan exclusion', /one exact normalized path[\s\S]*No glob/i],
    ]);
  });

  it('defines descriptor-anchored plan reads and digest-bound durable Deepen writes', () => {
    expectConcepts(serializer, [
      [
        'read receipt carries canonical path, exact bytes, and digest',
        /read-plan[\s\S]*generated_plan_path[\s\S]*plan_bytes_base64[\s\S]*plan_digest/i,
      ],
      ['read rejects symlink parents and leaves', /read-plan[\s\S]*symlink[\s\S]*O_NOFOLLOW/i],
      [
        'Deepen requires the read receipt path and digest',
        /--replace[\s\S]*--expected-plan-path[\s\S]*--expected-plan-digest[\s\S]*same[\s\S]*receipt/i,
      ],
      [
        'preservation moves are directory durable',
        /preservation move[\s\S]*fsyncs both[\s\S]*source and destination directories/i,
      ],
      [
        'HEAD and index layers use captured anchors',
        /HEAD objects[\s\S]*captured[\s\S]*Index layers[\s\S]*captured/i,
      ],
      [
        'absent citations are descriptor guarded twice',
        /absent cited path[\s\S]*descriptor[\s\S]*checked both before and after/i,
      ],
      [
        'nonstandard trusted Python paths are supported',
        /Python may live in[\s\S]*Nix[\s\S]*absolute\s+PATH/i,
      ],
    ]);
  });

  it.each(['staged', 'unstaged', 'untracked', 'deleted', 'renamed', 'mixed', 'absent'])(
    'represents the %s cited-path state',
    (state) => {
      expect(provenanceContract).toMatch(new RegExp(`\\b${state}\\b`, 'i'));
    },
  );

  it('preserves both rename endpoints and canonical order', () => {
    expectConcepts(provenanceContract, [
      ['rename source endpoint', /rename_from/i],
      ['rename destination endpoint', /rename_to/i],
      ['canonical sorted records', /canonical[\s\S]*sorted|sorted[\s\S]*canonical/i],
    ]);
  });
});

describe('gitnexus-work dirty-state re-anchoring contract', () => {
  const work = readSkillFile('gitnexus-work', 'SKILL.md');
  const phase1 = section(work, '## Phase 1', '## Phase 2');

  it('recomputes both provenance layers even at the same HEAD', () => {
    expectConcepts(phase1, [
      [
        'same-HEAD recomputation',
        /same HEAD[\s\S]*recompute[\s\S]*global dirty digest[\s\S]*cited-path manifest/i,
      ],
      ['legacy provenance handling', /legacy[\s\S]*re-anchor/i],
      ['global mismatch handling', /global dirty digest[\s\S]*mismatch[\s\S]*re-anchor/i],
    ]);
    expect(phase1).not.toMatch(
      /HEAD equals the pin[\s\S]*skip all re-reading[\s\S]*go straight to work/i,
    );
  });

  it.each(['staged', 'unstaged', 'untracked', 'deleted', 'renamed', 'mixed'])(
    'detects %s cited-path drift',
    (state) => {
      expect(phase1).toMatch(new RegExp(`\\b${state}\\b`, 'i'));
    },
  );

  it('rereads changed citations and assesses new uncited dirty scope', () => {
    expectConcepts(phase1, [
      ['changed cited paths are reread', /changed cited paths?[\s\S]*re-read/i],
      ['new uncited dirtiness is assessed', /new uncited dirty paths?[\s\S]*assess/i],
      ['unreadable evidence blocks work', /unreadable[\s\S]*block/i],
      [
        'Deepen is reserved for invalidated planning decisions',
        /Deepen only if[\s\S]*scope[\s\S]*requirements?[\s\S]*(key technical decision|KTD)/i,
      ],
    ]);
  });

  it('binds provenance to the exact plan document that was loaded', () => {
    expectConcepts(phase1, [
      [
        'loaded plan uses the descriptor-anchored helper receipt',
        /descriptor-anchored[\s\S]*read-plan[\s\S]*plan_bytes_base64/i,
      ],
      [
        'loaded and recorded paths must match exactly',
        /byte-for-byte[\s\S]*read-plan receipt[\s\S]*evidence_provenance\.generated_plan_path/i,
      ],
    ]);
  });
});

describe('gitnexus-work build-current/index-current contract', () => {
  const work = readSkillFile('gitnexus-work', 'SKILL.md');
  const inputTriage = section(work, '## Input triage', '## Phase 1');
  const procedure = section(work, '### Build-current/index-current procedure', '## Phase 3');
  const phase3 = section(work, '## Phase 3', '## Phase 4');
  const phase4 = section(work, '## Phase 4', '## Never');

  it('defines one procedure and invokes it at every graph boundary', () => {
    expect(work.match(/^### Build-current\/index-current procedure$/gim) ?? []).toHaveLength(1);
    expectConcepts(`${inputTriage}\n${procedure}`, [
      ['procedure applies in direct mode', /direct mode[\s\S]*Build-current\/index-current/i],
    ]);
    expectConcepts(phase3, [
      [
        'procedure runs before every graph-dependent impact query',
        /Build-current\/index-current[\s\S]*immediately before every graph-dependent[\s\S]*impact/i,
      ],
    ]);
    expectConcepts(phase4, [
      [
        'procedure runs before final graph verification',
        /before final graph verification[\s\S]*Build-current\/index-current procedure/i,
      ],
    ]);
  });

  it('invalidates stale graph state and proves the analyzer identity', () => {
    expectConcepts(procedure, [
      [
        'committed and uncommitted relationship changes invalidate freshness',
        /relationship-affecting[\s\S]*committed[\s\S]*uncommitted[\s\S]*invalidat/i,
      ],
      ['indexed commit is compared', /index\.commit[\s\S]*current HEAD/i],
      [
        'typed persisted runner receipt is consumed',
        /index\.runner_identity[\s\S]*schemaVersion:\s*4[\s\S]*invoked-artifact[\s\S]*build[\s\S]*dependency-runtime[\s\S]*digest/i,
      ],
      [
        'schemas 1 through 3 are legacy',
        /schema-1,\s*schema-2, and schema-3 receipts[\s\S]*legacy/i,
      ],
      ['dependency canonicalization is current', /gitnexus-analyzer-dependency-runtime-v4/i],
      [
        'dependency package payload and native/parser runtime state is covered',
        /dependency-runtime digest[\s\S]*package metadata[\s\S]*JavaScript[\s\S]*native[\s\S]*parser artifacts/i,
      ],
      [
        'semantic status comparison excludes only the diagnostic entrypoint',
        /status --json[\s\S]*semantic field[\s\S]*excluding[\s\S]*invokedArtifact/i,
      ],
      [
        'status must report a current runner receipt',
        /runnerIdentityStatus:\s*current[\s\S]*incompleteReasons:\s*\[\][\s\S]*status:\s*up-to-date/i,
      ],
      ['MCP context must be complete', /index\.incomplete_reasons:\s*\[\]/i],
      [
        'stale or unknown receipts trigger a rebuild',
        /runner receipt[\s\S]*(stale|unknown)[\s\S]*build/i,
      ],
      ['current local analyzer is built', /npm run build/i],
      [
        'current local analyzer performs a PDG refresh',
        /node\s+[^\n]*dist\/cli\/index\.js\s+analyze\s+--index-only\s+--pdg/i,
      ],
      ['timestamps are only a conservative trigger', /timestamps?[\s\S]*trigger[\s\S]*not proof/i],
      [
        'refresh failure blocks graph-dependent work',
        /failure[\s\S]*blocks?[\s\S]*graph-dependent/i,
      ],
      ['inter-step relationship edits force another refresh', /inter-step[\s\S]*refresh/i],
      ['older runner fallback is forbidden', /do not fall back[\s\S]*older/i],
      [
        'legacy or unequal receipts force an actual metadata write',
        /--force[\s\S]*absent[\s\S]*malformed[\s\S]*unequal/i,
      ],
    ]);
  });
});

describe('gitnexus-plan read-only planning boundary', () => {
  const skill = readSkillFile('gitnexus-plan', 'SKILL.md');
  const readme = readSkillFile('gitnexus-plan', 'README.md');
  const planningDocs = `${skill}\n${readme}`;
  const feedback = section(skill, '## Skill feedback');

  it('never builds analyzer output or mutates implementation files', () => {
    expectConcepts(planningDocs, [
      ['dist builds are expressly forbidden', /must not build[\s\S]*dist\//i],
      ['source mutation is forbidden', /must not mutate[\s\S]*source/i],
      ['test mutation is forbidden', /must not mutate[\s\S]*tests?/i],
      ['configuration mutation is forbidden', /must not mutate[\s\S]*config/i],
    ]);
    expect(skill).not.toMatch(
      /when in doubt,? rebuild|permitted state changes[\s\S]*dist\/ rebuild/i,
    );
  });

  it('treats stale analyzer provenance as a source-weighted limitation', () => {
    expectConcepts(planningDocs, [
      ['stale analyzer provenance is disclosed', /stale analyzer[\s\S]*provenance/i],
      ['claims become source-weighted', /source-weighted limitation/i],
      ['feedback stays in chat', /feedback[\s\S]*chat-only/i],
    ]);
    expect(feedback).not.toMatch(/append one JSON line|learnings\.jsonl/i);
  });
});
