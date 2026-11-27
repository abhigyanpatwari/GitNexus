const path = require('node:path');

// Both CI entrypoints must use the runner's system Git regardless of cwd or PATH.
const gitExecutable =
  process.platform === 'win32'
    ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'cmd', 'git.exe')
    : '/usr/bin/git';
if (!path.isAbsolute(gitExecutable)) throw new Error('Expected an absolute path to system Git');

module.exports = { gitExecutable };
