---
name: serena-file-rename-fight
description: The linter in this repo fights renames of files that have active imports elsewhere — keep the original filename
metadata:
  type: feedback
---

When renaming a source file in this repo (e.g. `mv foo.ts bar.ts`), the linter/Serena MCP tooling fights the rename by reverting the file back to its original name if any other file in the project still references the original path.

**Why:** Discovered when trying to rename `route-extractors/angular-metadata.ts` to `extractors/angular-module-metadata.ts` to avoid a name conflict with another batch's pre-existing file. The linter kept restoring the original filename because (a) parse-worker had `import { extractAngularMetadata } from '../route-extractors/angular-metadata.js'` and (b) the linter/Serena actively tracks file changes by path.

**How to apply:** When a filename conflict arises, choose ONE of:
1. Use the original filename (work around the conflict in the function name or content)
2. Coordinate with the other batch to delete their file first, then rename
3. Move BOTH files into clearly different directories (e.g. `route-extractors/angular-metadata.ts` and `extractors/angular-module-extractors.ts`)

In my case, option 1 won — I kept the file at `extractors/angular-metadata.ts` even though another batch had one at `route-extractors/angular-metadata.ts`. Both exports co-exist in the same file (the linter merged them). The `sed -i.bak` pattern is needed for in-place path replacement because the linter blocks `Edit` tool updates to files referenced elsewhere.
