/**
 * Metadata for one repo-specific skill file generated from a detected
 * community.
 *
 * Produced by `skill-gen`'s `generateSkillFiles` and consumed by `ai-context`
 * when it lists the generated skills in AGENTS.md / CLAUDE.md. It lives in this
 * leaf module rather than in either of those so the consumer does not have to
 * import the producer for a type — `ai-context` already supplies the
 * `.agents/` mirror check that `skill-gen` calls, and the two directions
 * together made an import cycle.
 */
export interface GeneratedSkillInfo {
  name: string;
  label: string;
  symbolCount: number;
  fileCount: number;
}
