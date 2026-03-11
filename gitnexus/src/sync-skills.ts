/**
 * Skill File Synchronization
 *
 * Pure function `planSync` reads canonical skill files from `gitnexus/skills/`
 * and plans write operations for derived targets (.claude, plugin, cursor).
 *
 * See docs/skill-sync.md for the full specification.
 */

export interface SyncTarget {
  name: string;
  dir: string;
  skills: string[];
  stripFrontmatter: boolean;
  generatedHeader: boolean;
}

export interface SyncOperation {
  targetPath: string;
  content: string;
  action: 'write' | 'skip';
}

/**
 * Strip leading YAML frontmatter from markdown content.
 * Only removes the block if the content starts with `---\n` and a second `---\n` is found.
 */
function stripYamlFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content;
  const endIndex = content.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    // Unclosed frontmatter — treat entire content as body (graceful handling)
    return content;
  }
  return content.slice(endIndex + 5); // skip past the closing `---\n`
}

/**
 * Normalize trailing whitespace: ensure content ends with exactly one `\n`.
 */
function normalizeTrailingNewline(content: string): string {
  return content.trimEnd() + '\n';
}

/**
 * Plan synchronization operations from canonical source skills to derived targets.
 *
 * @param sourceDir - Directory containing canonical `gitnexus-*.md` skill files
 * @param targets - Array of sync targets with allowlists and transformation options
 * @param readFile - Async function to read a file's content (injectable for testing)
 * @param listDir - Async function to list directory entries (injectable for testing)
 * @returns Array of planned write/skip operations
 */
export async function planSync(
  sourceDir: string,
  targets: SyncTarget[],
  readFile: (path: string) => Promise<string>,
  listDir: (dir: string) => Promise<string[]>,
): Promise<SyncOperation[]> {
  // Validate targets
  for (const target of targets) {
    if (!Array.isArray(target.skills)) {
      throw new Error(
        `Target "${target.name}": skills must be an array, got ${typeof target.skills}`,
      );
    }
  }

  // Discover source skill files
  const entries = await listDir(sourceDir);
  const skillFiles = entries.filter(e => e.startsWith('gitnexus-') && e.endsWith('.md'));

  // Build a set of available skill names
  const availableSkills = new Set(skillFiles.map(f => f.replace(/\.md$/, '')));

  // Empty source directory — nothing to sync
  if (availableSkills.size === 0) return [];

  const operations: SyncOperation[] = [];

  for (const target of targets) {
    // Deduplicate the allowlist
    const uniqueSkills = [...new Set(target.skills)];

    // Validate all requested skills exist in source
    for (const skill of uniqueSkills) {
      if (!availableSkills.has(skill)) {
        throw new Error(
          `Target "${target.name}": skill "${skill}" is in the allowlist but not found in source directory "${sourceDir}"`,
        );
      }
    }

    for (const skill of uniqueSkills) {
      const sourcePath = `${sourceDir}/${skill}.md`;
      let content: string;

      try {
        content = await readFile(sourcePath);
      } catch (err: any) {
        throw new Error(
          `Failed to read skill "${skill}" from "${sourcePath}": ${err.message}`,
        );
      }

      // Apply transformations
      if (target.stripFrontmatter) {
        content = stripYamlFrontmatter(content);
      }

      // Normalize trailing whitespace
      content = normalizeTrailingNewline(content);

      // Prepend generated header if configured
      if (target.generatedHeader) {
        const header = `<!-- AUTO-GENERATED FROM gitnexus/skills/${skill}.md — DO NOT EDIT -->\n`;
        content = header + content;
      }

      // Determine target path
      const targetPath = `${target.dir}/${skill}/SKILL.md`;

      // Check if target already has this content (idempotency)
      let action: 'write' | 'skip' = 'write';
      try {
        const existing = await readFile(targetPath);
        if (existing === content) {
          action = 'skip';
        }
      } catch {
        // File doesn't exist — will be a write
      }

      operations.push({ targetPath, content, action });
    }
  }

  return operations;
}
