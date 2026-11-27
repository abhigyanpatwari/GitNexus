import path from 'node:path';

/** Resolve Git independently of the fixture directory's executable search path. */
export function fixtureGitExecutable(): string {
  const executable =
    process.env.GIT_EXECUTABLE ??
    (process.platform === 'win32'
      ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'cmd', 'git.exe')
      : '/usr/bin/git');
  if (!path.isAbsolute(executable)) throw new Error('GIT_EXECUTABLE must be an absolute path');
  return executable;
}
