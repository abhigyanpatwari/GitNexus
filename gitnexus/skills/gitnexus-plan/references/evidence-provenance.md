# Evidence provenance serializer v2 and safe plan writer

This file is the normative byte contract for `evidence_provenance` schema 2.
The adjacent `scripts/evidence-provenance.mjs` is its executable definition.
`gitnexus-plan` and `gitnexus-work` carry byte-identical copies so either skill
can produce the same snapshot without relying on the other skill's install.
It is also the only supported write boundary for a generated plan. Never
recreate the digest with an ad-hoc shell pipeline or write the plan destination
directly.

## Invocation

From the target repository root, run the helper belonging to the active skill:

```bash
node <skill-dir>/scripts/evidence-provenance.mjs read-plan \
  --repo "$PWD" \
  --generated-plan docs/plans/YYYY-MM-DD-gitnexus-plan-example-change-plan.md
```

`read-plan` is the only supported way to load an existing plan for Deepen or
execution. It emits a JSON receipt with the canonical `generated_plan_path`,
`bytes_read`, exact `plan_bytes_base64`, and `plan_digest` (`sha256:<hex>`).
Decode and consume those exact bytes; do not reopen the lexical path. Retain
the canonical path and digest together for the complete Deepen session; a
receipt for one path never authorizes another, even when their bytes match.

```bash
node <skill-dir>/scripts/evidence-provenance.mjs snapshot \
  --repo "$PWD" \
  --schema-version 2 \
  --generated-plan docs/plans/YYYY-MM-DD-gitnexus-plan-example-change-plan.md \
  --cited src/one.ts \
  --cited test/one.test.ts
```

Pass one `--cited` argument for every cited path. The helper emits the complete
JSON value for `evidence_provenance`; copy that value without rewriting fields.
`gitnexus-work` passes the plan's `schema_version`, `generated_plan_path`, and
every path in `cited_path_manifest`. Schema 1 is legacy and deliberately
rejected, so the executor must conservatively re-anchor it under schema 2.

After the snapshot is in the fully composed document, publish its exact UTF-8
bytes through the same helper:

```bash
node <skill-dir>/scripts/evidence-provenance.mjs write-plan \
  --repo "$PWD" \
  --generated-plan docs/plans/YYYY-MM-DD-gitnexus-plan-example-change-plan.md \
  < /path/to/outside-repo-scratch-plan.md
```

For Deepen only:

```bash
node <skill-dir>/scripts/evidence-provenance.mjs write-plan \
  --repo "$PWD" \
  --generated-plan docs/plans/YYYY-MM-DD-gitnexus-plan-example-change-plan.md \
  --replace \
  --expected-plan-path docs/plans/YYYY-MM-DD-gitnexus-plan-example-change-plan.md \
  --expected-plan-digest 'sha256:<digest-from-read-plan>' \
  < /path/to/outside-repo-scratch-plan.md
```

Initial planning never passes `--replace`; an existing destination is an
error. Deepen mode rewrites the same path by adding `--replace`,
`--expected-plan-path <generated_plan_path-from-read-plan>`, and
`--expected-plan-digest <plan_digest-from-that-same-receipt>`. Standard input must be
valid UTF-8 and at most 16 MiB. A successful write prints a JSON receipt with
the normalized `generated_plan_path` and `bytes_written`. A successful Deepen
write also returns `prior_plan_backup_git_path`, a durable Git-admin path for
the displaced plan. The CLI rejects every option that does not apply to its
selected command; the direct API likewise requires literal booleans and exact
digest strings rather than truthy coercion.

## Path contract

Every Git path and CLI path must be valid UTF-8, already normalized to Unicode
NFC, and a nonempty POSIX repo-relative path. NUL, backslash, absolute/drive
paths, empty components, and `.` or `..` components are rejected. The helper
does not silently repair or alias them. Invalid UTF-8 from Git, non-NFC names,
unmerged index stages, unsupported Git modes, sockets/devices/FIFOs, unreadable
objects, symlink traversal in a parent path component, or a repository mutation
observed during the snapshot fail closed.

The generated-plan path is always repo-relative under schema 2. Snapshot
exclusion and writing require exactly
`docs/plans/YYYY-MM-DD-gitnexus-plan-<3-5-word-kebab-slug>.md`, including a
valid calendar date; they cannot target `.git`, source, configuration, or an
arbitrary repo file. For compatibility with documented and legacy plans,
`read-plan` accepts normalized files matching `docs/plans/*gitnexus-plan*.md`,
while retaining the same descriptor-anchored containment checks. That read
compatibility does not widen the writer. External output has no schema-2
representation. The snapshot exclusion is one exact normalized path
comparison. No glob, directory, basename, or `docs/plans/`-wide exclusion is
permitted. If the exact path is a rename endpoint, only that endpoint record is
excluded.

## Safe existing-plan read contract

`read-plan` fails closed unless Linux `/proc/self/fd`, `O_DIRECTORY`, and
`O_NOFOLLOW` are available. It resolves the exact Git top-level, opens the
repository root and every plan parent as held no-follow directory descriptors,
rejects missing, symlink, non-directory, and escaping parents, and opens the
leaf with `O_NOFOLLOW`. It reads at most 16 MiB from that held file descriptor,
requires valid UTF-8, hashes the exact bytes, then proves both the parent chain
and lexical leaf still name the same held objects before returning its receipt.
Neither Deepen nor work may parse bytes obtained before or outside this receipt.

## Safe generated-plan write contract

The writer fails closed unless Linux `/proc/self/fd`, `O_DIRECTORY`,
`O_NOFOLLOW`, and Python 3 with libc `renameat2(RENAME_NOREPLACE)` support are
available. Python may live in `/usr/local`, a Nix profile, or another absolute
PATH directory, but the helper accepts only a resolved executable and
containing directory owned by root or the current user and not writable by
group/other. The resolved executable is opened without following links and
invoked through that held descriptor. Relative PATH entries are ignored. The plan parent and the
repository's Git-admin directory must also share a filesystem. It resolves
the target repository's exact Git top-level, opens that root and every
destination parent as held no-follow directory descriptors, creates missing
parents relative to those descriptors, and proves the descriptor and lexical
chains still identify the same directories at the write boundary. A symlink
or non-directory parent, an escaping resolved path, a symlink/non-regular final
target, or a parent swap is an error.

The writer creates a random exclusive temporary file relative to the held final
parent descriptor and keeps its no-follow descriptor open. It writes and
flushes the bytes, binds the temporary name to the opened inode, and hashes the
open file before publication. Immediately before publication it revalidates
the parent and the temporary path, inode, size, and digest. Publication uses an
atomic no-replace move relative to the held directory descriptor. Initial mode
therefore cannot overwrite a destination that appears after the absent check.
The writer then flushes the directory and revalidates the committed path by
opening it with `O_NOFOLLOW`, hashing both the original temporary fd and the
path-bound fd, and performing a second descriptor-anchored path identity check
after hashing. A detected mutation or replacement aborts instead of accepting
mixed-era output.

`--replace` accepts only a pre-existing regular file and is reserved for
Deepen; without it, accidental overwrite is rejected. It also requires the
exact canonical `generated_plan_path` and `plan_digest` from the same session's
`read-plan` receipt. The expected path must exactly equal the write
destination, so identical bytes from one plan cannot authorize another plan.
Immediately before
preservation, the writer hashes the still-held prior-plan fd and rejects any
digest, inode, or path mismatch, including same-inode edits and changes between
read and write. It then atomically moves the current destination without
replacement to a random `gitnexus-plan-backups/` file under the resolved
Git-admin directory and verifies the moved inode and digest against that held
fd. Only then does it publish the new plan with the same atomic no-replace
primitive. A destination that reappears at either boundary is left untouched.

Every newly created plan or vault directory is fsynced and then fsynced into
its containing directory. Every cross-directory preservation move fsyncs both
its source and destination directories before success or a recovery path is
reported. After temporary bytes exist, a failed publication or verification preserves
every available prior, displaced, unpublished, or intended plan in that
Git-admin vault before reporting failure. Each reported recovery is reopened
from a freshly resolved Git root and verified before the error names it as
`git-path:gitnexus-plan-backups/<random-name>`. Resolve that value with
`git rev-parse --git-path gitnexus-plan-backups/<random-name>`; never interpret
it as a repo-relative working-tree path. This remains valid if the held plan
parent was renamed after publication. The writer never reports recovery
through a stale lexical parent and never performs an identity-check-then-unlink
rollback that could delete a racer's replacement. Read-only or unsupported
checkouts produce a blocking error. Callers must not bypass the helper,
redirect to an external path, or weaken these checks.

## Canonical bytes

The `global_dirty_digest.value` is lowercase SHA-256 (without a `sha256:`
prefix) over this byte stream. All textual values are their exact UTF-8 bytes.
`NUL` below is one `0x00` byte.

1. Prefix fields, each followed by NUL, then one additional NUL:
   `gitnexus-evidence-provenance`, `schema_version`, `2`.
2. Zero or more records sorted by unsigned lexicographic comparison of the
   normalized path's UTF-8 bytes. Locale and filesystem order are forbidden.
3. Each record is `record` + NUL, then the following fixed-order sequence of
   `field-name` + NUL + `field-value` + NUL pairs, then one additional NUL:
   `path`, `state`, `head_kind`, `index_kind`, `worktree_kind`,
   `untracked_kind`, `rename_from`, `rename_to`, `head_digest`,
   `index_digest`, `worktree_digest`, `untracked_digest`.
4. The literal `absent` represents every unavailable rename endpoint, object
   kind, and layer digest in canonical bytes. It is never an empty string.

The schema's canonicalization literal is exactly
`gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records`. The fixed field
count plus the extra NUL after prefix/record makes framing unambiguous; values
cannot contain NUL. Duplicate normalized paths are rejected.

## Records, renames, and states

The raw dirty set comes from Git porcelain v2 with NUL termination, all
untracked files, submodule inspection enabled, a fixed 50% rename threshold,
and both `diff.renameLimit=0` and `status.renameLimit=0`, so repository config
cannot cap rename candidates. Raw porcelain facts that share a path are merged
into one canonical record. A rename contributes two endpoint facts:

- old endpoint: `path=<old>`, `rename_from=absent`, `rename_to=<new>`;
- new endpoint: `path=<new>`, `rename_from=<old>`, `rename_to=absent`.

Both normally have state `renamed`; record sorting, not old/new role,
determines order. A worktree-dirty rename destination or any endpoint that also
has another fact is `mixed`, with rename metadata retained. When either endpoint
is cited, the cited manifest expands to include both.

Ordinary `XY` status maps to `mixed` when index and worktree columns are both
dirty, otherwise `deleted` for a deletion, `staged` for index-only change, and
`unstaged` for worktree-only change. `?` is `untracked`. Multiple distinct
facts for the same path become `mixed`; a staged deletion plus a recreated file
therefore retains HEAD/index facts while the filesystem object is recorded in
the untracked layer. `? child/` is Git's embedded-directory marker: the trailing
slash is removed before path normalization and `child` is materialized as one
bounded directory object. A cited path outside the dirty set is `clean`,
`untracked` when it exists only outside Git layers, or `absent` when no layer
exists.

## Object and digest rules

Every present layer digest is `sha256:<lowercase-hex>`:

- HEAD regular/symlink: SHA-256 of the exact Git blob bytes. HEAD directory:
  SHA-256 of the exact raw Git tree bytes. HEAD gitlink: SHA-256 of the ASCII
  object ID stored by the tree.
- Index regular/symlink: SHA-256 of the stage-0 Git blob bytes. Index gitlink:
  SHA-256 of its ASCII object ID. The index has no directory layer. Any
  non-stage-0 entry is rejected.
- Tracked worktree regular: raw file bytes, opened without following symlinks.
  Symlink: raw link-target bytes. Gitlink: ASCII object ID at the checked-out
  nested HEAD, but only after `rev-parse --show-toplevel` proves that the
  directory itself is the nested repository root, `HEAD` resolves there, and
  porcelain v2 reports no staged, unstaged, untracked, or ignored nested changes. The
  same root, HEAD, and clean-status proof is repeated by the mutation guard. A
  dirty, empty, uninitialized, or parent-falling-through gitlink fails closed.
  Directory: the v1 directory stream described below.
- A path absent from both HEAD and index places the filesystem object in the
  `untracked` layer and marks `worktree` absent. A Git-backed path places it in
  `worktree` and marks `untracked` absent. A missing layer uses literal
  `absent` for both kind and digest; an empty file is the SHA-256 of zero bytes.

Filesystem directory bytes use prefix fields
`gitnexus-evidence-directory`, `schema_version`, `1`, the same NUL framing,
and recursive entries sorted by unsigned UTF-8 relative-path bytes. Each entry
has fixed fields `path`, `kind`, `digest`. A single bottom-up filesystem walk
visits each node once and returns each child digest plus the flattened subtree
needed to preserve those canonical bytes; links are never followed. When the
directory is proven to be an exact nested Git top-level, only its administrative
`.git` entry is excluded. Every other child, including working files and nested
directories, remains evidence.

Each directory object is bounded to 10,000 visited entries, depth 256, and 256
MiB of regular-file content. Exceeding a bound fails closed. These bounds apply
independently to each top-level directory object materialized by a record.

HEAD objects are read only from the full object ID captured at snapshot start;
the symbolic `HEAD` name is never re-resolved for layers. Index layers are
parsed from one captured stage-0 listing. The helper guards the corresponding
HEAD/ref/reflog controls and raw index file, compares the captured listing at
the end, and rejects ordinary A-to-B-to-A mutations instead of accepting
mixed-era layers.

Regular files are read through an `O_NOFOLLOW` descriptor with before/after
identity checks. Symlinks use lstat/readlink/lstat; directories record identity
before and after their inventory. The helper also compares raw porcelain-v2
status and HEAD at the start and end, then rechecks filesystem guards. An
absent cited path holds a no-follow descriptor for the nearest existing parent
and records the first missing component or leaf; that anchored absence is
checked both before and after the final Git status pass, so a newly created
ignored path cannot evade porcelain. Any observed race rejects the snapshot
rather than emitting mixed-era evidence.
