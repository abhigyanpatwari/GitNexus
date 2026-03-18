import path from 'path';

export type SkillLayout = 'github' | 'claude' | 'dual';

export const DEFAULT_SKILL_LAYOUT: SkillLayout = 'claude';

export function normalizeSkillLayout(layout?: SkillLayout): SkillLayout {
  return layout ?? DEFAULT_SKILL_LAYOUT;
}

export function parseSkillLayout(value: string): SkillLayout {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'github' || normalized === 'claude' || normalized === 'dual') {
    return normalized;
  }

  throw new Error(
    `Invalid --skill-layout "${value}". Expected one of: github, claude, dual.`
  );
}

function getRelativeSkillRoots(layout: SkillLayout): string[] {
  if (layout === 'dual') {
    return ['.github/skills', '.claude/skills'];
  }

  return [layout === 'github' ? '.github/skills' : '.claude/skills'];
}

export function getAbsoluteSkillRoots(repoPath: string, layout?: SkillLayout): string[] {
  return getRelativeSkillRoots(normalizeSkillLayout(layout)).map((root) =>
    path.join(repoPath, ...root.split('/'))
  );
}

export function getRelativeGeneratedSkillDirs(layout?: SkillLayout): string[] {
  return getRelativeSkillRoots(normalizeSkillLayout(layout)).map((root) => `${root}/generated`);
}

export function getAbsoluteGeneratedSkillDirs(repoPath: string, layout?: SkillLayout): string[] {
  return getAbsoluteSkillRoots(repoPath, layout).map((root) => path.join(root, 'generated'));
}

export function getRelativeCoreSkillDirs(layout?: SkillLayout): string[] {
  return getRelativeSkillRoots(normalizeSkillLayout(layout)).map((root) => `${root}/gitnexus`);
}

export function getAbsoluteCoreSkillDirs(repoPath: string, layout?: SkillLayout): string[] {
  return getAbsoluteSkillRoots(repoPath, layout).map((root) => path.join(root, 'gitnexus'));
}
